"""answers the partitioning question in the order the alternatives were fixed

uv run python scripts/language_report.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from evals.dataset import load_results  # noqa: E402
from evals.language import (  # noqa: E402
    Corpus,
    centroid_margin,
    load_corpus,
    nearest_centroid_loo,
    paired_language_gap,
    partitioned_false_positives,
    top_one,
)
from evals.sweep import (  # noqa: E402
    PRODUCTION_THRESHOLD,
    at_threshold,
    sweep,
    thresholds,
)

TABLE_THRESHOLDS = (0.88, 0.90, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97)


def charts_dir() -> Path:
    path = Path(__file__).resolve().parents[1] / "charts"
    path.mkdir(exist_ok=True)
    return path


def print_signal(scored: list) -> None:
    gaps = paired_language_gap(scored)
    print("\nquestion 1a, language signal at the pair level, paired by topic")
    header = f"{'regime':<16}{'n':>4}{'median gap':>13}"
    print(header + f"{'min':>10}{'max':>10}{'below 0':>9}")
    for name in ("topic_distinct", "topic_shared"):
        values = gaps[name]
        print(
            f"{name:<16}{len(values):>4}{np.median(values):>13.4f}"
            f"{values.min():>10.4f}{values.max():>10.4f}"
            f"{int((values <= 0).sum()):>9}"
        )
    print("\n  a gap is how much similarity drops when only the language changes")


def print_readout(corpus: Corpus) -> None:
    accuracy, by_lang, wrong = nearest_centroid_loo(corpus)
    margins = centroid_margin(corpus)
    print("\nquestion 1b, reading language off a single embedding")
    print(f"  nearest centroid, leave one out over {corpus.n} texts")
    print(f"    accuracy {accuracy:.4f}")
    for lang, value in sorted(by_lang.items()):
        print(f"    {lang}  {value:.4f}")
    print(f"    margin min {margins.min():.4f}  median {np.median(margins):.4f}")
    if wrong:
        print("    misclassified:")
        for index in wrong:
            print(f"      [{corpus.langs[index]}] {corpus.texts[index]}")
    else:
        print("    misclassified: none")


def print_retrieval(corpus: Corpus) -> None:
    unrestricted = top_one(corpus, restrict_to_language=False)
    cross = [o for o in unrestricted if o.best_is_cross_language]
    print("\ntop one retrieval over the whole corpus, no partition")
    print(f"  nearest neighbour is same language  {corpus.n - len(cross)}/{corpus.n}")
    print(f"  nearest neighbour is other language {len(cross)}/{corpus.n}")
    above = [o for o in cross if o.best_similarity >= PRODUCTION_THRESHOLD]
    print(f"  of those, above {PRODUCTION_THRESHOLD}: {len(above)}")
    for outcome in cross[:5]:
        print(f"    {outcome.best_similarity:.4f} [{outcome.lang}] {outcome.query}")
        print(f"           -> [{outcome.best_lang}] {outcome.best_text}")


def print_partition_effect(scored: list) -> None:
    points = sweep(scored)
    print("\nquestion 2, what a partition changes across the range")
    print(
        f"{'thresh':>7}{'recall':>9}{'FP no partition':>18}"
        f"{'FP partitioned':>17}{'removed':>9}"
    )
    for target in TABLE_THRESHOLDS:
        point = at_threshold(points, target)
        without, with_partition = partitioned_false_positives(scored, point.threshold)
        print(
            f"{point.threshold:>7.2f}{point.recall:>9.3f}{without:>18}"
            f"{with_partition:>17}{without - with_partition:>9}"
        )


def print_recovery(scored: list) -> None:
    """the question etapa 2 turned this into: does a partition buy back recall"""
    points = sweep(scored)
    today = at_threshold(points, PRODUCTION_THRESHOLD)
    budget = today.false_positives

    print(f"\nquestion 3, holding false positives at today's {budget}")
    print(f"  today, no partition, threshold {PRODUCTION_THRESHOLD}")
    print(f"    recall {today.recall:.3f}, paraphrases lost {today.false_negatives}")

    viable = [
        point
        for point in points
        if partitioned_false_positives(scored, point.threshold)[1] <= budget
    ]
    lowest = min(viable, key=lambda point: point.threshold)
    without, with_partition = partitioned_false_positives(scored, lowest.threshold)
    print("  with a language partition, lowest threshold inside the same budget")
    print(f"    threshold {lowest.threshold:.4f}")
    print(f"    recall {lowest.recall:.3f}, paraphrases lost {lowest.false_negatives}")
    print(
        f"    false positives {with_partition}, without partition it would be {without}"
    )
    recovered = today.false_negatives - lowest.false_negatives
    print(f"\n  paraphrases recovered: {recovered}")


def print_conditional_value(scored: list) -> None:
    """Whether a partition would matter if the minimal pairs were solved elsewhere.

    Its value today is masked by a larger problem, and reporting only the masked
    number would understate it for any future where that problem is fixed.
    """
    points = sweep(scored)
    print("\nconditional value, counting only false positives a partition could reach")
    print("  minimal pairs excluded, as though some other check already caught them")
    print(f"{'thresh':>7}{'recall':>9}{'FP no partition':>18}{'FP partitioned':>17}")
    for target in (0.86, 0.88, 0.90, 0.92, 0.94, 0.95):
        point = at_threshold(points, target)
        relevant = [
            s
            for s in scored
            if not s.pair.should_hit and s.pair.category != "minimal_pair"
        ]
        without = sum(1 for s in relevant if s.similarity >= point.threshold)
        partitioned = sum(
            1
            for s in relevant
            if s.similarity >= point.threshold and not s.pair.is_cross_lingual
        )
        print(
            f"{point.threshold:>7.2f}{point.recall:>9.3f}{without:>18}{partitioned:>17}"
        )


def print_hit_rate_by_language(scored: list) -> None:
    points = sweep(scored)
    point = at_threshold(points, PRODUCTION_THRESHOLD)
    print(f"\nparaphrase hit rate by language at {PRODUCTION_THRESHOLD}")
    print(f"{'language':<10}{'served':>9}{'n':>5}{'rate':>8}")
    for lang in ("en", "pt"):
        values = [
            s.similarity
            for s in scored
            if s.pair.category == "paraphrase" and s.pair.left_lang == lang
        ]
        served = sum(1 for v in values if v >= PRODUCTION_THRESHOLD)
        print(f"{lang:<10}{served:>9}{len(values):>5}{served / len(values):>8.1%}")
    print("  a partition changes none of these, every paraphrase is intra language")
    print(f"  aggregate recall {point.recall:.3f}")


def plot_language_gap(scored: list, path: Path) -> None:
    gaps = paired_language_gap(scored)
    fig, ax = plt.subplots(figsize=(9, 5))
    names = ("topic_distinct", "topic_shared")
    labels = ("topic distinct\n(unrelated controls)", "topic shared\n(same question)")

    for index, name in enumerate(names):
        values = gaps[name]
        ax.scatter(
            values, np.full(len(values), index), s=30, alpha=0.6, color="#4393c3"
        )
        ax.scatter([np.median(values)], [index], s=140, marker="|", color="black")

    ax.axvline(0, color="#b2182b", linestyle="--", linewidth=1.2)
    ax.set_yticks(range(len(names)))
    ax.set_yticklabels(labels)
    ax.set_xlabel("similarity lost when only the language changes")
    ax.set_title("Language signal survives when topic is shared, and is larger there")
    ax.grid(axis="x", alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_partition_effect(scored: list, path: Path) -> None:
    fig, ax = plt.subplots(figsize=(10, 6))
    xs = [float(t) for t in thresholds()]
    without = []
    partitioned = []
    for value in xs:
        a, b = partitioned_false_positives(scored, value)
        without.append(a)
        partitioned.append(b)

    ax.plot(xs, without, color="#b2182b", linewidth=2, label="no partition")
    ax.plot(
        xs, partitioned, color="#4393c3", linewidth=2, label="partitioned by language"
    )
    ax.fill_between(
        xs,
        partitioned,
        without,
        color="#4393c3",
        alpha=0.2,
        label="removed by the partition",
    )

    ax.axvline(PRODUCTION_THRESHOLD, color="black", linestyle="--", linewidth=1.2)
    ax.set_xlim(0.80, 1.0)
    ax.set_xlabel("threshold")
    ax.set_ylabel("pairs")
    ax.set_title("What a language partition removes, and where it stops mattering")
    ax.legend(fontsize=9)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def main() -> None:
    results = load_results()
    corpus = load_corpus()
    print(corpus.provenance.summary())

    print_signal(results.scored)
    print_readout(corpus)
    print_retrieval(corpus)
    print_partition_effect(results.scored)
    print_recovery(results.scored)
    print_conditional_value(results.scored)
    print_hit_rate_by_language(results.scored)

    out = charts_dir()
    plot_language_gap(results.scored, out / "language-gap.png")
    plot_partition_effect(results.scored, out / "partition-effect.png")
    print(f"\ncharts written to {out}")


if __name__ == "__main__":
    main()
