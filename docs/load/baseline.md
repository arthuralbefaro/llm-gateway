# Load and chaos report

## Execution environment

Every number below was produced on one laptop running everything at once. That
matters more than any single figure here, so the caveats come first.

| | |
|---|---|
| CPU | AMD Ryzen 5 7520U, 4 physical cores / 8 logical |
| RAM | 15.3 GB |
| OS | Windows 11 Pro 10.0.26200 |
| Node | v24.19.0 |
| Gateway | `node dist/main`, **compiled**, not `start:dev` |
| Postgres | 17.11 in Docker, host port 5433 |
| Redis | 7 alpine in Docker, host port 6380 |
| Embedding | Xenova/multilingual-e5-small, q8, in process on CPU |
| k6 | v2.2.0, **same machine**, localhost |
| Provider | local adapter, 120 ms simulated latency unless stated |

Three caveats that bound how far these numbers travel:

- **The gateway ran compiled.** `start:dev` runs a file watcher and an
  incremental compiler beside the server, so measuring that measures the watcher
  too. It also delays boot by roughly ten seconds, which invalidated an earlier
  chaos run whose failure window expired before the first request arrived.
- **k6 shares the four cores with the gateway, Postgres and Redis.** The load
  generator competes for the resource under test. Absolute throughput here is a
  floor, not a capacity figure.
- **The embedding model runs on the same CPU, in the same process.** With a
  dedicated inference host the saturation point below moves substantially, and
  it is the first thing to change.

## Scenarios and their declared hit rates

Every scenario declares a target cache hit rate and the report states the
measured rate beside the latency, per `docs/adr/0005`. A run whose measured rate
misses its target is a failed run, and two of them are recorded as such.

| Scenario | Target hit | Measured hit | Mechanism |
|---|---|---|---|
| ramp | 0% | **0.00%** (0 / 4339) | `cache: false` |
| isolate, with embedding | 0% | **0.00%** (0 / 1201) | `cache: false` |
| isolate, no embedding | 0% | **0.00%** (0 / 1201) | `temperature: 0.9` |
| cache high | 90% | **86.00%** (516 / 600) | shared warm pool |
| cache off | 0% | **0.00%** (0 / 601) | `cache: false` |
| chaos, provider | 0% | **0.00%** (0 / 1125) | `cache: false` |
| chaos, redis | 90% | **88.00%** (726 / 825) | shared warm pool |

The 86% against a 90% target is the warm-up: a pooled prompt only hits after its
first appearance has been served and stored. Reported rather than corrected,
because it is a property of the run and not an error in it.

### Two failed runs, kept in the record

An earlier pair of cache scenarios declared 90% and 50% and measured **50.54%**
and **38.69%**. Both are void, for two reasons. The warm pool was built per
virtual user, so sixty VUs held sixty private pools and almost nothing repeated
across them. And the runs were driven at 40 req/s, above the saturation point,
so queuing dominated whatever the cache was doing.

Recorded because a benchmark that quietly discards runs that did not behave is
the same failure this report exists to avoid.

## Saturation

Ramp, six steps of 15 s, 20 to 120 req/s, all traffic bypassing the cache read
but still writing an entry.

| | |
|---|---|
| Requested peak | 120 req/s |
| Achieved | **44.7 req/s** |
| Dropped iterations | 1210 |
| Latency | min 119 ms, med 1.96 s, p95 7.18 s, p99 7.28 s |
| Errors | **0.00%** |

The gateway does not fail under overload, it queues. Zero requests errored while
the p99 rose sixty-fold. For a client with a timeout that distinction disappears
— a 7 s p99 is an outage with a 200 status code — but nothing is dropped or
corrupted on the way.

## Where it degrades, and why

The ramp above saturates near 45 req/s. The cause is the embedding, and it was
isolated rather than assumed.

