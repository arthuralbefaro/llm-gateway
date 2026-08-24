# Week 4, observability: tracing, metrics, analytics, dashboard

Companion to `docs/load/baseline.md` and `docs/load/worker-pool.md`,
and to ADRs 0001 through 0006.

## What was built

| | |
|---|---|
| Tracing | OpenTelemetry, Jaeger all-in-one as the collector, spans for the request, auth, rate limiting, cache lookup split into exact and semantic, embedding, each provider attempt, and the cache write |
| Metrics | Prometheus via `prom-client` at `/metrics`, scraped every 5 s, rendered by a provisioned Grafana dashboard |
| Analytics | Six endpoints over hand-written SQL against `Request` and `RequestAttempt`, behind a token separate from the gateway keys |
| Dashboard | Next.js, four views, server-side fetching |

No gateway behaviour changed. One migration was agreed in advance and added
`Request.cacheKind`, which is a record of what the gateway already knew rather
than a new decision.

## The theme of the week: reassuring output

Five problems appeared while building the observability layer. Technically
unrelated, and all the same failure:

**something reported success while being wrong, and the report was the thing
that made it hard to find.**

That is worth stating plainly because this week's deliverable is a set of tools
whose entire job is to tell the truth about the system. A monitoring tool that
misreports under load is worse than no monitoring, because a gap is visible and
a wrong number is trusted.

### 1. Import order: spans that never existed, with no error

Tracing must start before `http` and `express` are required, because the
instrumentations patch those modules as they load. The natural way to write it
is a function called from `bootstrap`:

```ts
import { startTracing } from './tracing/tracing';
startTracing();
import { NestFactory } from '@nestjs/core';
```

This does not work, and it does not fail either. TypeScript hoists imports above
ordinary statements when emitting CommonJS, so `@nestjs/core` and `express` are
required first and `startTracing()` runs afterwards, against modules already
loaded. The application starts, traces are exported, spans exist — the HTTP and
Express spans simply are not among them.

The symptom is a trace tree that looks shallower than expected, which reads as
"the instrumentation does not cover that layer" rather than "the instrumentation
never attached". No error, no warning, no failing test.

The fix is a side-effect module imported first, and the fix is only trustworthy
because it was verified in the emitted JavaScript rather than in the source:

```
3:require("./tracing/tracing");
4:require("@nestjs/core");
5:require("./app.module");
```

Reading the source would have shown the same import order in both the broken and
the working version. Only the compiled output distinguishes them.

### 2. The controller singleton: a metric that would only lie under load

The request outcome — exact hit, semantic hit, miss, bypassed — is known inside
the handler and needed in a `finally` block that records the duration. The first
version put it on the controller:

```ts
private outcome: CacheResult = 'miss';
```

A Nest controller is a singleton. Two concurrent requests share that field, so
the second overwrites the first, and every latency observation is filed under
whichever outcome finished last.

Single-request testing cannot see this. Correct at concurrency one, wrong in
proportion to load — the labels are most wrong exactly when the metric matters. A
cache-hit histogram quietly filled with provider latencies would have made the
cache look slower and the provider faster, and nothing about the output would
have looked odd.

The fix is a return value rather than instance state. It also made the compiler
demand an explicit outcome at every exit point in the handler, which turned an
implicit assumption into eight explicit declarations.

### 3. Tracing overhead: the first measurement was thrown away

The task asked for the instrumentation overhead. The first measurement, at
40 req/s on the standard isolate scenario:

| | p99 |
|---|---|
| tracing off | 210 ms |
| tracing on | 358 ms |

That is +148 ms, or +71%, and it is a good headline. It is also not a result.

Repeating the pair with the order reversed produced tracing on at 642 ms and
tracing off at 535 ms. A third round put tracing off at 999 ms. Across four
rounds of an **unchanged** configuration, the no-tracing baseline measured:

```
210 ms   535 ms   999 ms   287 ms
```

A five-fold spread on the control. The machine's variance was larger than the
effect being measured, so the first number was not overhead — it was noise that
happened to fall in the expected direction.

The reason is known from week 3: at 40 req/s the embedding path is at the edge of
saturation, and the tail there is dominated by queueing rather than any
per-request cost. Measuring a small effect on top of a saturated system measures
the saturation.

The measurement was moved to the path with no embedding, which week 3 showed to
be flat, and repeated twice in alternating order:

| | med | p95 | p99 |
|---|---|---|---|
| tracing off | 127.37 ms | 129.48 ms | 175.52 ms |
| tracing on | 127.98 ms | 131.79 ms | 204.55 ms |
| tracing off | 127.49 ms | 129.98 ms | 195.61 ms |
| tracing on | 128.20 ms | 134.28 ms | 195.09 ms |

**Median +0.7 ms. p95 +3.3 ms. p99 within the noise**, since its two deltas are
+29 ms and −0.5 ms and cannot be separated from run-to-run variation.

