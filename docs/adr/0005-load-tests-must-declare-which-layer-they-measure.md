# 5. Load tests must declare which layer they measure

Status: accepted

## Context

The gateway answers from three places: a Redis lookup on an exact prompt hash, a
vector search over stored embeddings, and the provider. They differ by roughly
two orders of magnitude — single-digit milliseconds, tens of milliseconds,
hundreds or more.

A load test that does not control which one it exercises measures whichever
layer its traffic landed on, and reports the number as if it described the
system.

Found while building the circuit breaker demonstration, twice, in one afternoon.

## The two mistakes

**Sending the same prompt every time.** The first request reached the provider;
every one after it was an exact cache hit and never touched a provider. The
breaker's failure counters froze, and the display appeared to show a breaker
that refused to count failures. The bug was not in the breaker. Obvious in
hindsight, and the kind of thing a review catches.

**Sending sequentially numbered prompts.** The fix made each prompt unique:
`breaker probe number 1`, `breaker probe number 2`. Every string was distinct,
so the exact-hash layer was genuinely defeated. The counters still did not move.

The embedding does not care about the digit. Those two prompts differ in one
character out of twenty-two, and their cosine sits far above the 0.95 threshold,
so the second request was a **semantic** hit.

This is the dangerous one. A reviewer asking whether the prompts are different
gets a truthful yes. Uniqueness of strings is not uniqueness of meaning, and the
semantic cache matches on the second.

## Why this is worse than an ordinary bug

Nothing errors. No warning, error rate zero, status codes all 201, and the
numbers **improve**: latency drops, throughput rises. A benchmark corrupted this
way does not look broken, it looks like a success.

Every other failure in this project announced itself. This one flatters you, and
the incentive to investigate a result that makes the system look good is close
to zero. Hence a mechanism rather than vigilance — the numbers from the
load-testing week are the claim this project makes about itself, and an
uncontrolled hit rate makes them fiction.

## Decision

**Every scenario declares a target cache hit rate, and the report states the
measured rate beside the latency figures.** A latency number published without
the hit rate that produced it is incomplete, the way a p99 without throughput is
incomplete.

**A scenario measuring the provider path guarantees a near-zero hit rate by
construction and proves it in the report**, from the gateway's own accounting
rather than the intent of whoever wrote the scenario.

**Prompts are generated with real entropy, never from a sequence.** The failure
generalises to any scheme where consecutive prompts differ in a small regular
way: counters, timestamps, incrementing ids, padded indices.

**Partial rates come from mixing a controlled proportion of repeated prompts
into that stream**, which makes the rate a dial rather than an accident.

## Consequences

- Reported latency is worse than an uncontrolled test would have produced. That
  is the point.
- The gateway reports `cache_hit` per response and stores `cacheHit` per row, so
  the measured rate comes from the system under test.
- A scenario whose measured rate does not match its declared target is a failed
  run, not a result to interpret.
- The same trap applies to any future evaluation over this system, including the
  cache quality evals: prompt sets built by templating one sentence with
  substitutions produce semantic near-duplicates by construction.

## On using temperature to force misses

A request with `temperature` above zero bypasses the cache by design, because a
caller asking for variation should not be handed a replay. That was used to get
clean breaker measurements, and it worked.

**It is not the right mechanism for load tests.** Four reasons:

1. It is a side effect, not a contract. Nothing states that load tests depend on
   it, so the coupling is invisible.
2. `CACHE_ALLOW_NONZERO_TEMPERATURE` exists and flips it. Setting it would make
   every load test silently start measuring the cache again — this exact
   failure, reintroduced by an unrelated configuration change.
3. It changes the request being tested. Temperature reaches the provider, so the
   scenario no longer exercises the same call the default path does.
4. It cannot express a partial rate. It is a switch, and hit rate is a dial.

Entropy stays the dial. Scenarios needing a guaranteed zero should use **an
explicit per-request cache opt-out**, expressed the way the fallback opt-out
already is: independent of cache configuration, and useful to real callers who
want a fresh answer. That flag does not exist yet, so until it does entropy
carries the whole job and scenarios prove the resulting rate from the gateway's
accounting.