Both runs below are the same traffic at the same rate against the same provider.
The only difference is that the second one pays no embedding cost, because
`temperature: 0.9` skips the cache entirely, read and write, while `cache: false`
skips only the read and still embeds every answer in order to store it.

**40 req/s, 30 s, 0% cache hit in both:**

| | med | p95 | p99 | max |
|---|---|---|---|---|
| With embedding on every store | 202 ms | 311 ms | 357 ms | 408 ms |
| Without any embedding | **127 ms** | **128 ms** | **129 ms** | **139 ms** |

Without the embedding the latency is flat: 127 ms median against a 120 ms
simulated provider, so the entire gateway — auth, rate limit, routing, retry,
breaker, metrics — costs about 7 ms and does not vary.

With the embedding the median moves by 75 ms, but the spread is the telling
number. The no-embedding run spans 124 to 139 ms; the embedding run spans 127 to
408 ms at the same offered load. A merely additive cost would shift the whole
distribution. A cost that widens it is contention, and here it is the **event
loop**: ONNX inference is synchronous CPU work on the main thread, so every
request waits behind the embeddings of the requests before it.

Raising the rate on the path with no embedding confirms the ceiling belongs to
the embedding and not to anything else:

| Rate | med | p99 | Dropped |
|---|---|---|---|
| 40 req/s | 127 ms | 129 ms | 0 |
| 100 req/s | 125 ms | 138 ms | 0 |
| 200 req/s | 179 ms | 508 ms | 37 |

**Roughly 100 req/s flat without the embedding, roughly 45 req/s with it.** The
embedding costs a factor of four in throughput ceiling.

### What would be needed to improve it

In rough order of value per unit of work:

1. **Move the embedding off the event loop.** A worker thread pool keeps
   inference on the CPU but stops it blocking request handling. Largest effect
   per unit of work, and no change in behaviour.
2. **Do not embed on the write path at all.** Storing blocks the response path
   even though `store` is fired without awaiting, because the embedding runs on
   the same thread. Queueing stores and embedding in batches removes the cost
   from the request entirely, at the price of a short window where a
   just-answered prompt is not yet cacheable.
3. **Give inference its own host.** The correct answer at real scale, and it
   makes the first two unnecessary. Converts CPU contention into a network hop
   of a few milliseconds.
4. **Skip embedding for prompts unlikely to repeat.** Speculative, needs the
   eval-week data: if a large share of stored entries are never hit, the write
   cost is being paid for nothing.

Postgres and the connection pool were never the constraint at these rates. The
`CacheEntry` table stayed under a few hundred rows, so the HNSW index was never
under enough pressure to say anything about its scaling, and that remains
untested.

## Cache under load

20 req/s, 30 s, below the saturation point so that the cache effect is visible
rather than buried in queuing.

| | Measured hit | med | p95 | p99 |
|---|---|---|---|---|
| Cache off | 0.00% | 132 ms | 149 ms | 152 ms |
| Cache on | 86.00% | **5.2 ms** | 147 ms | 163 ms |

Served-from-cache responses alone: median 5.07 ms, p99 22 ms.

The median falls by a factor of 25 and **the tail does not move**. At an 86% hit
rate the remaining 14% still pay the full provider cost, and they are what p95
and p99 measure. A cache buys throughput, cost and typical latency. It does not
buy tail latency until the hit rate approaches 100%, and quoting a cache's
median improvement as a latency improvement overstates it substantially.

## Chaos: the primary provider dies mid-run

15 req/s for 75 s. The primary is configured to fail every call between 20 s and
55 s of process uptime and to recover by itself; a healthy backup serves the same
model throughout.

| | |
|---|---|
| Requests | 1125 |
| **Failed** | **0.00%** |
| Served by fallback | 646 |
| Latency | med 136 ms, p95 176 ms, **p99 437 ms** |

Breaker state, sampled every 2 s:

```
 2s ... 12s   local=closed        local-backup=closed
14s ... 34s   local=open          local-backup=closed
36s ...       local=closed        local-backup=closed
```

