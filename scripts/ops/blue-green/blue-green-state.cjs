'use strict';

const SLOT_PORTS = Object.freeze({
  production: Object.freeze({ a: 3021, b: 3023 }),
  sandbox: Object.freeze({ a: 3022, b: 3024 }),
});

const TEMPLATE_PORTS = Object.freeze({ production: 3021, sandbox: 3022 });

/** @typedef {'production' | 'sandbox'} Tier */
/** @typedef {'a' | 'b'} Slot */

/** @param {string} config @returns {number[]} */
function portsInConfig(config) {
  return Array.from(
    config.matchAll(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)\s*;/g),
    (match) => Number(match[1]),
  );
}

/** @param {Tier} tier @param {number} port @returns {Slot} */
function slotForPort(tier, port) {
  const slots = SLOT_PORTS[tier];
  if (!slots) throw new Error(`unknown deployment tier: ${tier}`);
  if (slots.a === port) return 'a';
  if (slots.b === port) return 'b';
  throw new Error(`unsupported ${tier} upstream port: ${port}`);
}

/** @param {string} config @param {Tier} tier @returns {Slot} */
function activeSlot(config, tier) {
  const ports = portsInConfig(config);
  const uniquePorts = [...new Set(ports)];
  if (uniquePorts.length !== 1) {
    throw new Error(`${tier} nginx config must have one active upstream port`);
  }
  return slotForPort(tier, uniquePorts[0]);
}

/** @param {string} template @param {Tier} tier @param {Slot} slot @returns {string} */
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

/** @param {{apiTemplate: string, sandboxTemplate: string, currentApi: string, currentSandbox: string, tier: Tier, nextSlot: Slot, sandboxEnabled: boolean}} options */
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
