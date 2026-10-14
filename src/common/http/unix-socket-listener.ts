import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';

import type { FastifyInstance } from 'fastify';

// Owner and group only. The socket directory's group decides who else reaches
// it; "other" never connects.
const SOCKET_MODE = 0o660;

/**
 * Serves the Fastify instance on a Unix socket in addition to its TCP listener.
 *
 * Fastify binds one handle, so a second `http.Server` shares its router. The
 * close hook has to be registered before the instance listens, so this returns
 * the function that opens the socket once routes exist.
 */
export function prepareSocketListener(
  fastify: FastifyInstance,
  socketPath: string,
): () => Promise<void> {
  const server = createServer((request, response) => {
    fastify.routing(request, response);
  });

  fastify.addHook('onClose', (_instance, done) => {
    server.close(() => done());
    server.closeIdleConnections();
  });

  return async () => {
    // A crashed process leaves its socket file behind, and listening on an
    // existing path fails with EADDRINUSE.
    if (process.platform !== 'win32') {
      const existing = await lstat(socketPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      if (existing && !existing.isSocket()) {
        throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
      }
      if (existing) await unlink(socketPath);
    }
    // Match the TCP listener, so a keep-alive proxy and a slow request see the
    // same limits on either transport.
    server.keepAliveTimeout = fastify.server.keepAliveTimeout;
    server.headersTimeout = fastify.server.headersTimeout;
    server.requestTimeout = fastify.server.requestTimeout;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    // Named pipes on Windows have no file mode.
    if (process.platform !== 'win32') {
      await chmod(socketPath, SOCKET_MODE);
    }
  };
}
