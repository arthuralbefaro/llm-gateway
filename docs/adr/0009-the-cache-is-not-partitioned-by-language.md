# 9. The cache is not partitioned by language

Status: accepted

## Context

ADR 0001 left this open: *"Partition entries by language. The correct fix,
deferred to the eval week so it can be decided against measured hit rates rather
than eleven hand-picked pairs."* It also fixed the order in which the options
had to be evaluated, cheapest first — is the signal already in the embedding we
compute, does a light classifier over the loaded model solve it, and only if
both fail, a new dependency with its cost declared.

The measurement exists now: 220 labelled pairs over 20 topics in English and
Portuguese, plus the 160 embeddings behind them.

## The signal is already in the embedding

Nearest centroid, leave one out over all 160 texts. Two mean vectors and a dot
product, nothing trained.

```
accuracy      1.0000
en            1.0000
pt            1.0000
margin min    0.0176
margin median 0.0456
misclassified none
```

No text sits near the decision boundary. The cost is **2.7 µs per prompt**
measured over 200 000 runs, which is 768 multiply-adds against the roughly 40 ms
the embedding already takes on the worker thread.

The order stops here. The first option succeeded, so no classifier was trained
and no dependency was evaluated.

## The signal survives a shared topic

The first measurement of the language signal came from the unrelated controls,
where the two sides also differ in subject. That number risked being flattered
by the difference of topic, so both regimes were measured, paired by topic so
nothing else moves:

| Regime | n | median gap | min | max | at or below 0 |
|---|---|---|---|---|---|
| topic distinct *(unrelated controls)* | 20 | 0.0425 | 0.0202 | 0.0620 | 0 |
| topic shared *(same question)* | 20 | **0.0490** | −0.0055 | 0.1242 | **3** |

The gap is how much similarity drops when only the language changes.

**It does not submerge.** The shared-topic gap is larger, not smaller, so the
earlier 0.0360 was pessimistic rather than optimistic.

**But in 3 of 20 topics the cross-language pair outscored the same-language
paraphrase.** The pair-level signal is noisy and sometimes inverts.

The per-prompt readout does not, and the reason is worth recording: **a
similarity collapses 384 dimensions into one scalar, while the centroid uses the
direction.** Language occupies a direction in the space that survives being
averaged with everything else; it does not survive being projected onto the one
axis that connects two particular prompts. A measurement that only compares
pairs will understate how recoverable language is.

## What a partition would buy: nothing

| Threshold | Recall | FP no partition | FP partitioned | Removed |
|---|---|---|---|---|
| 0.88 | 0.975 | 88 | 65 | 23 |
| 0.90 | 0.925 | 65 | 53 | 12 |
| 0.92 | 0.825 | 42 | 39 | 3 |
| 0.93 | 0.775 | 34 | 33 | 1 |
| 0.94 | 0.600 | 28 | 28 | **0** |
| **0.95** | 0.400 | 20 | 20 | **0** |

Holding false positives at today's budget of 20, the lowest viable threshold
**with** a partition is still 0.9500: recall 0.400, 24 paraphrases lost,
identical to today.

**A partition recovers 0 of the 24 paraphrases the cache currently misses.**

The reason is in ADR 0008. Every false positive at 0.95 is a minimal pair, and
minimal pairs are intra-language. The binding constraint is inside each
language, where a partition cannot reach.

Top-one retrieval over the whole corpus agrees: 17 of 160 texts have a
nearest neighbour in the other language, and **none of them reach 0.95**. No
cross-language hit is available to prevent.

Paraphrase hit rate at 0.95 is 8/20 in English and 8/20 in Portuguese. A
partition changes neither, because every paraphrase is intra-language by
construction.

## Decision

**Do not partition the cache by language.**

The justification is not cost and not feasibility — both are favourable. The
signal is free and perfect. It is that a partition removes a category the
current threshold already drives to zero, so it buys nothing that is not already
bought.

Nothing is built. `CacheEntry` gains no language column and the lookup is
unchanged.

## The condition that reverses this

The partition's value is real and entirely masked. Counting only the false
positives a partition could reach, with minimal pairs excluded as though some
other check already caught them:

| Threshold | Recall | FP no partition | FP partitioned |
|---|---|---|---|
| 0.86 | 1.000 | 62 | **34** |
| 0.88 | 0.975 | 49 | **26** |
| 0.90 | 0.925 | 27 | **15** |
| 0.92 | 0.825 | 9 | 6 |
| 0.95 | 0.400 | 0 | 0 |

This table is conditional and describes no system that exists.

**The trigger: if any mechanism starts rejecting minimal pairs, revisit this
immediately.** With that constraint lifted, a partition roughly halves the
remaining false positives at 0.88 to 0.90, where recall is 0.925 to 0.975
instead of today's 0.400. The classifier is already measured, already free, and
needs no new dependency.

## Consequences

- ADR 0001's open alternative is closed, and 0001 is not edited. It deferred
  this to be decided against measured hit rates, and it has been. What 0001
  could not know is that language was never the main correctness risk, because
  minimal pairs were not measured until ADR 0008.
- The same-question-two-languages behaviour ADR 0001 describes still holds:
  cross-language traffic occupies two rows. That happens through the threshold
  rather than through a partition, which is a weaker guarantee — it depends on
  the threshold staying at or above 0.94, where cross-lingual false positives
  reach zero. **Lowering the threshold reintroduces them, and this ADR is the
  record that a partition is the cheap fix if that ever happens.**
- `evals/scripts/language_report.py` reproduces every number here, and the
  findings are asserted in `evals/tests/test_language.py`, so a change to the
  dataset or the runtime that overturns them fails the suite rather than
  silently changing a chart.
