/** @typedef {'production' | 'sandbox' | 'test' | 'unknown'} OperatorDeployment */
/** @typedef {'process' | 'database'} MaintenanceClockSource */
/** @typedef {{ now: Date; source: MaintenanceClockSource }} MaintenanceClock */
/** @typedef {{ command: string; action: string; inputs: Record<string, string>; target?: string }} OperatorMutationPreview */

/** @type {ReadonlyMap<string, OperatorDeployment>} */
const DEPLOYMENT_BY_DATABASE = new Map([
  ['aihub', 'production'],
  ['aihub_sandbox', 'sandbox'],
  ['aihub_db_lane', 'test'],
  ['aihub_sandbox_db_lane', 'test'],
  ['aihub_tenant_isolation_lane', 'test'],
]);

/** @type {Readonly<Record<string, readonly [string, (string | undefined)?]>>} */
const MUTATION_ACTIONS = {
  'org:create': ['create an organization', 'name'],
  'key:create': ['create an API key', 'org'],
  'key:revoke': ['revoke an API key', 'key'],
  'identity:set': ['replace an organization identity configuration', 'org'],
  'idempotency:cleanup': ['delete expired idempotency records'],
  'quota:reconcile': ['reconcile quota counters', 'month'],
  'org:suspend': ['suspend an organization', 'org'],
  'org:restore': ['restore an organization', 'org'],
  'org:grant-entitlement': ['grant an organization entitlement', 'org'],
  'org:attach-owner': ['attach the first organization owner', 'org'],
  'avatar:sweep': ['delete eligible orphaned avatar objects'],
  'speaking:audio-upload-sweep': ['delete eligible speaking audio objects'],
  'registrations:sweep': ['expire unverified registrations'],
  'notifications:sweep': ['create notifications for expiring API keys'],
  'writing:chart-upload-sweep': ['delete eligible writing chart objects'],
  'writing:chart-revoke': ['revoke a published writing chart', 'url'],
  'usage:prune': ['delete usage and dispatch evidence past retention'],
  'billing:adjust': ['record a billing adjustment', 'id'],
  'billing:statement': ['close a billing month', 'month'],
};
/** @type {Readonly<Record<string, readonly string[]>>} */
const MUTATION_PREVIEW_OPTIONS = {
  'org:create': [
    'name',
    'entitlements',
    'rate-limit-rpm',
    'max-concurrent',
    'monthly-quota',
    'hard-stop',
  ],
  'key:create': ['org', 'name', 'scopes', 'envs', 'internal', 'actor'],
  'key:revoke': ['key', 'actor'],
  'identity:set': [
    'org',
    'issuer',
    'jwks-url',
    'allowed-algorithms',
    'max-assertion-ttl-seconds',
    'status',
  ],
  'idempotency:cleanup': [],
  'quota:reconcile': ['month'],
  'org:suspend': ['org', 'actor'],
  'org:restore': ['org', 'actor'],
  'org:grant-entitlement': ['org', 'entitlement', 'actor'],
  'org:attach-owner': ['org', 'owner', 'actor'],
  'avatar:sweep': [],
  'speaking:audio-upload-sweep': [],
  'registrations:sweep': [],
  'notifications:sweep': [],
  'writing:chart-upload-sweep': [],
  'writing:chart-revoke': ['url', 'actor'],
  'usage:prune': [],
  'billing:adjust': [
    'id',
    'org',
    'month',
    'operation',
    'requests',
    'request-ids',
    'period-from',
    'period-to',
    'actor',
  ],
  'billing:statement': ['month', 'org', 'close', 'actor'],
};
const MUTATING_COMMANDS = new Set(Object.keys(MUTATION_ACTIONS));
const CONTROL_PLANE_COMMANDS = new Set([
  'org:create',
  'key:create',
  'key:revoke',
  'identity:set',
  'org:suspend',
  'org:restore',
  'org:grant-entitlement',
  'org:attach-owner',
]);
const NATIVE_DRY_RUN_COMMANDS = new Set([
  'avatar:sweep',
  'speaking:audio-upload-sweep',
  'writing:chart-upload-sweep',
  'usage:prune',
  'quota:reconcile',
]);

/** @param {string | undefined} command @param {ReadonlyMap<string, string>} options @returns {boolean} */
function isMutatingCommand(command, options) {
  return (
    MUTATING_COMMANDS.has(command) &&
    (command !== 'billing:statement' ||
      options.get('close')?.trim().toLowerCase() === 'true')
  );
}

