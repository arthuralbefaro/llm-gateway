# 7. The same ONNX file is not the same model across runtimes

Status: accepted

## Context

The evaluation suite was to be written in Python, measuring the same model the
gateway serves. It loaded the exact artefacts the gateway had already
downloaded: `model_quantized.onnx` (112.8 MB) and `tokenizer.json` (16.3 MB).
Same files, same `query:` prefix, same mean pooling. The parity check was a
formality.

It failed at cosine 0.9895 between vectors that should have been identical.

## What was found

Token ids were dumped from both runtimes across nine texts covering English,
Portuguese with and without diacritics, an empty string, a single character, and
a long sequence. **9 of 9 identical.** The inputs were never in question.

Graph optimisation level accounts for most of the gap. Python's `onnxruntime`
defaults to `ORT_ENABLE_ALL`, which fuses quantised operators more aggressively
than `onnxruntime-node`. Same input, varying only the level, against Node:

| Level | Max abs diff |
|---|---|
| `ORT_DISABLE_ALL` | 7.15e-07 |
| `ORT_ENABLE_BASIC` | 7.15e-07 |
| `ORT_ENABLE_EXTENDED` | 7.99e-02 |
| `ORT_ENABLE_ALL` (default) | 7.99e-02 |

Five orders of magnitude from a session option unrelated to the model.

Runtime version was tested and cleared. `onnxruntime-node` is 1.24.3, Python's
was 1.29.0, so it was pinned to `1.24.*`. Identical numbers before and after.
The pin was kept anyway: matching the gateway's runtime is right regardless.

## What is not explained

With `BASIC` set, version pinned, tokens verified, each text encoded alone so no
padding is involved:

| Text | Max abs diff | Cosine |
|---|---|---|
| `What is the capital of France?` | 8.20e-08 | 1.000000 |
| `Qual é a capital da França?` | 8.94e-08 | 1.000000 |
| `explain the main mechanism behind…` | 4.84e-08 | 1.000000 |
| `Qual e a capital da Franca?` | 9.54e-03 | 0.998060 |
| `escreva um haicai sobre o mar` | 8.61e-03 | 0.998226 |
| `Uma frase com acentuação, cedilha e til…` | 8.48e-03 | 0.998655 |
| `A much longer prompt that runs past…` | 9.68e-03 | 0.998822 |
| `a` | 1.51e-02 | 0.995288 |
| *(empty string)* | 1.63e-02 | 0.993662 |

Three texts agree to float precision, six disagree by around 1e-02. No cause
found.

Not length: rows 1 and 4 are both twelve tokens and land on opposite sides. Not
diacritics: the accented Portuguese matches, the unaccented one does not. Not
padding, not the tokenizer, not the version, not the optimisation level — the
three exact matches rule that out.

One observation that does not explain it: transformers.js does not emit
`token_type_ids`, while the graph requires them, so it synthesises them
internally. Supplying zeros gave the results above.

Recorded as unexplained rather than attributed to a guess. Naming a plausible
cause without evidence would make the next person stop looking.

## Why it is disqualifying

Not the absolute difference. A cosine of 0.998 between two encodings of the same
text sounds like agreement.

What decides is the comparison against what the measurement must resolve.
Converting the vector disagreement into the quantity the suite consumes — cosine
similarity **between pairs** — over all 36 pairs:

```
max   8.16e-03
mean  2.80e-03
p95   7.81e-03
```

ADR 0001 measured the band separating same-language paraphrase from
cross-language translation at **0.0017**. The runtimes disagree by up to 0.0082
on the same pair, nearly five times that band. Any threshold conclusion at that
resolution is an artefact of which runtime produced the number.

Degenerate inputs are not the excuse. The worst offenders are the empty string
and a single character, but the real sentence pair from ADR 0001 disagrees by
4.86e-03:

```
"What is the capital of France?" / "Qual e a capital da Franca?"
  node 0.8981   python 0.9029   delta 4.86e-03
```

Node reproduces ADR 0001 exactly. Python does not, and is still close to three
times the band.

## Decision

**The runtime that serves the model computes the numbers the suite measures.**

Embedding and similarity happen in Node, through the gateway's own code path.
Python consumes results and never loads ONNX. The project stays on uv, ruff and
pytest: that instruction was about managing the Python project, not about which
process performs inference.

The handoff is an explicit versioned file carrying the numbers and a description
of what produced them: model id, quantisation, runtime version, graph
optimisation level. A results file with implicit provenance cannot be compared
with another one later.

**The same ONNX file does not imply the same result.** A quantised graph
describes a computation; what it computes depends on the runtime's version,
execution provider and optimisation level. The check is cheap — encode a handful
of texts in both, compare. Verify parity before building on it, not after
publishing.

## Consequences

- The suite needs Node. `uv sync` alone does not reproduce the numbers.
- The stored vectors in `CacheEntry` came from the Node runtime. Anything that
  recomputes them — a re-index, a migration, a batch job in another language —
  must use the same runtime or the table silently shifts relative to the queries
  matched against it.
- Any future component reading embeddings produced elsewhere inherits this.

## Rejected

- **Keep digging until the residual is explained.** Worth doing if the hybrid
  design stops being available. The obvious hypotheses were each tested; what
  remains needs session-level introspection of onnxruntime-node. Real cost
  against a problem the hybrid design removes outright.
- **Accept the divergence under a declared tolerance.** A tolerance is honest
  only when smaller than the effect being measured. This one is five times
  larger.
- **Reimplement in Python from the PyTorch weights.** If the same file through a
  different runtime diverges this much, different weights through a different
  framework cannot be closer.
