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
  it('lets tracked background work settle before Nest runs module destroy hooks', async () => {
    const { Module } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { GracefulFastifyAdapter } = await import(
      './graceful-fastify-adapter'
    );
    const { backgroundWorkStarted, backgroundWorkSettled } = await import(
      '@/common/background-work-tracker'
    );
    const events: string[] = [];

    class RedisBackedAdapter {
      onModuleDestroy(): void {
        events.push('module destroyed');
      }
    }
    @Module({ providers: [RedisBackedAdapter] })
    class ShutdownOrderModule {}

    const app = await NestFactory.create(
      ShutdownOrderModule,
      new GracefulFastifyAdapter(),
      { logger: false },
    );
    await app.init();
    backgroundWorkStarted();
    setTimeout(() => {
      events.push('background work settled');
      backgroundWorkSettled();
    }, 50);

    await app.close();

    expect(events).toEqual(['background work settled', 'module destroyed']);
  });
});
