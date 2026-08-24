"""expands data/topics.json into the labelled pair dataset.

The topics file is the hand written part. This script only combines it, so the
pairing rules are code and reviewable rather than 220 lines of judgement calls
buried in a data file.

    uv run python scripts/build_dataset.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from evals.dataset import Language, Pair, data_dir, write_pairs  # noqa: E402

# offset pairing for the unrelated controls, coprime with the topic count so
# every topic appears exactly twice and no topic is paired with itself
UNRELATED_OFFSET = 7

LANGUAGES: tuple[Language, ...] = ("en", "pt")


def build(topics: list[dict]) -> list[Pair]:
    pairs: list[Pair] = []
    count = len(topics)

    for topic in topics:
        tid = topic["id"]
        kind = topic["minimal_kind"]

        for lang in LANGUAGES:
            forms = topic[lang]

            # the only category the cache is supposed to collapse
            pairs.append(
                Pair(
                    id=f"paraphrase-{tid}-{lang}",
                    category="paraphrase",
                    left=forms["base"],
                    right=forms["paraphrase"],
                    left_lang=lang,
                    right_lang=lang,
                    topic=tid,
                )
            )

            # shares vocabulary and subject, asks for a different answer
            pairs.append(
                Pair(
                    id=f"same_topic-{tid}-{lang}",
                    category="same_topic",
                    left=forms["base"],
                    right=forms["sibling"],
                    left_lang=lang,
                    right_lang=lang,
                    topic=tid,
                )
            )

            # a few words apart from the base and a different answer entirely
            pairs.append(
                Pair(
                    id=f"minimal_pair-{tid}-{lang}",
                    category="minimal_pair",
                    left=forms["base"],
                    right=forms["minimal"],
                    left_lang=lang,
                    right_lang=lang,
                    topic=tid,
                    note=kind,
                )
            )

        # same question across languages, twice per topic so the category has
        # enough mass to read as a distribution rather than a handful of points
        for form in ("base", "paraphrase"):
            pairs.append(
                Pair(
                    id=f"cross_lingual-{tid}-{form}",
                    category="cross_lingual",
                    left=topic["en"][form],
                    right=topic["pt"][form],
                    left_lang="en",
                    right_lang="pt",
                    topic=tid,
                    note=form,
                )
            )

    for index, topic in enumerate(topics):
        other = topics[(index + UNRELATED_OFFSET) % count]
        tid, oid = topic["id"], other["id"]

        for lang in LANGUAGES:
            pairs.append(
                Pair(
                    id=f"unrelated-{tid}-{oid}-{lang}",
                    category="unrelated",
                    left=topic[lang]["base"],
                    right=other[lang]["base"],
                    left_lang=lang,
                    right_lang=lang,
                    topic=f"{tid}|{oid}",
                )
            )

        # unrelated across languages too: subtracting this from the same
        # language ones tells us whether the embedding encodes language at
        # all, which is the first question etapa 3 has to answer
        pairs.append(
            Pair(
                id=f"unrelated-{tid}-{oid}-en-pt",
                category="unrelated",
                left=topic["en"]["base"],
                right=other["pt"]["base"],
                left_lang="en",
                right_lang="pt",
                topic=f"{tid}|{oid}",
            )
        )

    return pairs


def main() -> None:
    topics_path = data_dir() / "topics.json"
    raw = json.loads(topics_path.read_text(encoding="utf-8"))
    pairs = build(raw["topics"])

    ids = [pair.id for pair in pairs]
    if len(set(ids)) != len(ids):
        raise SystemExit("duplicate pair ids, the naming scheme collided")

    out = data_dir() / "pairs.jsonl"
    write_pairs(pairs, out)

    by_category: dict[str, int] = {}
    for pair in pairs:
        by_category[pair.category] = by_category.get(pair.category, 0) + 1

    print(f"{len(pairs)} pairs -> {out}")
    for category, total in sorted(by_category.items()):
        print(f"  {category:<14} {total}")


if __name__ == "__main__":
    main()
