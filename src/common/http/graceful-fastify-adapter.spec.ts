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
});
