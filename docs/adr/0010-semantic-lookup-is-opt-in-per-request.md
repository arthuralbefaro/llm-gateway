# 10. Semantic lookup is opt-in per request

Status: accepted

## Context

ADR 0008 established that at the production threshold of 0.95 the semantic
cache serves the wrong answer on 20 of 40 minimal pairs while missing 24 of 40
paraphrases, and that peak precision over the whole threshold range is 0.477.
The system was running with a known defect the caller could not see.

Five options were priced on the labelled dataset
(`evals/scripts/decision_report.py`) before anything was built.

## The five options, priced

**Keep 0.95 and declare the limitation.** Behaviour unchanged: 16 right, 24
lost, 20 wrong answers still shipping. Declaring does not restore the caller's
ability to act — they cannot verify equivalence without paying exactly the
provider call the cache saved. The check costs the thing being saved.

**Raise the threshold.**

| Threshold | TP | FN | FP | FP cut | TP cut |
|---|---|---|---|---|---|
| 0.95 | 16 | 24 | 20 | — | — |
| 0.96 | 12 | 28 | 19 | 5% | 25% |
| 0.97 | 6 | 34 | 14 | 30% | 62% |
| 0.98 | 1 | 39 | 5 | 75% | 94% |

Every step cuts correct hits faster than wrong ones, because negations occupy
the top of the distribution and die last. The first threshold with zero wrong
answers is 0.9875, where recall is 0.000. Raising the threshold is switching
the tier off in slow motion, passing through every bad configuration on the
way.

**Negation filter after the vector search.** At 0.95 it is free — zero
paraphrases lost, 8 of 20 wrong answers removed, precision 0.444 → 0.571. Its
ceiling is structural: the 8-of-12 catch rate measures the dataset's own
construction (the negations were written lexically marked), it is blind to
unmarked inversion (*good* → *bad*, *removing X*), to entity swaps and to
temporal shifts, and best achievable precision stays below 0.58. One in three
admitted hits on the adversarial set is still a wrong answer after the filter.

**Restrict to a high-similarity band.** Does not exist, and the way it fails is
the strongest number of the analysis. Precision by band, inside the acceptance
region:

| Similarity band | Hits | Right | Wrong | Precision |
|---|---|---|---|---|
| 0.95–0.96 | 5 | 4 | 1 | 0.800 |
| 0.96–0.97 | 11 | 6 | 5 | 0.545 |
| 0.97–0.98 | 14 | 5 | 9 | 0.357 |
| 0.98–1.00 | 6 | 1 | 5 | **0.167** |

**Precision falls monotonically as similarity rises.** Inside its own
acceptance band the metric is anti-correlated with being right. Nearly
identical does not mean safe — it means the edit was too small for the model to
see, and a tiny edit with a different answer is the definition of a minimal
pair. This kills the band option and the threshold option in one stroke, and
dismantles the intuition that being stricter helps.

**Drop the semantic tier, keep exact.** Eliminates the error class by
construction. Measured cost: 17 of 306 hits in the one exported k6 run were
semantic (5.6%, a scenario parameter rather than demand), each saving 93 ms of
median latency and one provider call; on the dataset, the 16 paraphrases 0.95
serves are forfeit. The exact tier — 289 of 306 hits, always correct — is
untouched either way.

## Decision

**Semantic lookup runs only when the request asks for it.** The `cache` field
extends the existing pattern (`cache: false`, the fallback opt-out):

| Value | Reads |
|---|---|
| omitted or `true` | exact only — the new default |
| `"semantic"` | exact, then nearest neighbour |
| `false` | nothing |

Every mode still writes, and the HNSW index stays: callers who opt in benefit
from the fully populated table, and the object of study keeps existing.

When a semantic hit is served, the response declares `cache_kind` and
`cache_similarity`. The caller knows what they received and how near the
neighbour was — with the band table above documented in `docs/api.md` as the
reason a high similarity is not reassurance.

Without the flag, the read path no longer embeds at all. The default lookup is
one Redis GET.

## Why the caller decides

ADR 0001 already priced the asymmetry: a miss costs one provider call, a wrong
answer is a correctness bug that reaches a user. **The party able to price that
trade is the caller, not the gateway.** A batch summarisation pipeline
tolerates near-duplicate answers; a support bot does not; the gateway cannot
know which one it is serving. Until now it decided for both, using a classifier
the band table shows is anti-correlated with correctness where it is most
confident.

Opt-in converts a silent defect into an informed choice. The declared
limitation (option one) rides along for free: the flag documentation carries
the measured precision, and the response carries the similarity.

## Consequences

- Default semantic volume drops to near zero. Metrics and dashboards keep
  exact and semantic separated; the Grafana cache panels and the dashboard note
  now state that a near-zero semantic line is the default working as designed.
- The `bypassed` metric label is unchanged; a default lookup that finds no
  exact entry records `miss` as before.
- The negation filter is recorded as a future refinement of the opt-in path,
  not built: it would raise opt-in precision from 0.444 to 0.571 at zero recall
  cost, within the limits stated above. It does not change the default and it
  does not rescue the signal.
- ADR 0009's reversal trigger is untouched. Opt-in does not reject minimal
  pairs, so the language partition stays dormant.
- The evaluation dataset is the regression test for this decision: any future
  claim that the semantic tier became safe must show these categories
  separating.
