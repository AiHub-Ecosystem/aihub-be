import { once } from 'node:events';
import { type Server, type Socket, connect, createServer } from 'node:net';

/**
 * What the proxy does to traffic between the application and a dependency:
 * - `normal` forwards every byte.
 * - `refuse` closes open connections and stops listening, so a new connection
 *   is refused like a stopped dependency.
 * - `slow` forwards every chunk after `slowMs`, keeping byte order.
 * - `hang` keeps connections open and holds every byte, like a stalled
 *   dependency on a live TCP connection. Held bytes are delivered in order
 *   when the hang ends, because TCP never drops them.
 */
export type FaultMode = 'normal' | 'refuse' | 'slow' | 'hang';

interface Pair {
  readonly client: Socket;
  readonly upstream: Socket;
}

export class TcpFaultProxy {
  private readonly pairs = new Set<Pair>();
  private held: { readonly destination: Socket; readonly data: Buffer }[] = [];
  private mode: FaultMode = 'normal';
  private server: Server | undefined;
  private port = 0;
  private closedClients = 0;

  constructor(
    private readonly target: { readonly host: string; readonly port: number },
    private readonly slowMs = 400,
  ) {}

  async listen(): Promise<number> {
    await this.bind(0);
    return this.port;
  }

  /** Client connections the proxy has seen close, for cancellation checks. */
  closedClientCount(): number {
    return this.closedClients;
  }

  openConnectionCount(): number {
    return this.pairs.size;
  }

  async setMode(mode: FaultMode): Promise<void> {
    const previous = this.mode;
    this.mode = mode;
    if (previous === 'hang' && mode !== 'hang') {
      const held = this.held;
      this.held = [];
      for (const { destination, data } of held) {
        if (!destination.destroyed) destination.write(data);
      }
    }
    if (mode === 'refuse') {
      this.destroyPairs();
      await this.unbind();
    } else if (previous === 'refuse') {
      await this.bind(this.port);
    }
  }

  async close(): Promise<void> {
    this.mode = 'refuse';
    this.destroyPairs();
    await this.unbind();
  }

  private async bind(port: number): Promise<void> {
    const server = createServer((client) => this.accept(client));
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Fault proxy did not bind a TCP port');
    }
    this.port = address.port;
    this.server = server;
  }

  private async unbind(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    server.close();
    await once(server, 'close');
  }

  private accept(client: Socket): void {
    if (this.mode === 'refuse') {
      client.destroy();
      return;
    }
    const upstream = connect(this.target);
    const pair = { client, upstream };
    this.pairs.add(pair);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      this.closedClients += 1;
      this.pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
    client.on('data', (data) => this.forward(upstream, data));
    upstream.on('data', (data) => this.forward(client, data));
  }

  private forward(destination: Socket, data: Buffer): void {
    if (this.mode === 'hang') {
      this.held.push({ destination, data });
      return;
    }
    const write = (): void => {
      if (!destination.destroyed) destination.write(data);
    };
    if (this.mode === 'slow') setTimeout(write, this.slowMs);
    else write();
  }

  private destroyPairs(): void {
    for (const pair of this.pairs) {
      pair.client.destroy();
      pair.upstream.destroy();
    }
  }
}