Recorded attempts:

```
 provider     | status  | count
--------------+---------+-------
 local        | error   |    77
 local        | success |   479
 local-backup | success |   646
```

**Only 77 failures were recorded across a 35 s outage** that would otherwise
have produced roughly 525 failed calls. The breaker opened once the failure ratio
crossed its threshold and refused the rest without attempting them. The dead
provider stopped being called, and those refusals were not counted against the
backup that answered instead.

**The p99 of 437 ms against a 152 ms baseline** is the visible cost of
resilience. Every request in the window before the breaker opened paid two
attempts on the dead provider plus backoff before reaching the backup. Bounded,
and it bought a zero error rate — but not free, and a report showing only the
error rate would hide it.

## Chaos: Redis dies mid-run

15 req/s for 55 s, 90% target hit rate, Redis stopped at 25 s and never returned
during the run.

The first run of this scenario exposed a defect.

| | Before the fix | After |
|---|---|---|
| Requests failed | 0.00% | 0.00% |
| **Measured hit rate** | **37.81%** | **88.00%** |
| `semantic lookup skipped` | 412 | **0** |
| Cached latency, med | 5.9 ms | 17.8 ms |

Availability was never at risk in either run: no request failed with Redis down,
which is the property the cache was designed for. But the hit rate collapsing to
38% was not degradation, it was a bug.

All 412 skipped semantic lookups reported a **Redis** error, not a Postgres one,
while Postgres was up the entire time and held 103 cache entries.
`semanticLookup` found its neighbour in pgvector, then wrote the result back into
Redis as a shortcut for the next caller, and that write threw. The throw escaped
through the enclosing try, and the hit — already retrieved, already correct — was
discarded and reported as a miss.

An optimisation for a future request destroyed the result of the current one.
The fix makes the write-back non-fatal, and the same run now serves 88% from the
semantic path with Postgres alone.

The cached-latency figure rising from 5.9 ms to 17.8 ms is the honest cost of
that path: a vector search against Postgres instead of a key lookup in Redis.
Slower, correct, and still an order of magnitude below the provider. **Worse
performance, unchanged availability** is what was intended, and only after the
fix is it what actually happens.

## Prompt generation

Scenarios draw prompts from a generator whose entropy is semantic rather than
lexical, validated against the same embedding model the cache uses before being
trusted. Four collision classes were found and closed:

| Scheme | Closest pair | Cause |
|---|---|---|
| topic + angle + trailing clause | 0.9607 | clause varies the surface only |
| paired topics | 0.9964 | `a relates to b` vs `b relates to a` |
| canonically ordered pairs | 0.9742 | same pair, different angle |
| pairs drawn without replacement | 0.9606 | same angle, one shared topic |

Final measurement over 120 generated prompts and 7140 pairs: mean similarity
0.8356, max 0.9606, and **0.084% of pairs at or above the 0.95 threshold**.

The conclusion is not that the generator is now safe. It is that **entropy cannot
guarantee a zero hit rate at this threshold** — every scheme leaked somewhere,
and the last one still leaks at 0.08%. Entropy is the dial that produces
intermediate rates. `cache: false` is the guarantee, and every zero-hit scenario
in this report uses it.

## Summary

| Question | Answer |
|---|---|
| Throughput ceiling, cache writes on | ~45 req/s |
| Throughput ceiling, no embedding | ~100 req/s flat, degrading by 200 |
| Gateway overhead excluding embedding | ~7 ms, flat |
| What saturates first | embedding inference blocking the event loop |
| Behaviour under overload | queues, does not error |
| Provider outage | 0% errors, p99 437 ms, breaker suppressed ~450 doomed calls |
| Redis outage | 0% errors, hit rate 88%, cached latency 5.9 → 17.8 ms |
| Untested | HNSW scaling, Postgres pool limits, multi-instance breaker |
