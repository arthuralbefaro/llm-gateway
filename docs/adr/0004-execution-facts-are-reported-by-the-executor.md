# 4. Execution facts are reported by whoever executed, not inferred afterwards

Status: accepted

## Context

The response tells callers whether a fallback happened. The first implementation
derived that flag by comparing the served model against the requested one:

```ts
fallback: result.model !== requestedModel;
```

The first live test disproved it. The primary provider was failing every
request, the backup answered, and the response said:

```
provider        : local-backup
model           : local-small
requested_model : local-small
fallback        : False
```

The most common fallback is another provider serving the **same** model, which
is also the best kind — the caller gets exactly the model they asked for. The
comparison sees two identical strings and reports nothing. The case worth
reporting most reported least.

## Why the check was doomed rather than merely wrong

`model !== requestedModel` is not a fact about what happened. It is a guess
reconstructed from a result, and the result does not contain the information.

The router knows exactly: it walked an ordered list of targets and knows which
index answered. By the time the value reaches the gateway that knowledge is
gone, and no inspection of the output brings it back.

The bug is also invisible in the shape most likely to be tested. With one
provider per model the two cases cannot be distinguished, so a green suite
proves nothing about this flag.

## Decision

The router reports `usedFallback` as part of its result, because the router
performed the routing.

Non-streaming calls carry it on the returned value. Streams get it through an
`onOpen` hook that fires as soon as a target is committed to, before any byte
reaches the client.

The general rule: **a fact about how something was produced is reported by the
component that produced it.** A consumer inspecting the result can only recover
what the result happens to encode, and that is decided by convenience, not by
what callers need to know.

## Consequences

- `usedFallback` is now true for a same-model provider switch, previously
  reported as false.
- The router's return types carry more than the answer. Latency, attempt records
  and fallback are all facts only the router holds.
- The streaming hook must fire on open, not on finish. An earlier version passed
  the served target through the finish callback, which runs after the last chunk
  is written, so the final chunk reported a provider of `unknown`. Reporting at
  the right time is part of reporting the right thing.
- Applies to anything else the gateway might reconstruct: whether a retry
  happened, which attempt succeeded, whether a cache hit was exact or semantic.
  All are already reported by their executor and none should be re-derived.

## Alternatives

**Compare provider as well as model.** Rejected. It fixes this instance and
leaves the method intact, so the next fallback dimension — a different region, a
different key, a retry on the same target — fails the same way.

**Have the gateway inspect the attempt records.** Rejected as a workaround that
happens to work. It is a longer path to a fact the router could simply state,
and it couples the gateway to the internal shape of attempt records.
