# The default read path after semantic became opt-in

When semantic lookup became opt-in (ADR 0010), the default read path stopped
embedding: a default lookup is one Redis GET. Before the change, every default
miss paid an awaited embedding for the semantic search plus a fire-and-forget
embedding for the store — two embeddings per miss through the single worker.

The old default is exactly reproducible on the current build as
`cache: "semantic"`, so both arms ran on the same binary, same machine, same
day, alternating, with `CacheEntry` truncated and the exact keys flushed before
each round.

## Environment

Same laptop as the earlier load reports, sharing four physical cores with k6
and the full docker stack. Gateway compiled, `LOCAL_LATENCY_MS=120` to match
the 120 ms simulated provider those reports used (the code default is 150 ms).
40 req/s for 30 s per round, entropy prompts, `test/load/read-path.js`.

## Result

Miss-only latency (`gateway_provider_latency`, cache hits excluded), measured
hit rate beside it per ADR 0005:

| Arm | Round | med | p90 | p95 | max | Measured hit |
|---|---|---|---|---|---|---|
| old default (`cache: "semantic"`) | 1 | 205.3 ms | 555.1 ms | 627.5 ms | 1643 ms | 9.17% |
| old default (`cache: "semantic"`) | 2 | 198.6 ms | 565.3 ms | 610.1 ms | 883 ms | 9.25% |
| **new default** | 1 | 163.8 ms | 365.5 ms | 440.8 ms | 851 ms | 3.25% |
| **new default** | 2 | **162.0 ms** | **180.0 ms** | **197.6 ms** | 317 ms | 4.08% |

**The default miss median fell by about 40 ms (20%), and the p95 by 190 to
430 ms.** Both rounds agree on the median; the tail is noisier and always
better.

The mechanism is the week 3 contention story on the read side. The old default
offered the single embedding worker two tasks per miss, 80 embeds/s at this
rate, and the lookup embedding is awaited on the request path, so requests
queued behind it. The new default offers 40/s, all fire-and-forget stores, and
the request path never waits on the worker.

The hit rates differ between arms because the semantic arm also matches
entropy collisions the exact tier cannot see, 9.2% against 3.7%. Hits are
excluded from every latency column, so the comparison is miss against miss.

## A voided pair of rounds, kept in the record

The first four rounds produced medians near 7 ms and were void: the dev key had
been rotated by the seed and fell back to the global rate limit, so 95% of
requests were 429s answered in single-digit milliseconds. A run whose median is
7 ms against a 120 ms provider is not fast, it is not reaching the provider.
The k6 summary carried `gateway_rate_limited: 1141` and the latency looked
excellent — the same reassuring-output trap as every other one in this
project's record. Load testing needs a key whose `rateLimit` clears the offered
rate, and that requirement is now part of the setup documentation.

## What this does and does not update

- The earlier reports' `cache: false` and `temperature` scenarios never touched
  the semantic read path, so the ramp, isolate, chaos and worker-pool numbers
  stand as measured.
- The "cache on" scenario's misses paid a read embedding that the default no
  longer pays. Under the new default that scenario's miss cost looks like the
  `cache: false` rows. Opt-in traffic continues to behave as the old
  measurements describe.
- The absolute gap to the worker-pool report's 127 ms `cache: false` median
  (163 ms here) is machine state, not a regression: these rounds ran with the
  full observability stack, a dashboard and two hours of accumulated services
  competing for the same four cores. The claim in this note is arm against arm
  on the same day, not this day against that one.
