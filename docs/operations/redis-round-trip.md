# Redis round trip and command timeouts

The application reaches its Redis on another machine, so every Redis command
costs a network round trip before Redis does any work. A client whose command
timeout is close to that round trip fails whenever the network is a little
slow, and each of AIHUB's Redis clients treats a failed command as "Redis is
unavailable": the email send-rate limiter stops sending, and the request-path
protection seams skip their shared state. That is what stopped every email in
production on 2026-10-23 (#902, #1008). This page records the round trip and the
margin every client's timeout keeps over it (#1011).

## Which client uses which Redis

| Redis (by setting)                | Used by                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `REDIS_URL`                       | Authentication rate limiter, identity store (shared JWKS cache), gateway client (concurrency, graded admission, Organization retry budget) |
| `AIHUB_EMAIL_SEND_RATE_REDIS_URL` | Email send-rate limiter and provider-outage state, shared by every environment                                                             |

Both settings point at the same Redis host, in different databases.

## Measured round trip

Measured 2026-10-23 at 09:38 UTC from inside the running application
containers, 30 reads of an unused key per setting:

| Container  | Setting                           | Min   | Median | p95    | Max    |
| ---------- | --------------------------------- | ----- | ------ | ------ | ------ |
| Production | `REDIS_URL`                       | 91 ms | 100 ms | 108 ms | 200 ms |
| Production | `AIHUB_EMAIL_SEND_RATE_REDIS_URL` | 96 ms | 100 ms | 104 ms | 104 ms |
| Sandbox    | `REDIS_URL`                       | 88 ms | 100 ms | 107 ms | 110 ms |
| Sandbox    | `AIHUB_EMAIL_SEND_RATE_REDIS_URL` | 93 ms | 100 ms | 102 ms | 107 ms |

## The margin

A client's command timeout is **at least three times the round trip, measured
as the p95, rounded up to the next 100 ms**. With a p95 of 108 ms that is
**400 ms**. Three times leaves room for the round trip to double without a
command failing; the p95 rather than the median keeps ordinary jitter, like the
200 ms read above, inside it.

| Client                      | Command timeout | Meets 400 ms | Tracked |
| --------------------------- | --------------- | ------------ | ------- |
| Email send-rate limiter     | 500 ms          | yes          | #1008   |
| Authentication rate limiter | 400 ms          | yes          | #1012   |
| Identity store              | 400 ms          | yes          | #1013   |
| Gateway client              | 400 ms          | yes          | #1014   |

## Measuring again

Measure again when Redis or the application moves to another host or network,
and update this page and any timeout the new margin no longer covers. The
measurement only reads, and prints the setting name and timings, never a URL or
a password. Run it inside each application container over stdin, through the
runtime connection loader that gives the process its settings:

```js
// node --input-type=module - inside the container, with the working directory /app
import { createRequire } from "node:module";
const require = createRequire("/app/");
const loader =
  await import("/app/dist/modules/secrets/infrastructure/runtime-connection.environment.js");
(
  loader.loadRuntimeConnectionEnvironment ??
  loader.default?.loadRuntimeConnectionEnvironment
)({ env: process.env });
const Redis = require("ioredis");
for (const name of ["REDIS_URL", "AIHUB_EMAIL_SEND_RATE_REDIS_URL"]) {
  const client = new Redis(process.env[name], {
    lazyConnect: true,
    commandTimeout: 3000,
  });
  client.on("error", () => {});
  await client.connect();
  const timings = [];
  for (let i = 0; i < 30; i += 1) {
    const started = process.hrtime.bigint();
    try {
      await client.get("aihub:round-trip-probe-none");
    } catch {}
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  client.disconnect();
  timings.sort((a, b) => a - b);
  console.log(
    name,
    "median",
    timings[15].toFixed(0),
    "p95",
    timings[28].toFixed(0),
    "max",
    timings[29].toFixed(0)
  );
}
```

A read refused by the user's access list still costs one round trip, so the
email limiter's restricted user can be measured the same way.
