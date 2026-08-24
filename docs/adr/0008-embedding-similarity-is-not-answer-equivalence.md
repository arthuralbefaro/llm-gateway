# 8. Embedding similarity measures subject, not answer equivalence

Status: accepted

## Context

The semantic cache decides reuse by cosine similarity against a threshold of
0.95. That design has been in place since week 1 and had never been measured
against labelled data. ADR 0001 recorded one observation about cross-language
pairs from eleven hand-picked examples; nothing measured the same-language case.

The evaluation dataset is the first labelled measurement: 220 pairs over 20
topics in English and Portuguese, scored through the gateway's own embedding
path. Construction and biases are in `evals/data/README.md`.

One category exists to probe the assumption: **minimal pairs**, where the second
prompt differs by a small edit that changes the answer. Three kinds, all
labelled must-not-hit — **entity** (*coffee leaf rust* → *coffee berry borer*),
**negation** (*through its main cables* → *without using its main cables*), and
**temporal** (*in the 1960s* → *in the 2010s*).

## The inversion

| Category | n | min | p05 | p25 | **median** | p75 | p95 | max |
|---|---|---|---|---|---|---|---|---|
| `paraphrase` *(must hit)* | 40 | 0.8757 | 0.8876 | 0.9334 | **0.9441** | 0.9628 | 0.9754 | 0.9800 |
| `minimal_pair` *(must not)* | 40 | 0.8256 | 0.9015 | 0.9271 | **0.9515** | 0.9742 | 0.9843 | 0.9862 |
| `same_topic` *(must not)* | 40 | 0.8116 | 0.8127 | 0.8691 | 0.8912 | 0.9109 | 0.9431 | 0.9474 |
| `cross_lingual` *(must not)* | 40 | 0.8128 | 0.8252 | 0.8588 | 0.8820 | 0.9031 | 0.9204 | 0.9358 |
| `unrelated` *(must not)* | 60 | 0.7105 | 0.7394 | 0.7743 | 0.7962 | 0.8214 | 0.8418 | 0.8575 |

**The median of `minimal_pair` sits above the median of `paraphrase`.** The pairs
that must not be collapsed score higher than the pairs that must.

Not a narrow overlap. Every paraphrase falls inside the range the minimal pairs
span, and 34 of 40 minimal pairs fall inside the range the paraphrases span. The
ordering holds in both languages independently:

```
en   paraphrase 0.9441   minimal_pair 0.9509
pt   paraphrase 0.9450   minimal_pair 0.9548
```

Overlap against `paraphrase`, by category:

| Category | Separable by any threshold | Shared band | Pairs inside it |
|---|---|---|---|
| `minimal_pair` | no | 0.8757 to 0.9800 | 34 / 40 |
| `same_topic` | no | 0.8757 to 0.9474 | 28 / 40 |
| `cross_lingual` | no | 0.8757 to 0.9358 | 25 / 40 |
| `unrelated` | **yes** | none | 0 / 60 |

## The frontier

False positives and false negatives are never summed. A false negative costs a
provider call. A false positive returns an answer to a question nobody asked.

| Threshold | TP | FN | FP | TN | Precision | Recall | FP minimal | FP topic | FP cross | FP unrel |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.85 | 40 | 0 | 109 | 71 | 0.268 | 1.000 | 39 | 37 | 32 | 1 |
| 0.88 | 39 | 1 | 88 | 92 | 0.307 | 0.975 | 39 | 26 | 23 | 0 |
| 0.90 | 37 | 3 | 65 | 115 | 0.363 | 0.925 | 38 | 15 | 12 | 0 |
| 0.92 | 33 | 7 | 42 | 138 | 0.440 | 0.825 | 33 | 6 | 3 | 0 |
| **0.93** | 31 | 9 | 34 | 146 | **0.477** | 0.775 | 29 | 4 | 1 | 0 |
| 0.94 | 24 | 16 | 28 | 152 | 0.462 | 0.600 | 25 | 3 | 0 | 0 |
| **0.95** | 16 | 24 | 20 | 160 | 0.444 | 0.400 | 20 | 0 | 0 | 0 |
| 0.96 | 12 | 28 | 19 | 161 | 0.387 | 0.300 | 19 | 0 | 0 | 0 |
| 0.97 | 6 | 34 | 14 | 166 | 0.300 | 0.150 | 14 | 0 | 0 | 0 |
| 0.98 | 1 | 39 | 5 | 175 | 0.167 | 0.025 | 5 | 0 | 0 | 0 |
| 0.99 | 0 | 40 | 0 | 180 | n/a | 0.000 | 0 | 0 | 0 | 0 |

