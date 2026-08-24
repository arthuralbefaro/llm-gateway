# Worker pool for the embedding

*Measured before semantic lookup became opt-in (ADR 0010). Scenarios
using `cache: false` or `temperature` bypasses are unaffected; the
default read path changed and is remeasured in
[read-path-after-opt-in.md](read-path-after-opt-in.md).*

Follow-up to [the baseline](baseline.md), which isolated the bottleneck: ONNX
inference is synchronous CPU work on the main thread, so every request waits
behind the embeddings of the requests before it. This is item 1 of that report's
improvement list, and only item 1.

Same machine, same day, same harness, same scenarios. Environment as declared in
the baseline: Ryzen 5 7520U (4 physical / 8 logical), 15.3 GB, Windows 11, Node
24.19, gateway compiled via `node dist/main`, Postgres and Redis in Docker, k6
v2.2.0 on the same machine competing for the same cores, local provider at 120 ms
simulated latency.

## Headline

| Ramp, 20 to 120 req/s | Baseline | Worker pool |
|---|---|---|
| Achieved | 44.7 req/s | **61.6 req/s** |
| Dropped iterations | 1210 | **0** |
| median | 1.96 s | **128.6 ms** |
| p95 | 7.18 s | **148.7 ms** |
| p99 | 7.28 s | **174.4 ms** |
| max | 7.4 s | **273 ms** |
| Errors | 0.00% | 0.00% |
| Measured hit rate | 0.00% | 0.00% (`cache: false`) |

The p99 fell from 7.28 s to 174 ms. The baseline's ramp did not fail, it queued
until requests took seven seconds; this one stays inside 300 ms across the whole
climb and drops nothing.

## The dispersion question

The baseline's evidence that this was contention rather than additive cost was
the spread, not the median. Same test, 40 req/s, 30 s, 0.00% measured hit rate in
every column.

| | min | med | p95 | p99 | max | spread |
|---|---|---|---|---|---|---|
| Baseline, embedding on main thread | 127 | 202 | 311 | 357 | 408 | 127–408 |
| **Pool of 1** | **120** | **127** | **131** | **152** | **274** | **120–274** |
| No embedding at all | 123 | 127 | 128 | 130 | 137 | 123–137 |

The median lands exactly on the no-embedding path: 127 ms against 127 ms. The
spread narrows from 281 ms wide to 154 ms, against 14 ms for traffic that does no
embedding at all.

**The contention is mostly gone, and a residue remains.** p99 is 152 ms where the
embedding-free path is 130 ms, and the max is 274 ms against 137 ms. Those 22 ms
at p99 are the hop itself — dispatching a task, copying 384 floats back across
the thread boundary — plus moments where the single worker and the event loop
want the same core. A different shape of cost from the baseline's: bounded, and
it does not grow with load the way queuing did.

## Pool size: more workers made it worse

Measured back to back, 40 req/s, 25 s each, embedding on every store.

| Workers | med | p95 | p99 | max |
|---|---|---|---|---|
| **1** | **126.9 ms** | **130.7 ms** | **152.4 ms** | **274 ms** |
| 2 | 127.3 ms | 147.6 ms | 252.3 ms | 304 ms |
| 4 | 215.3 ms | 385.6 ms | 462.0 ms | 547 ms |

Four workers is worse than the baseline it was meant to fix.

The reason is that **onnxruntime already parallelises a single inference across
cores**. A second worker does not add a second unit of parallelism, it competes
with the first for the cores the first is already using, and both compete with
the event loop the pool exists to protect. On four physical cores also running
k6, Postgres and Redis, the contention arrives quickly.

The default was originally `min(4, availableParallelism() - 1)`, which here is
4 — the worst measured configuration, from a formula that reasoned about cores
as if inference were single-threaded. **The default is now 1**: the pool's job is
to move inference off the event loop, not to parallelise it, and one worker does
that entirely.

Raising it is still worth doing where inference is single-threaded, or on a host
with cores to spare beyond what onnxruntime consumes. Not a knob to turn up by
default.

## Cache scenarios

20 req/s, 30 s, below saturation in both the baseline and this run.