/** @param {string} databaseName @returns {OperatorDeployment} */
function classifyDatabase(databaseName) {
  return DEPLOYMENT_BY_DATABASE.get(databaseName) ?? 'unknown';
}

/** @param {OperatorDeployment} deployment @param {string | undefined} requestedTarget */
function requireTargetConfirmation(deployment, requestedTarget) {
  if (deployment === 'unknown') {
    throw new Error(
      'database deployment cannot be identified; refusing mutation',
    );
  }
  if (
    requestedTarget !== undefined &&
    requestedTarget !== 'production' &&
    requestedTarget !== 'sandbox'
  ) {
    throw new Error('--target must be production or sandbox');
  }
  if (requestedTarget !== undefined && requestedTarget !== deployment) {
    throw new Error(`database target is ${deployment}, not ${requestedTarget}`);
  }
  if (deployment === 'production' && requestedTarget !== 'production') {
    throw new Error('production writes require --target production');
  }
}

/** @param {OperatorDeployment} deployment @param {string} runtimeScope */
function requireStorageDeployment(deployment, runtimeScope) {
  if (
    (deployment !== 'production' && deployment !== 'sandbox') ||
    runtimeScope !== deployment
  ) {
    throw new Error(
      `object storage scope ${runtimeScope} is incompatible with database deployment ${deployment}`,
    );
  }
}

/** @param {OperatorDeployment} deployment */
function requireControlPlaneDatabase(deployment) {
  if (deployment !== 'production' && deployment !== 'test') {
    throw new Error(
      'control-plane commands require the Production control-plane database',
    );
  }
}

/** @param {Date} processNow @param {Date} databaseNow @returns {MaintenanceClock} */
function effectiveMaintenanceTime(processNow, databaseNow) {
  const processTime = processNow.getTime();
  const databaseTime = databaseNow.getTime();
  if (!Number.isFinite(processTime) || !Number.isFinite(databaseTime)) {
    throw new Error('maintenance clock is invalid');
  }
  return processTime <= databaseTime
    ? { now: processNow, source: 'process' }
    : { now: databaseNow, source: 'database' };
}

/** @param {string} command @param {ReadonlyMap<string, string>} options @returns {OperatorMutationPreview} */
function previewOperatorMutation(command, options) {
  if (!isMutatingCommand(command, options)) {
    throw new Error('command is not a mutating operator command');
  }
  const description = MUTATION_ACTIONS[command];
  if (description === undefined) {
    throw new Error('command is not a mutating operator command');
  }
  const [action, targetOption] = description;
  const target =
    targetOption === undefined ? undefined : options.get(targetOption);
  if (targetOption !== undefined && !target?.trim()) {
    throw new Error(`operator preview requires --${targetOption}`);
  }
  /** @param {string} name @param {string} value */
  const safeValue = (name, value) => {
    if (name !== 'url' && name !== 'issuer' && name !== 'jwks-url') {
      return value;
    }
    const safeUrl = new URL(value);
    safeUrl.username = '';
    safeUrl.password = '';
    safeUrl.search = '';
    safeUrl.hash = '';
    return safeUrl.href;
  };
  const inputs = Object.fromEntries(
    MUTATION_PREVIEW_OPTIONS[command]
      .filter((name) => options.has(name))
      .map((name) => [name, safeValue(name, options.get(name))]),
  );
  if (command === 'identity:set') {
    inputs['key-source'] = options.has('public-keys-file')
      ? 'inline'
      : options.has('jwks-url')
        ? 'url'
        : 'existing';
  }
  if (command === 'billing:adjust' && options.has('reason')) {
    inputs.reason_supplied = 'true';
  }
  return {
    command,
    action,
    inputs,
    ...(target === undefined
      ? {}
      : { target: safeValue(targetOption ?? '', target) }),
  };
}

module.exports = {
  CONTROL_PLANE_COMMANDS,
  MUTATING_COMMANDS,
  NATIVE_DRY_RUN_COMMANDS,
  classifyDatabase,
  effectiveMaintenanceTime,
  isMutatingCommand,
  previewOperatorMutation,
  requireControlPlaneDatabase,
  requireStorageDeployment,
  requireTargetConfirmation,
};
