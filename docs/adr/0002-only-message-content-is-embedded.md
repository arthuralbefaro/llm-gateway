# 2. Only message content is embedded, never role labels

Status: accepted

## Context

Before a prompt is embedded it is normalized into a single string. The first
implementation prefixed every message with its role, to keep an assistant turn
distinguishable from a user turn inside the embedded text:

```
user: what is the capital of france?
```

The cache then started serving English answers to Portuguese questions. The
threshold was 0.92 and the English/Portuguese pair had been measured at 0.8981,
so on paper the hit was impossible.

## What actually happened

0.8981 was the similarity of the two *raw* sentences. The cache compares the two
*normalized* strings, and normalization had added `user: ` to both.

Same pair, `what is the capital of france?` against `qual e a capital da
franca?`:

| Embedded text | Similarity | Verdict at 0.92 |
|---|---|---|
| Raw sentence | 0.8981 | rejected, correct |
| With the `user: ` role prefix | **0.9306** | accepted, wrong |
| Content only | 0.9147 | rejected, correct |

The role label moved the pair **+0.0325**, across the threshold.

The mechanism is general. Cosine measures the angle between two vectors.
Prepending the same tokens to both inputs contributes the same direction to
both, rotating them toward each other. The more of the embedded text is shared
boilerplate, the smaller the share of signal from the part that differs. Short
prompts are most of what a chat gateway sees, and a six-character prefix is a
large fraction of a short input.

Any constant added to both sides inflates the score: role labels, a system prompt
repeated into the embedded text, a template wrapper, a `Question:` prefix.

It is easy to miss because the number never looks wrong. Nothing throws, nothing
is logged, and the only symptom is hits that should not have happened — which is
indistinguishable from a threshold set too low. We reached for the threshold
first and were wrong to.

## Decision

Embed message content only. Role labels are dropped before the text reaches the
model.

The role stays part of the exact-match hash, so a prompt differing only in who
said what remains a distinct key. Nothing is lost for exact matching.

## Consequences

- The numbers in ADR 0001 were all remeasured after this fix.
- The margin this bug consumed is available again. Not enough to save
  threshold-based language separation, but real.
- Any change to normalization changes the meaning of every stored embedding.
  Stored entries were embedded under the old rule.
- The rule when touching normalization: if a piece of text appears in every
  prompt, it carries no information about this prompt and must not be embedded.

## Alternatives

**Keep role labels and raise the threshold.** Rejected. The required
compensation is not constant — it depends on prompt length, so short prompts
stay over-matched while long ones become under-matched.

**Embed each message separately and combine the vectors.** Rejected as more
machinery than the problem needs. No requirement depends on role structure
surviving into the vector.

**Keep role labels only for multi-turn prompts.** Rejected. The same pair would
be judged differently as a conversation grows. A rule that changes under the
caller's feet is worse than one that discards a little structure.
