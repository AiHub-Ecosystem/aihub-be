const BUDGET_FIELDS = [
  'max_connections',
  'max_connections_evidence',
  'max_connections_measured_at',
  'reserved_slots',
  'reserved_slots_evidence',
  'reserved_slots_measured_at',
  'operational_headroom',
  'headroom_approved_by',
  'headroom_evidence',
  'headroom_approved_at',
  'max_client_conn',
  'admin_password',
  'stats_password',
  'direct_clients',
  'databases',
];

const DATABASE_FIELDS = [
  'host',
  'port',
  'database',
  'max_db_connections',
  'max_db_client_connections',
  'client_pool_max',
  'max_process_overlap',
  'approved_by',
  'evidence',
  'approved_at',
  'users',
];

const APPROVAL_FIELDS = ['approved_by', 'evidence', 'approved_at'];

/** @param {unknown} value @returns {asserts value is Record<string, unknown>} */
export function validatePgBouncerBundle(value) {
  requireFields(value, BUDGET_FIELDS);
  requirePositiveInteger(value.max_connections);
  if (value.max_connections !== 100) {
    throw new Error(
      'max_connections must remain 100 until separately approved',
    );
  }
  requireEvidence(value.max_connections_evidence);
  requireDate(value.max_connections_measured_at);
  requireNonNegativeInteger(value.reserved_slots);
  requireEvidence(value.reserved_slots_evidence);
  requireDate(value.reserved_slots_measured_at);
  requireNonNegativeInteger(value.operational_headroom);
  requireApproval(
    value,
    'headroom_approved_by',
    'headroom_evidence',
    'headroom_approved_at',
  );
  requirePositiveInteger(value.max_client_conn);
  requirePassword(value.admin_password);
  requirePassword(value.stats_password);
  if (
    value.admin_password === value.stats_password ||
    !isRecordArray(value.direct_clients) ||
    value.direct_clients.length === 0 ||
    !isRecord(value.databases)
  ) {
    throw new Error('pooler budget lists are invalid');
  }

  let directConnections = 0;
  const directClientNames = new Set();
  for (const client of value.direct_clients) {
    requireFields(client, [
      'name',
      'pool_max',
      'process_overlap',
      ...APPROVAL_FIELDS,
    ]);
    requireIdentifier(client.name);
    if (directClientNames.has(client.name)) {
      throw new Error('direct client budget names must be unique');
    }
    directClientNames.add(client.name);
    requirePositiveInteger(client.pool_max);
    requirePositiveInteger(client.process_overlap);
    requireApproval(client, 'approved_by', 'evidence', 'approved_at');
    directConnections += client.pool_max * client.process_overlap;
  }

  const databaseEntries = Object.entries(value.databases);
  if (databaseEntries.length < 4) {
    throw new Error('four or more approved database aliases are required');
  }

  let backendConnections = 0;
  let clientConnections = 0;
  const usernames = new Set([
    'aihub_pgbouncer_admin',
    'aihub_pgbouncer_metrics',
  ]);
  for (const [alias, database] of databaseEntries) {
    requireIdentifier(alias);
    requireFields(database, DATABASE_FIELDS);
    requireAddress(database.host);
    requirePositiveInteger(database.port);
    if (database.port > 65_535) throw new Error('database port is invalid');
    requireIdentifier(database.database);
    requirePositiveInteger(database.max_db_connections);
    requirePositiveInteger(database.max_db_client_connections);
    if (database.max_db_client_connections < database.max_db_connections) {
      throw new Error('alias client cap cannot be lower than its backend cap');
    }
    requirePositiveInteger(database.client_pool_max);
    requirePositiveInteger(database.max_process_overlap);
    requireApproval(database, 'approved_by', 'evidence', 'approved_at');
    if (
      database.max_db_client_connections !==
      database.client_pool_max * database.max_process_overlap
    ) {
      throw new Error(
        'alias client cap must equal its approved application overlap',
      );
    }
    if (!isRecordArray(database.users) || database.users.length === 0) {
      throw new Error('each database alias requires an application credential');
    }
    for (const user of database.users) {
      requireFields(user, ['username', 'password']);
      requireIdentifier(user.username);
      requirePassword(user.password);
      if (usernames.has(user.username)) {
        throw new Error('database aliases must use separate credentials');
      }
      usernames.add(user.username);
    }
    backendConnections += database.max_db_connections;
    clientConnections += database.max_db_client_connections;
  }

  if (clientConnections + 2 !== value.max_client_conn) {
    throw new Error(
      'max_client_conn must cover approved aliases plus admin and metrics',
    );
  }
  if (
    backendConnections + directConnections + value.operational_headroom >
    value.max_connections - value.reserved_slots
  ) {
    throw new Error(
      'backend, direct, and headroom caps exceed PostgreSQL capacity',
    );
  }
}

/** @param {unknown} value @param {string[]} keys @returns {asserts value is Record<string, unknown>} */
function requireFields(value, keys) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error('pooler budget bundle schema is invalid');
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is Record<string, unknown>[]} */
function isRecordArray(value) {
  return Array.isArray(value) && value.every(isRecord);
}

/** @param {unknown} value @returns {asserts value is number} */
function requirePositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('pooler budget integer is invalid');
  }
}

/** @param {unknown} value @returns {asserts value is number} */
function requireNonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('pooler budget integer is invalid');
  }
}

/** @param {unknown} value @returns {asserts value is string} */
function requireIdentifier(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/.test(value) ||
    value === 'pgbouncer'
  ) {
    throw new Error('pooler database identifier is invalid');
  }
}

/** @param {unknown} value @returns {asserts value is string} */
function requireAddress(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(value)
  ) {
    throw new Error('pooler database host is invalid');
  }
}

/** @param {unknown} value @returns {asserts value is string} */
function requirePassword(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('pooler credential is invalid');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new Error('pooler credential is invalid');
    }
  }
}

/** @param {unknown} value @returns {asserts value is string} */
function requireEvidence(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('capacity evidence is required');
  }
}

/** @param {unknown} value @returns {asserts value is string} */
function requireDate(value) {
  const date =
    typeof value === 'string' ? new Date(`${value}T00:00:00Z`) : undefined;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    date === undefined ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error('capacity approval date is invalid');
  }
}

/** @param {Record<string, unknown>} record @param {string} owner @param {string} evidence @param {string} date */
function requireApproval(record, owner, evidence, date) {
  requireEvidence(record[owner]);
  requireEvidence(record[evidence]);
  requireDate(record[date]);
}