#### Why the proportion matters more than the number

0.7 ms sounds like nothing, but the thing to compare it against is not the
request.

Week 3 measured the gateway's own cost — auth, rate limiting, routing, retry,
breaker, metrics — at roughly **7 ms**, by running the no-embedding path against
a 120 ms simulated provider and finding a flat 127 ms. Against a 120 ms upstream,
tracing is 0.5% and invisible. Against the gateway's own work, **tracing is about
10% of everything the gateway does**.

That is the number that scales badly, and why the sampler defaults to `AlwaysOn`
in development and would run well under 1 in production: a system whose own
overhead is 7 ms cannot export a span tree per request.

The discarded measurement is recorded here for the same reason the failed load
runs are recorded in the baseline report. A methodology that only publishes the
runs that behaved is not a methodology.

### 4. `pnpm install` reporting success without installing

Creating the dashboard as a nested project, then installing its dependencies:

```
$ cd dashboard && pnpm install
Already up to date
Done in 808ms
```

Nothing was installed. `dashboard/node_modules` did not exist. pnpm found the
workspace root above, saw a `pnpm-workspace.yaml` whose `packages:` list did not
mention the dashboard, concluded the workspace was satisfied, and said so.

Both statements are true from pnpm's position and together they mislead: the
workspace *was* up to date, and the directory asked about was not part of it.
Accepting the message would have moved the failure to `next build`, several steps
later, where it would have looked like a broken Next.js setup.

The fix is declaring the package. The check that mattered was `ls
dashboard/node_modules`, which took a second and is worth more than the exit
code.

### 5. The migration that keeps deleting the index

Reported in full in ADR 0003 and repeated here because week 4 added the third
and fourth data points. Every generated migration this week arrived carrying:

```sql
-- DropIndex
DROP INDEX "cache_embedding_idx";
```

on changes whose intended content was one nullable column. Prisma cannot model an
index over an `Unsupported` column, so it reads the HNSW index as drift on every
diff. Applying it fails nothing: the cache keeps returning correct answers and
degrades to a sequential scan, so the symptom is a cache that slows as it fills —
indistinguishable from a healthy cache under growing load.

The static guard caught both, naming the file each time before it was applied.
Three occurrences out of three migrations is not a coincidence to note, it is the
default behaviour to design around.

## Measurements taken this week

### Latency by cache outcome, from the metrics

Under load at 20 req/s with a 60% target hit rate:

| | p50 | p99 |
|---|---|---|
| exact hit | 3.2 ms | 49.5 ms |
| semantic hit | 39.4 ms | 458.7 ms |
| miss | 185.5 ms | 492.9 ms |

This is the number that shaped the analytics API and the dashboard. **A semantic
hit's p99 is 93% of a miss's.** A combined hit rate of 88% reads as "88% of
requests were fast", and if most of those hits were semantic that is false at the
tail.

Three consequences were built rather than documented:

- the SQL never produces a row aggregated across the cache outcome, so a
  consumer cannot merge them by accident
- `Request.cacheKind` records which store answered, so the split survives into
  history rather than living only in Prometheus
- the dashboard puts the latency table directly beneath the hit rate chart

### Cardinality: what was left out

Labels kept: route, status, cache outcome, provider, model, estimated flag,
token kind, lookup result, breaker target state, skip reason, and the model pair
on fallbacks. Every one is bounded by a table the gateway owns.

Labels refused, with the reason:

| Label | Why not |
|---|---|
| api key id | grows with every customer, and a series never expires once created. it also identifies a person, in a store that is retained and rendered far more widely than a database row. per key questions belong in the sql api, asked on demand |
| prompt, prompt hash | unbounded by definition, one series per distinct prompt |
| error message | looks like an enum, is not: upstream text carries request ids and quota figures |
| similarity, cost, latency | continuous, and already present in buckets and sums |
| trace id | one series per request |
| requested model | bounded, and still refused: multiplying it against served model squares the cost metric's series to answer a question only the fallback counter asks |

The last row is the one worth keeping. A cheap label still has to justify the
multiplication it causes.

## What is not covered

- **Tail sampling.** Head sampling cannot keep the slow requests specifically,
  which is what a production sampler should do. That needs a collector.
- **Per key analytics.** Deliberately absent from the metrics, and not yet built
  in the API either.
- **Analytics authorisation beyond one shared secret.** A scope on `ApiKey` is
  the right shape and is recorded, not built. A shared secret cannot be revoked
  per reader, rotated without coordinating everyone, or narrowed to a subset.
- **Dashboard depth.** Four views at the simplest depth that works. Cost has no
  breakdown by provider, there is no window picker, and nothing refreshes
  without a reload.
- **Overhead of the metrics path.** Only tracing was measured. `prom-client`
  counters are cheap in principle and were not measured in practice, which by
  this report's own standard means they are unmeasured rather than free.
