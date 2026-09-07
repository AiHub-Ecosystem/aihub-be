---
paths:
  - "src/**"
  - "test/**"
---

# Security rules

- Never log or return API keys, key hashes, user assertions, internal JWTs, essay text, raw request bodies, or raw downstream bodies.
- Hash API keys before persistence and compare hashes in the identity boundary; do not store recoverable credentials.
- Enforce organization and scope checks before dispatching a downstream operation.
- Keep host selection in trusted configuration; never accept a client-controlled downstream URL.
- Preserve error distinctions such as `AI_SERVICE_ERROR` and `AI_SERVICE_CONTRACT_VIOLATION`; do not turn a contract failure into a retry loop.
