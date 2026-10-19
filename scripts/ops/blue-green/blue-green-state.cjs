'use strict';

const SLOT_PORTS = Object.freeze({
  production: Object.freeze({ a: 3021, b: 3023 }),
  sandbox: Object.freeze({ a: 3022, b: 3024 }),
});

const TEMPLATE_PORTS = Object.freeze({ production: 3021, sandbox: 3022 });

function portsInConfig(config) {
  return Array.from(
    config.matchAll(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)\s*;/g),
    (match) => Number(match[1]),
  );
}

function slotForPort(tier, port) {
  const slots = SLOT_PORTS[tier];
  if (!slots) throw new Error(`unknown deployment tier: ${tier}`);
  const entry = Object.entries(slots).find(([, value]) => value === port);
  if (!entry) throw new Error(`unsupported ${tier} upstream port: ${port}`);
  return entry[0];
}

function activeSlot(config, tier) {
  const ports = portsInConfig(config);
  const uniquePorts = [...new Set(ports)];
  if (uniquePorts.length !== 1) {
    throw new Error(`${tier} nginx config must have one active upstream port`);
  }
  return slotForPort(tier, uniquePorts[0]);
}

function renderNginxConfig(template, tier, slot) {
  const defaultPort = TEMPLATE_PORTS[tier];
  const targetPort = SLOT_PORTS[tier]?.[slot];
  if (targetPort === undefined)
    throw new Error(`unknown ${tier} slot: ${slot}`);

  const ports = portsInConfig(template);
  if (ports.length === 0 || ports.some((port) => port !== defaultPort)) {
    throw new Error(`${tier} nginx template does not match its slot-A port`);
  }

  return template.replace(
    /proxy_pass(\s+)http:\/\/127\.0\.0\.1:\d+(\s*;)/g,
    `proxy_pass$1http://127.0.0.1:${targetPort}$2`,
  );
}

function renderNginxPair({
  apiTemplate,
  sandboxTemplate,
  currentApi,
  currentSandbox,
  tier,
  nextSlot,
  sandboxEnabled,
}) {
  const apiSlot = activeSlot(currentApi, 'production');
  const sandboxSlot = sandboxEnabled
    ? activeSlot(currentSandbox, 'sandbox')
    : 'a';
  const targetApiSlot = tier === 'production' ? nextSlot : apiSlot;
  const targetSandboxSlot = tier === 'sandbox' ? nextSlot : sandboxSlot;

  return {
    api: renderNginxConfig(apiTemplate, 'production', targetApiSlot),
    sandbox: sandboxEnabled
      ? renderNginxConfig(sandboxTemplate, 'sandbox', targetSandboxSlot)
      : undefined,
  };
}

module.exports = {
  SLOT_PORTS,
  activeSlot,
  portsInConfig,
  renderNginxConfig,
  renderNginxPair,
  slotForPort,
};