| | Target hit | Measured hit | med | p95 | p99 |
|---|---|---|---|---|---|
| Baseline, cache off | 0% | 0.00% | 132 ms | 149 ms | 152 ms |
| Baseline, cache on | 90% | 86.00% | 5.2 ms | 147 ms | 163 ms |
| Pool, cache off | 0% | 0.00% | 136 ms | 176 ms | 227 ms |
| Pool, cache on | 90% | 85.52% | 8.4 ms | 170 ms | 216 ms |

**At 20 req/s the pool costs a little rather than saving anything.** Cache-off
p99 goes from 152 ms to 227 ms, and the median served from cache from 5.2 ms to
8.4 ms. There is no queue to remove at this rate, so all that remains is the
thread hop.

The pool's value is entirely in contention. Below the point where the event loop
was blocking it is a small tax; above it, the difference between 174 ms and
7.28 s.

The measured hit rates track the baseline's, 85.52% against 86.00% for the same
90% target, which is what makes the latency columns comparable at all.

## What the bottleneck is now

**The single worker's embedding throughput**, and the system sheds cache writes
rather than latency or availability when it runs out.

At 100 req/s with the embedding on every store:

| | |
|---|---|
| Achieved | **99.3 req/s** |
| Errors | **0.00%** |
| Dropped iterations | 4 |
| Latency | med 171 ms, p95 343 ms, **p99 503 ms** |
| Pool queue | repeatedly at limit, stores skipped |

The gateway keeps serving at essentially the requested rate. What gives way is
the cache: `cache store skipped: Task queue is at limit` fires continuously, so
answers are returned and not stored. The bounded-queue policy working as
designed, and the right thing to shed — an embedding that starts after its caller
has gone is waste, and a cache write that never happens costs a future lookup
rather than a present request.

How we know it is the worker and not something else:

- **Not Postgres.** The `cache store skipped` messages report the pool's queue
  limit, not a database error, and the same rate with no embedding at all runs
  flat at 127 ms.
- **Not the event loop generally.** The embedding-free path at 100 req/s is
  125 ms median and 138 ms p99. The event loop has room; it is the work handed to
  the worker that does not fit.
- **Not the provider.** Simulated at 120 ms, and the no-embedding path sits on it.
- **Partly the machine.** k6, Postgres, Redis and the gateway share four physical
  cores, and the worker competes with all of them. On a host where the load
  generator is elsewhere, the ceiling is higher than what is reported here. The
  numbers above are a floor.

## A failed run, kept in the record

The first attempt at the pool=1 ramp reported **100% failures across 5549
requests**. It is void: the gateway had been launched from a command that hit a
two minute timeout, and the timeout killed the server along with it. k6 was
measuring a closed port, which the log confirms as `connectex: ... recusou
ativamente`.

Recorded rather than deleted for the reason the baseline gives: a benchmark that
quietly discards runs that misbehaved is not a benchmark. It did leave one useful
observation before dying — `cache store skipped: Task queue is at limit` under
ramp overload, the first confirmation that the queue cap behaves as intended.

One further caveat on variance: two pool=4 measurements taken twenty minutes
apart produced medians of 127 ms and 215 ms under nominally identical conditions.
The scaling table above uses the back-to-back set, where all three sizes were
measured in one sequence. Single runs on a shared laptop carry more variance than
the differences some of these tables report, and the pool=1 versus pool=4 gap is
large enough to survive that; the pool=1 versus pool=2 gap may not be.

## What is still untested

- **The new ceiling.** The ramp to 120 req/s no longer saturates the way the
  baseline's did, and 100 req/s constant was served in full. Where it actually
  breaks is above what was run.
- **HNSW scaling**, unchanged from the baseline: `CacheEntry` never exceeded a few
  hundred rows, so nothing here says anything about the index under pressure.
- **The Postgres pool**, never the constraint at these rates and therefore never
  characterised.
- **Worker death under load.** Recovery is covered by a test that kills a real
  worker thread and shows the pool replacing it, but it has not been exercised
  while traffic is running.
- **Multi-core hosts.** Every conclusion about pool size here is bound to four
  physical cores shared with the load generator. On a larger host the crossover
  where a second worker starts helping may exist; it does not exist here.
