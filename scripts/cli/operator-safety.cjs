/** @typedef {'production' | 'sandbox' | 'test' | 'unknown'} OperatorDeployment */
/** @typedef {'process' | 'database'} MaintenanceClockSource */
/** @typedef {{ now: Date; source: MaintenanceClockSource }} MaintenanceClock */
/** @typedef {{ command: string; action: string; target?: string }} OperatorMutationPreview */

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
  if (targetOption === 'url' && target !== undefined) {
    const safeUrl = new URL(target);
    safeUrl.username = '';
    safeUrl.password = '';
    safeUrl.search = '';
    safeUrl.hash = '';
    return { command, action, target: safeUrl.href };
  }
  return {
    command,
    action,
    ...(target === undefined ? {} : { target }),
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
  requireTargetConfirmation,
};