**Peak precision over the entire range is 0.477.** There is no good region, only
regions that are bad in different ways:

- **Below 0.90** buys recall by admitting 32 of 40 cross-lingual pairs and nearly
  every minimal pair.
- **0.92 to 0.94** is where precision peaks, still under half, with 7 to 16
  paraphrases already lost.
- **Above 0.97** drops recall to 0.15 while negations keep passing.
- **0.99** has zero errors on both sides because the semantic tier no longer
  exists.

Raw counts are weighted by how many pairs of each kind the dataset contains,
which is a property of how it was written. As rates the two curves cross near
0.95 at roughly **60% of paraphrases lost against 50% of minimal pairs
admitted** — both errors on the majority side at the same time.

No aggregate is reported in place of these two curves. F1 or accuracy would
average exactly the trade-off this measurement exists to expose.

## What 0.95 does today

```
true positives    16   paraphrases served from cache
false negatives   24   paraphrases costing a provider call
false positives   20   pairs served the wrong answer
true negatives   160   correctly refused
precision 0.444   recall 0.400
```

**All 20 false positives are minimal pairs.** `same_topic`, `cross_lingual` and
`unrelated` are each at zero.

That is the trap in the current value. The threshold looks calibrated because it
handles the easy categories perfectly — unrelated prompts and translations never
get through. What it cannot see is the one case where the prompts are nearly
identical and the answers are opposite, and that case supplies 100% of its
errors.

## Which edits the model misses

| Threshold | entity (n=20) | temporal (n=8) | negation (n=12) |
|---|---|---|---|
| 0.90 | 18 / 20 (90%) | 8 / 8 (100%) | 12 / 12 (100%) |
| 0.92 | 13 / 20 (65%) | 8 / 8 (100%) | 12 / 12 (100%) |
| 0.93 | 9 / 20 (45%) | 8 / 8 (100%) | 12 / 12 (100%) |
| 0.94 | 6 / 20 (30%) | 7 / 8 (88%) | 12 / 12 (100%) |
| **0.95** | 3 / 20 (15%) | 5 / 8 (62%) | **12 / 12 (100%)** |
| 0.97 | 0 / 20 (0%) | 3 / 8 (38%) | 11 / 12 (92%) |
| 0.98 | 0 / 20 (0%) | 0 / 8 (0%) | 5 / 12 (42%) |

Plotted against paraphrase recall, **entity sits entirely to the left of the
paraphrase curve and negation entirely to the right, at every threshold in the
range.** Entity swaps are rejected before paraphrases start being lost. Negations
are admitted more often than paraphrases everywhere.

**Treating `minimal_pair` as one category would hide that a third of it is
detectable and a third is invisible.** The aggregate median conceals two opposite
behaviours averaging into one unremarkable number.

The negations occupy the top of the whole dataset:

```
0.9856  How does a suspension bridge carry load through its main cables?
        How does a suspension bridge carry load without using its main cables?

0.9843  Como uma ponte pênsil transfere carga pelos cabos principais?
        Como uma ponte pênsil transfere carga sem usar os cabos principais?

0.9862  Por que a osmose reversa precisa de alta pressão para dessalinizar água?
        Por que a osmose reversa funciona sem alta pressão para dessalinizar água?
```

The bridge pair scores higher than every paraphrase in the dataset, and the two
questions are opposites.

## The structural conclusion

**Embedding similarity measures how close two prompts are in subject matter, not
whether they have the same answer.**

The model is doing what it was trained to do. `multilingual-e5-small` is a
retrieval model: it places a query near the documents relevant to it. Under that
objective a question and its negation *should* be close, because they are
relevant to the same material. The word *without* barely moves the vector
because it barely changes what the question is about.

A cache asks a different question — may I return this stored answer instead of
calling the provider — and that is about answer equivalence. Proximity of
subject and equivalence of answer are different relations, and the first does not
imply the second.

**This is a choice-of-signal problem, not a calibration problem.** A threshold is
one scalar cut through one metric, and it can only work if the metric orders
should-hit above must-not-hit. The ordering is inverted, so no value produces an
acceptable classifier.

## Relation to ADR 0001, which stands unaltered

ADR 0001 concluded that no threshold separates same-language paraphrase from
cross-language translation, on a band of 0.0017 measured over eleven pairs.
**Confirmed at scale.** Over 40 cross-lingual pairs against 40 paraphrases, the
cross-lingual maximum is 0.9358 and the paraphrase minimum is 0.8757: still
overlapping, still no cut.

