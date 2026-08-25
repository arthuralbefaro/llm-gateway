# API

One endpoint. Authentication is a bearer token tied to an `ApiKey` row.

```
POST /v1/chat/completions
Authorization: Bearer <key>
```

## Request

| Field | Type | Meaning |
|---|---|---|
| `model` | string | Model to answer with. An unsupported model is a 400, never a silent substitution. |
| `messages` | array | `{role, content}`, roles `system`, `user`, `assistant`. At least one. |
| `temperature` | number? | Above zero bypasses the cache by design: a caller asking for variation must not get a replay. |
| `max_tokens` | number? | Completion cap, passed through. |
| `stream` | boolean | SSE when true. A cached answer is replayed in chunks, indistinguishable by shape. |
| `fallback` | boolean? | `false` prefers an error over another provider's answer. Default on, with an explicit model-equivalence map. |
| `cache` | boolean \| `"semantic"` | See below. |

## The `cache` field

| Value | Reads | Writes |
|---|---|---|
| omitted or `true` | exact only | yes |
| `"semantic"` | exact, then nearest neighbour | yes |
| `false` | nothing | yes |

Every mode writes: wanting a fresh answer is not a reason to deny it to the
next caller.

**Semantic lookup is opt-in because it is measurably unsafe.** It embeds the
prompt and returns the nearest stored answer when cosine similarity clears
0.95. On a labelled dataset of 220 pairs (`evals/`), similarity does not
measure answer equivalence — it measures subject proximity, and precision
*falls* as similarity rises inside the acceptance band:

| Similarity band | Hits | Right | Wrong | Precision |
|---|---|---|---|---|
| 0.95–0.96 | 5 | 4 | 1 | 0.800 |
| 0.96–0.97 | 11 | 6 | 5 | 0.545 |
| 0.97–0.98 | 14 | 5 | 9 | 0.357 |
| 0.98–1.00 | 6 | 1 | 5 | 0.167 |

A near-identical prompt with a different answer — a negation, an entity swap, a
changed time scope — scores *higher* than a reworded version of the same
question. Opting in accepts roughly a coin flip of correctness in the high
band, in exchange for a ~93 ms median saving and one provider call per hit.
ADR 0008 has the measurement, ADR 0010 the decision.

The numbers come from an adversarial dataset written by the project author;
they bound what the tier can miss, not how often real traffic triggers it.

## Response

```json
{
  "id": "…",
  "model": "local-small",
  "requested_model": "local-small",
  "provider": "cache",
  "fallback": false,
  "cache_hit": true,
  "cache_kind": "semantic",
  "cache_similarity": 0.9612,
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

- `fallback` is reported by the router that executed the routing, never
  inferred by comparing models (ADR 0004).
- `cache_kind` appears on every hit: `exact` or `semantic`.
- `cache_similarity` appears only on semantic hits. An exact hit is the same
  prompt by construction and a similarity would be noise. **A caller who opted
  in can see exactly how near the neighbour was — and the band table above is
  the reason a high number is not reassurance.**
- Streaming responses carry the same fields on the final chunk.

## Analytics

Six read-only endpoints over the request history, behind a bearer token
separate from the gateway keys (`ANALYTICS_TOKEN`). With the token unset they
answer 401 — the guard fails closed.

```
GET /v1/analytics/cost
GET /v1/analytics/cache-hit-rate
GET /v1/analytics/latency
GET /v1/analytics/provider-failures
GET /v1/analytics/fallbacks
GET /v1/analytics/savings
```

All accept `from` and `to` (ISO 8601, default the last 24 hours) and `bucket`
(`minute`, `hour`, `day`, default `hour`). Notes that matter when reading them:

- `latency` and `cache-hit-rate` split exact from semantic and never aggregate
  across cache outcome. The reason is measured: a semantic hit's p99 sits at
  93% of a miss's, so a combined hit rate suggests a speed it does not deliver.
- `savings` returns an interval, not a point estimate, and carries its
  methodology in the response body. Estimated cost is always distinct from
  confirmed cost.
- Rows recorded before the `cacheKind` column existed are reported as
  unclassified rather than guessed.

## Errors

| Status | Meaning |
|---|---|
| 400 | Validation failure, including an unsupported model or unknown `cache` value. |
| 401 | Missing or unknown key. |
| 429 | Rate limit exceeded for this key, fixed window in Redis, fail-open when Redis is down. |
| 502 | All providers exhausted after retries, breaker state included in the message. |

A mid-stream failure arrives as an `event: error` SSE frame, since the 200 is
already on the wire.
