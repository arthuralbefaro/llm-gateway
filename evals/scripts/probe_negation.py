"""measures whether a closed set of negation markers separates what the embedding cannot

a probe, not a proposal. It answers one question with a number: if the two sides
of a pair disagree on whether a negation marker is present, how much of the
dataset does that catch and how much does it wrongly reject

    uv run python scripts/probe_negation.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from evals.dataset import Pair, load_results  # noqa: E402

# closed class in both languages, chosen before looking at which pairs it catches
MARKERS = {
    "en": {
        "not",
        "no",
        "never",
        "without",
        "nor",
        "neither",
        "cannot",
        "refuse",
        "refused",
        "refuses",
        "fail",
        "fails",
        "failed",
        "lack",
        "lacks",
    },
    "pt": {
        "não",
        "nao",
        "nunca",
        "jamais",
        "sem",
        "nem",
        "recusa",
        "recusam",
        "recusaram",
        "recusou",
        "falta",
        "faltam",
        "deixa",
        "deixam",
    },
}

TOKEN = re.compile(r"[\w']+", re.UNICODE)


def markers_in(text: str, lang: str) -> set[str]:
    tokens = {t.lower() for t in TOKEN.findall(text)}
    found = tokens & MARKERS[lang]
    # english contractions carry the negation in the suffix
    found |= {t for t in tokens if t.endswith("n't")}
    return found


def polarity_differs(pair: Pair) -> bool:
    left = bool(markers_in(pair.left, pair.left_lang))
    right = bool(markers_in(pair.right, pair.right_lang))
    return left != right


def main() -> None:
    results = load_results()

    buckets: dict[str, list[bool]] = {}
    for item in results.scored:
        pair = item.pair
        key = (
            f"{pair.category}/{pair.note}"
            if pair.category == "minimal_pair"
            else pair.category
        )
        buckets.setdefault(key, []).append(polarity_differs(pair))

    print("pairs whose two sides disagree on the presence of a negation marker")
    print(f"{'group':<24}{'flagged':>10}{'n':>5}{'share':>8}")
    for key in sorted(buckets):
        flags = buckets[key]
        share = sum(flags) / len(flags)
        print(f"{key:<24}{sum(flags):>10}{len(flags):>5}{share:>8.0%}")

    paraphrase = buckets["paraphrase"]
    negation = buckets["minimal_pair/negation"]
    print()
    print(f"caught among negation minimal pairs   {sum(negation)}/{len(negation)}")
    print(f"wrongly flagged among paraphrases     {sum(paraphrase)}/{len(paraphrase)}")

    # the check would only ever see pairs the threshold already admitted, so the
    # rate that matters is the one restricted to those
    admitted = [item for item in results.scored if item.similarity >= 0.95]
    kept = [i for i in admitted if i.pair.should_hit and not polarity_differs(i.pair)]
    lost = [i for i in admitted if i.pair.should_hit and polarity_differs(i.pair)]
    caught = [i for i in admitted if not i.pair.should_hit and polarity_differs(i.pair)]
    served = [
        i for i in admitted if not i.pair.should_hit and not polarity_differs(i.pair)
    ]
    print(f"\nat the 0.95 operating point, over the {len(admitted)} pairs it admits")
    print(f"  paraphrases still served      {len(kept)}")
    print(f"  paraphrases newly rejected    {len(lost)}")
    print(f"  wrong answers now refused     {len(caught)}")
    print(f"  wrong answers still served    {len(served)}")

    print("\nnegation pairs the marker check would miss")
    missed = [
        item.pair
        for item in results.scored
        if item.pair.category == "minimal_pair"
        and item.pair.note == "negation"
        and not polarity_differs(item.pair)
    ]
    for pair in missed:
        print(f"  {pair.id}\n    {pair.left}\n    {pair.right}")
    if not missed:
        print("  none")


if __name__ == "__main__":
    main()
