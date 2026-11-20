# AI Writing fixtures

## Response limits (#377)

AIHUB reads an AI Service response as untrusted input. It bounds the body it
reads, bounds the text it passes on, and removes control characters from that
text. Each limit below is set from what these captures hold, with room to spare.
To raise one, measure again here first.

| Limit                             | Value        | Where it is enforced                                                            |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| Writing response body             | 256 KiB      | `WRITING_RESPONSE_MAX_BYTES` in `src/catalog/operation-catalog.ts`, per request |
| Feedback, explanation, label text | 4,000 units  | `MODEL_TEXT_MAX_LENGTH` in `src/contracts/model-text.ts`, per field             |
| Quotation or transcript           | 20,000 units | `MODEL_QUOTE_MAX_LENGTH` in `src/contracts/model-text.ts`, per field            |

A unit is a UTF-16 code unit.

What the captures show:

- The largest response is `grade-v3-task2.response.json` at 17,759 bytes, so the
  body limit is about 14.8 times it.
- The longest text a customer receives is 982 units (`micro-grade-long-writing`
  `.data.comment`); the longest `feedback_detail` entry is 978. The text limit is
  about four times that. The `coT` strings, up to 2,193 units, are dropped by the
  adapters and never reach a customer, so they do not count.
- A quotation comes from the essay, which AIHUB refuses past 20,000 units, so no
  honest quotation is longer than the quotation limit.
- No captured string holds a control character, so the removal never changes a
  fixture.

To measure again, walk every `*.response.json`, and record the largest file size
and the longest string outside `data.coT`.
