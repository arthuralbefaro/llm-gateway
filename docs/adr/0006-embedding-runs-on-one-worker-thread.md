# 6. The embedding runs on one worker thread, and only one

Status: accepted

## Context

Embedding runs in process through `@huggingface/transformers`. ONNX inference is
synchronous CPU work, so on the main thread it blocks the event loop.

The [baseline load report](../load/baseline.md) measured it. At 40 req/s with
identical traffic, the only difference being whether an embedding was computed:

| | med | p99 | spread |
|---|---|---|---|
| Embedding on the main thread | 202 ms | 357 ms | 127–408 ms |
| No embedding | 127 ms | 129 ms | 123–139 ms |

The median moving 75 ms is a cost. The spread widening from 16 ms to 281 ms is
contention: requests waiting behind other requests' inference. Under a ramp the
same effect took p99 to 7.28 s and the throughput ceiling to roughly 45 req/s,
against roughly 100 req/s for traffic that embeds nothing.

## Decision

Run the embedding on a `piscina` worker pool with **one worker by default**.

`piscina` rather than a hand-written pool: bounded queues, cancellation through
`AbortSignal` and replacing a dead thread are where such code goes wrong, and
none of it is the problem being solved.

**One worker** because more measured worse. At 40 req/s on four physical cores:

| Workers | med | p95 | p99 | max |
|---|---|---|---|---|
| 1 | 126.9 ms | 130.7 ms | 152.4 ms | 274 ms |
| 2 | 127.3 ms | 147.6 ms | 252.3 ms | 304 ms |
| 4 | 215.3 ms | 385.6 ms | 462.0 ms | 547 ms |

Four workers is worse than the main-thread baseline this change exists to fix.

The first default was `min(4, availableParallelism() - 1)`, resolving to 4 here:
the worst measured configuration, chosen by a formula that reasoned about cores
as though inference were single threaded. **onnxruntime already spreads one
inference across cores.** A second worker does not add parallelism, it competes
with the first for cores the first is already using, and both compete with the
event loop the pool exists to protect.

**The pool's purpose is isolation, not parallelism**, and one worker delivers all
of it.

## Consequences

- Ramp p99 falls from 7.28 s to 174 ms, throughput from 44.7 to 61.6 req/s,
  dropped iterations from 1210 to zero.
- At 40 req/s the median lands on the embedding-free path, 127 ms against
  127 ms, and the spread narrows from 127–408 ms to 120–274 ms.
- **A residue remains.** p99 is 152 ms where the embedding-free path is 130 ms.
  That 22 ms is the thread hop — dispatching a task, copying 384 floats back —
  plus moments where the worker and the event loop want the same core. Bounded,
  and it does not grow with load.
- **Below contention the pool is a tax, not a saving.** At 20 req/s, where the
  event loop was never blocked, cache-off p99 goes from 152 ms to 227 ms and a
  cached response from 5.2 ms to 8.4 ms. The value is entirely in the region
  where queuing used to happen.
- **The bottleneck moved to the worker's own throughput.** At 100 req/s the
  gateway serves 99.3 req/s with no errors while the pool queue sits at its limit
  and cache writes are skipped. Answers are returned and not stored.
- `EMBEDDING_POOL_SIZE` stays configurable, worth raising where inference is
  single threaded or on a host with cores to spare beyond what onnxruntime
  consumes. Not a knob to turn up by default.

## On the queue limit

The queue is bounded at ten tasks per worker and overflow rejects rather than
waits. `CacheService` already treats an embedding failure as a cache miss, so
overflow degrades caching and never a request.

Same policy as the cache uses for Redis and the rate limiter for its counter:
**a component that exists to make things faster must not be able to make things
unavailable.** An embedding that begins after its caller has gone is waste, and
a cache write that never happens costs a future lookup rather than a present
request.

## Alternatives

**Leave it on the main thread and scale horizontally.** Rejected. It pays for a
fixable software problem with hardware, at roughly two instances for every one
otherwise needed.

**Batch embeddings off the request path.** Deferred, item 2 of the baseline's
list. Removes the cost from the request rather than relocating it, at the price
of a window where a just-answered prompt is not yet cacheable. Its benefit is
now smaller because the worst contention is gone.

**A dedicated inference host.** The correct answer at real scale, item 3 of the
same list. Converts CPU contention into a few milliseconds of network and makes
the pool size question disappear. Out of scope here, and this change is not an
argument against it.
