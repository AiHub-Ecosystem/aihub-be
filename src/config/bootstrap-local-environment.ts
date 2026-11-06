import { loadLocalEnvironment } from './load-local-environment';

// The entrypoint imports this before telemetry and application modules read
// their environment. The call lives here, not in `load-local-environment.ts`,
// so importing that module (a spec, for one) never loads a `.env` into the
// process (#1632).
loadLocalEnvironment();
