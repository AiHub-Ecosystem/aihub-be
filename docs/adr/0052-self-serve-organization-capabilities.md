# Self-serve Organizations receive all current capabilities

Status: accepted

Date: 2026-09-25

ADR-0041 originally limited self-serve Organizations to the `writing` entitlement while commercial terms for other capabilities were unsettled. AIHUB now offers Speaking through the same self-serve API-key flow, so every newly created Organization starts with all currently available capability entitlements: `writing` and `speaking`. The caller still cannot choose or alter entitlements in the create request.

This changes capability access only. The self-serve defaults remain 100 requests per month with a hard stop, 60 requests per minute, and 5 concurrent requests. Existing Organizations keep their current entitlements; an operator must grant `speaking` to enable it for them.

When AIHUB adds a new customer-facing capability, its entitlement must be added to the self-serve defaults as part of enabling that capability for new Organizations. Commercial usage limits remain operator-controlled.
