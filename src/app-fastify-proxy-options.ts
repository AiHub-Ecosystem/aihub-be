/**
 * Trust only the connection's own peer, whatever its address.
 *
 * A Unix-socket peer has no address, so an IP pin can never match it, and
 * `true` or a hop count makes Fastify drop the connection. A function that
 * trusts every hop is worse: it resolves the caller to the leftmost forwarded
 * entry, which the client writes. Hop 0 is the socket peer itself, so the
 * result is the rightmost entry, the one the reverse proxy appended.
 *
 * Only safe when nothing but the reverse proxy can reach a listener; the app
 * keeps its TCP listener on loopback inside the container in that mode.
 */
function trustSocketPeerOnly(_address: string, hop: number): boolean {
  return hop === 0;
}

export function createAppFastifyProxyOptions(
  trustedProxyIp: string,
  listenSocket?: string,
) {
  return {
    trustProxy:
      listenSocket === undefined ? trustedProxyIp : trustSocketPeerOnly,
  } as const;
}
