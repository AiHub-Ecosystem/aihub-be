# ADR-0177: Sanitize and bound AI Service grading responses

- Status: Accepted by the AIHUB owner on 2026-11-20
- Date: 2026-11-20
- Amends: [ADR-0143](0143-public-v2-serves-ai-writing-v3-grading.md) decisions 1 and 2; [ADR-0172](0172-writing-priority-errors-in-v2-grading.md)
- Related: [#377](https://github.com/AiHub-Ecosystem/aihub-be/issues/377)

## Context

Issue #377 bounds AI Service response bodies and model-generated text before AIHUB publishes or stores grading results. The original Writing v3 decision preserved provider strings verbatim, and ADR-0172 carried that rule to provider-ranked error priorities. Unbounded text and invisible direction controls can consume excessive resources or make feedback display differently from its stored order.

## Decision

The gateway reads each AI Service response only up to its configured byte limit. An oversized body is a contract violation. A response interrupted during transport keeps its transport-failure classification and is not reclassified as a contract violation.

Before adapting a grading response, AIHUB removes C0 and C1 control characters except tab, line feed, and carriage return, and removes all Unicode Bidi_Control characters from string values and object keys. If key normalization creates a collision, the response is refused. Remaining text and provider ordering pass through unchanged.

Published model text follows the contract limits: 4,000 UTF-16 code units for ModelText and 20,000 for ModelQuote. Both data_micro key levels use the 4,000-unit limit. The same value and key bounds apply when decoding stored idempotency results. A legacy completed Writing v2 result may still omit error_priority, but that field's absence does not waive the other response bounds.

## Consequences

A stored result that exceeds the current contract is refused as malformed instead of being replayed to a caller. Fresh and stored Writing v2 results share the same text and data_micro key limits, while valid pre-0172 results keep their missing error_priority field on replay.