What changes is emphasis, and it is recorded here rather than edited into 0001.
That ADR is an accurate record of what was knowable from eleven pairs, and the
contrast between eleven and eighty is part of this result.

**The current value is right for the wrong reason.** ADR 0001 justifies 0.95 as
sitting 0.022 above every measured cross-language pair. The sweep confirms that
margin — cross-lingual false positives reach zero at 0.94 — but the threshold's
real work at 0.95 is nothing to do with language. Every error it makes is a
minimal pair, a category 0001 never measured.

One consequence listed in 0001 is now known to understate: *"The threshold
rejects unrelated prompts and loose paraphrases."* It rejects 60% of all
paraphrases, not only the loose ones.

The ordering ADR 0001 implied is also reversed. Cross-lingual pairs sit *below*
the paraphrases they were feared to be confused with, while minimal pairs sit
*above* them:

```
cross_lingual  0.8820
paraphrase     0.9441
minimal_pair   0.9515
```

## The dataset's bias, and why the conclusion survives it

The pairs were written by the person building the gateway, who already knew
roughly how the model behaves, with no second annotator and minimal pairs that
are adversarial by construction. All of it is recorded in
`evals/data/README.md`.

That bias would undermine a claim about rates in production. No such claim is
made here.

The claim is about **whether a separating threshold exists**, and it runs in the
direction the bias cannot help. The paraphrases were written to be recognisable
as paraphrases, the easiest version of the should-hit case, and they still do not
separate. **If pairs written to be easy cannot be separated, harder ones drawn
from real traffic will not do better.** A biased dataset that fails to find
separation is stronger evidence than an unbiased one, because the bias was
pushing towards finding it.

The counterpart is equally true: nothing here says how *often* a real user sends
a negated variant of a cached question. That needs traffic.

## Decision

**Recorded, not yet acted on.** The current signal cannot support the current
decision. What replaces it waits on the language-partitioning measurement, and
any proposal made now would be guesswork dressed as a plan.

The gateway is unchanged. It continues at 0.95 with the behaviour measured
above, which is now a documented property rather than an assumption.

Directions that exist, none endorsed:

- **Raise the threshold.** Moves along the frontier rather than off it.
- **A second check after the vector search.** The candidate is already
  retrieved, so a cheap comparison could reject edits the embedding misses.
- **Narrow what is cached.** Drop the semantic tier and keep exact matching,
  which is unaffected by any of this and always correct.
- **A different model or objective.** A model trained for sentence equivalence
  rather than retrieval, measured against this dataset before adoption, with the
  parity discipline of ADR 0007.

## Is there a cheap signal for negation specifically

Partly, and it was measured rather than assumed. `evals/scripts/probe_negation.py`
tests a closed set of negation markers in both languages — *not*, *without*,
*never*, *n't*, *não*, *sem*, *nunca*, *nem* — and flags a pair when one side
carries one and the other does not. The marker list was fixed before looking at
which pairs it catches.

Over the whole dataset it flags **8 of 12** negation minimal pairs and **1 of 40**
paraphrases. Restricted to the 36 pairs the 0.95 threshold actually admits, which
is the only place such a check would run:

```
paraphrases still served      16
paraphrases newly rejected     0
wrong answers now refused      8
wrong answers still served    12
```

At that operating point it is free: it refuses 8 of the 20 wrong answers and
costs nothing on the correct side.

**The limit is what it cannot see.** The four negations it misses are the ones
not marked by a token:

```
What does rent control do to the supply of rental housing?
What does removing rent control do to the supply of rental housing?

What makes a concert hall sound good for orchestral music?
What makes a concert hall sound bad for orchestral music?
```

*Removing* is a verb, *good* against *bad* is an antonym. Neither is negation in
the lexical sense, and both reverse the answer completely. A marker list catches
syntactic negation and is blind to semantic inversion.

Two further limits, stated because the number above flatters the idea. The
marker list is per language, which couples it to the language question. And the
12 negation pairs are lexically marked because they were *written* that way — the
8-of-12 figure measures the dataset's construction as much as the technique.

So: a path exists, it is cheap, it is bounded, and it is not a solution. It
addresses one third of one category. Nothing about it is proposed here.

## Consequences

- Saving figures from the analytics endpoint include semantic hits, some
  fraction of which answered a different question. The methodology already ships
  an interval rather than a point estimate; this is another reason not to read
  it as a single number.
- Any future threshold change must cite the sweep rather than intuition.
- This dataset is the regression test for whatever replaces the current
  approach. A proposal that cannot separate these categories is not an
  improvement, whatever it does to the hit rate.
