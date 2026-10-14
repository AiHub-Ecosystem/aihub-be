export function createAppFastifyProxyOptions(trustedProxyIp: string) {
  return { trustProxy: trustedProxyIp } as const;
}
