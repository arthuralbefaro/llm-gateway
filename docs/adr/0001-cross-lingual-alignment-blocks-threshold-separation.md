# 1. Cross-lingual alignment blocks threshold separation in the semantic cache

Status: accepted

## Context

The semantic cache decides reuse by cosine similarity against a single
threshold, `CACHE_SIMILARITY_THRESHOLD`. The model is
`Xenova/multilingual-e5-small`, chosen because the gateway serves English and
Portuguese. A monolingual English model would have failed in Portuguese without
raising an error: the only symptom is a low hit rate, which points nowhere near
its cause.

Two classes of pair matter. **Paraphrase in the same language** must be served
from cache. **The same question in another language** must not — a Portuguese
question answered from an English entry returns an answer in the wrong language,
which is a wrong answer.

## Measurements

`Xenova/multilingual-e5-small` at `q8`, mean pooling, L2-normalized, the
`query: ` prefix, and the cache's own normalization (content only, lowercased,
whitespace collapsed).

Must be accepted:

| Similarity | Pair |
|---|---|
| 0.9854 | `qual é a capital da frança?` / `que cidade é a capital da frança?` |
| 0.9853 | `how do i reverse a string in python?` / `what is the way to reverse a string using python?` |
| 0.9850 | `what is the capital of france?` / `which city is the capital of france?` |
| 0.9768 | `como eu inverto uma string em python?` / `qual a forma de inverter uma string usando python?` |
| 0.9382 | `escreva um haicai sobre o mar` / `componha um haicai sobre o oceano` |
| 0.9292 | `write a haiku about the sea` / `compose a haiku on the ocean` |

Must be rejected:

| Similarity | Pair |
|---|---|
| 0.9275 | `what is the capital of france?` / `qual é a capital da frança?` |
| 0.9202 | `write a haiku about the sea` / `escreva um haicai sobre o mar` |
| 0.9160 | `which city is the capital of france?` / `qual é a capital da frança?` |
| 0.9095 | `how do i reverse a string in python?` / `como eu inverto uma string em python?` |
| 0.9081 | `what is the capital of france?` / `que cidade é a capital da frança?` |

Controls:

| Similarity | Pair |
|---|---|
| 0.9050 | `what is the capital of france?` / `what is the capital of germany?` |
| 0.7264 | `what is the capital of france?` / `how do i bake sourdough bread?` |

Accept range **0.9292 to 0.9854**, reject range **0.9081 to 0.9275**. The
separating band is **0.0017 wide**.

## Why this is structural

A multilingual encoder is trained so a sentence and its translation land close
together. That is the objective, not a side effect, and it is why this model
handles Portuguese where an English-only model does not.

A cache wants the opposite: paraphrase within a language near, translation
across languages far. No threshold resolves a conflict in the objective.

The control makes the size concrete. `capital of france` versus `capital of
germany` scores 0.9050, **lower than four of the five cross-language pairs**. A
threshold permissive enough to admit a translation already admits a different
country.

The 0.0017 band is not a margin to tune within. It is the width of the noise
between two overlapping distributions sampled at eleven points.

## Decision

Set `CACHE_SIMILARITY_THRESHOLD` to **0.95** and treat threshold tuning as
unable to solve this class of error.

0.95 sits 0.022 above every measured cross-language pair. It gives up the
loosest paraphrases: the haiku pair at 0.9292 and the Portuguese one at 0.9382
now miss.

That trade is deliberate and asymmetric. **A miss costs one provider call. A
wrong answer is a correctness bug** that reaches the user, is not logged as a
failure, and looks like the model behaving badly rather than the cache
misfiring.

## Consequences

- Cross-language traffic never shares entries. The same question in two
  languages occupies two rows, which is correct.
- The threshold rejects unrelated prompts and loose paraphrases. It is not, and
  cannot be, the mechanism that keeps languages apart.
- Anything that adds text shared by both sides of a comparison inflates
  similarity and eats the margin. See ADR 0002.
- The eval suite must report hit rate per language. An aggregate hides whichever
  language performs worse.

## Alternatives

**Partition entries by language.** The correct fix, deferred to the eval week so
it can be decided against measured hit rates rather than eleven hand-picked
pairs. Deferred rather than rejected because the obvious implementation adds a
language-detection dependency, and cheaper options exist: deriving a language
signal from the embedding already computed, or a light classifier over the model
already loaded.

**A higher threshold.** Rejected. Clearing the cross-language pairs with real
margin lands near 0.95, which is where it is; pushing further discards ordinary
paraphrases and degrades the cache into an expensive exact-match lookup. It also
treats a distribution overlap as a tuning problem — the overlap is in the
model's objective and reappears with different prompts.

**A monolingual model per language.** Rejected for now. Removes the conflict
outright, but costs one model per supported language plus routing, and still
needs the language detection that partitioning needs. If partitioning turns out
to require detection anyway, revisit.

**Accept cross-language hits.** Rejected. The cache's value rests on callers
being unable to tell a hit from a miss.
