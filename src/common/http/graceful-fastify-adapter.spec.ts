describe('GracefulFastifyAdapter', () => {
  it('marks shutdown as begun before it closes the server', async () => {
    const { GracefulFastifyAdapter } = await import(
      './graceful-fastify-adapter'
    );
    const { isShuttingDown } = await import('./background-work-drain');
    const seenWhileClosing: boolean[] = [];
    const adapter = new GracefulFastifyAdapter(undefined, async () => {
      seenWhileClosing.push(isShuttingDown());
    });
    adapter.getInstance().addHook('onClose', async () => {
      seenWhileClosing.push(isShuttingDown());
    });

    expect(isShuttingDown()).toBe(false);
    await Promise.resolve(adapter.beforeClose());

    // Set before the server closes, so the drain that follows waits for work
    // that is ending and not for loops that keep starting more.
    expect(seenWhileClosing).toEqual([true, true]);
  });

  // A Redis adapter quits its client in onModuleDestroy, so background cleanup
  // that still needs that client (#1003) must settle before destroy hooks run.
  it('keeps a client that onModuleDestroy closes usable by background work still running at shutdown', async () => {
    const { Module } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { GracefulFastifyAdapter } = await import(
      './graceful-fastify-adapter'
    );
    const { backgroundWorkStarted, backgroundWorkSettled } = await import(
      '@/common/background-work-tracker'
    );
    const redis = { open: true };

    class RedisBackedAdapter {
      onModuleDestroy(): void {
        redis.open = false;
      }
    }
    @Module({ providers: [RedisBackedAdapter] })
    class ShutdownOrderModule {}

    const adapter = new GracefulFastifyAdapter();
    // Cleanup starts only once close() has begun, so it is pending at the drain.
    const cleanupSawOpenClient = new Promise<boolean>((resolve) => {
      adapter.getInstance().addHook('preClose', (done) => {
        // Without the drain, close() reaches onModuleDestroy within this delay.
        setTimeout(() => {
          resolve(redis.open);
          backgroundWorkSettled();
        }, 50);
        done();
      });
    });
    const app = await NestFactory.create(ShutdownOrderModule, adapter, {
      logger: false,
    });
    await app.init();
    backgroundWorkStarted();

    await app.close();

    // real-timer-ok: only elapsed time shows the drain held close() open
    await expect(cleanupSawOpenClient).resolves.toBe(true);
    expect(redis.open).toBe(false);
  });
});
