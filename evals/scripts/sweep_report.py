"""runs the threshold sweep and writes the charts

uv run python scripts/sweep_report.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib

# no display on the machines this runs on
matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from evals.dataset import load_results  # noqa: E402
from evals.sweep import (  # noqa: E402
    PRODUCTION_THRESHOLD,
    CategoryStats,
    SweepPoint,
    at_threshold,
    by_category,
    by_edit_kind,
    overlap,
    separable,
    subset,
    sweep,
)

ORDER = ("paraphrase", "minimal_pair", "same_topic", "cross_lingual", "unrelated")
EDIT_ORDER = ("entity", "temporal", "negation")

COLORS = {
    "paraphrase": "#1b7837",
    "minimal_pair": "#b2182b",
    "same_topic": "#d6604d",
    "cross_lingual": "#4393c3",
    "unrelated": "#878787",
    "entity": "#4393c3",
    "temporal": "#f4a582",
    "negation": "#b2182b",
}

TABLE_THRESHOLDS = (0.85, 0.88, 0.90, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99)


def charts_dir() -> Path:
    path = Path(__file__).resolve().parents[1] / "charts"
    path.mkdir(exist_ok=True)
    return path


def print_distributions(stats: dict[str, CategoryStats]) -> None:
    print("\nsimilarity distribution by category")
    header = f"{'category':<15}{'n':>4}" + "".join(
        f"{label:>9}" for label in ("min", "p05", "p25", "median", "p75", "p95", "max")
    )
    print(header)
    for name in ORDER:
        s = stats[name]
        cells = [
            s.minimum,
            s.percentile(5),
            s.percentile(25),
            s.percentile(50),
            s.percentile(75),
            s.percentile(95),
            s.maximum,
        ]
        print(f"{name:<15}{s.n:>4}" + "".join(f"{v:>9.4f}" for v in cells))


def print_overlap(stats: dict[str, CategoryStats]) -> None:
    print("\noverlap against paraphrase")
    print(f"{'category':<15}{'separable':>11}{'shared band':>22}{'inside band':>14}")
    para = stats["paraphrase"]
    for name in ORDER[1:]:
        other = stats[name]
        low, high = overlap(para, other)
        if low > high:
            band, inside = "none", "0"
        else:
            band = f"{low:.4f} to {high:.4f}"
            count = int(((other.values >= low) & (other.values <= high)).sum())
            inside = f"{count}/{other.n}"
        print(f"{name:<15}{str(separable(para, other)):>11}{band:>22}{inside:>14}")


def print_sweep(points: list[SweepPoint]) -> None:
    print("\nthreshold sweep, false negatives and false positives never summed")
    print(
        f"{'thresh':>7}{'TP':>5}{'FN':>5}{'FP':>5}{'TN':>5}"
        f"{'precision':>11}{'recall':>9}"
        f"{'FP minimal':>12}{'FP topic':>10}{'FP cross':>10}{'FP unrel':>10}"
    )
    for target in TABLE_THRESHOLDS:
        p = at_threshold(points, target)
        precision = f"{p.precision:.3f}" if p.precision is not None else "n/a"
        fp = p.false_positives_by_category
        print(
            f"{p.threshold:>7.2f}{p.true_positives:>5}{p.false_negatives:>5}"
            f"{p.false_positives:>5}{p.true_negatives:>5}"
            f"{precision:>11}{p.recall:>9.3f}"
            f"{fp['minimal_pair']:>12}{fp['same_topic']:>10}"
            f"{fp['cross_lingual']:>10}{fp['unrelated']:>10}"
        )


def print_edit_breakdown(
    points: list[SweepPoint], edits: dict[str, CategoryStats]
) -> None:
    print("\nminimal pairs admitted, by kind of edit")
    counts = "".join(f"{kind} (n={edits[kind].n})".rjust(18) for kind in EDIT_ORDER)
    print(f"{'thresh':>7}{counts}")
    for target in TABLE_THRESHOLDS:
        p = at_threshold(points, target)
        cells = ""
        for kind in EDIT_ORDER:
            count = p.false_positives_by_edit[kind]
            rate = p.false_positive_rate_by_edit[kind]
            cells += f"{count}/{edits[kind].n} ({rate:>5.0%})".rjust(18)
        print(f"{p.threshold:>7.2f}{cells}")


def print_production(points: list[SweepPoint], stats: dict[str, CategoryStats]) -> None:
    p = at_threshold(points, PRODUCTION_THRESHOLD)
    print(f"\nwhat happens at {PRODUCTION_THRESHOLD}, the value the gateway runs")
    print(f"  true positives   {p.true_positives:>3}  paraphrases served from cache")
    print(f"  false negatives  {p.false_negatives:>3}  paraphrases costing a call")
    print(f"  false positives  {p.false_positives:>3}  pairs served the wrong answer")
    print(f"  true negatives   {p.true_negatives:>3}  correctly refused")
    precision = f"{p.precision:.3f}" if p.precision is not None else "n/a"
    print(f"  precision {precision}   recall {p.recall:.3f}")
    print("\n  false positives by category, and as a share of that category")
    for name in ORDER[1:]:
        count = p.false_positives_by_category[name]
        rate = p.false_positive_rate_by_category[name]
        print(f"    {name:<15}{count:>4}/{stats[name].n:<5}{rate:>7.1%}")


def print_cross_lingual(scored: list, stats: dict[str, CategoryStats]) -> None:
    print("\ncross-lingual against ADR 0001")
    cross = stats["cross_lingual"]
    para = stats["paraphrase"]
    print(
        f"  cross_lingual   max {cross.maximum:.4f}   median {cross.percentile(50):.4f}"
    )
    print(
        f"  paraphrase      min {para.minimum:.4f}   median {para.percentile(50):.4f}"
    )
    print(f"  separable by any threshold: {separable(para, cross)}")

    same = np.array(
        [
            s.similarity
            for s in subset(scored, category="unrelated")
            if not s.pair.is_cross_lingual
        ]
    )
    across = np.array(
        [
            s.similarity
            for s in subset(scored, category="unrelated")
            if s.pair.is_cross_lingual
        ]
    )
    print("\n  unrelated controls, language signal isolated from topic")
    print(f"    same language   n={len(same):<4} median {np.median(same):.4f}")
    print(f"    across language n={len(across):<4} median {np.median(across):.4f}")
    print(f"    difference {np.median(same) - np.median(across):.4f}")


def plot_distributions(stats: dict[str, CategoryStats], path: Path) -> None:
    fig, ax = plt.subplots(figsize=(10, 6))
    rng = np.random.default_rng(0)

    for index, name in enumerate(ORDER):
        values = stats[name].values
        jitter = rng.uniform(-0.16, 0.16, size=len(values))
        ax.scatter(
            values,
            np.full(len(values), index) + jitter,
            s=18,
            alpha=0.55,
            color=COLORS[name],
            edgecolors="none",
        )
        ax.boxplot(
            values,
            positions=[index],
            orientation="horizontal",
            widths=0.55,
            showfliers=False,
            medianprops={"color": "black", "linewidth": 1.6},
            boxprops={"alpha": 0.7},
        )

    ax.axvline(PRODUCTION_THRESHOLD, color="black", linestyle="--", linewidth=1.2)
    ax.set_ylim(-0.9, len(ORDER) - 0.4)
    ax.text(
        PRODUCTION_THRESHOLD,
        -0.72,
        f"  threshold in production ({PRODUCTION_THRESHOLD})",
        fontsize=9,
        va="center",
    )
    ax.set_yticks(range(len(ORDER)))
    ax.set_yticklabels([f"{name}\n(n={stats[name].n})" for name in ORDER])
    ax.set_xlabel("cosine similarity")
    ax.set_title(
        "Similarity by category: paraphrase must hit, every other category must not"
    )
    ax.grid(axis="x", alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_frontier(
    points: list[SweepPoint], stats: dict[str, CategoryStats], path: Path
) -> None:
    fig, (top, bottom) = plt.subplots(2, 1, figsize=(10, 9), sharex=True)
    x = [p.threshold for p in points]

    top.plot(
        x,
        [p.false_negatives for p in points],
        color=COLORS["paraphrase"],
        linewidth=2,
        label="false negatives: paraphrases lost, each costs a provider call",
    )
    top.plot(
        x,
        [p.false_positives for p in points],
        color=COLORS["minimal_pair"],
        linewidth=2,
        label="false positives: wrong answer served to a different question",
    )
    top.set_ylabel("pairs")
    top.set_title(
        "The frontier: the two errors are not added, because they are not comparable"
    )
    top.legend(loc="upper center", fontsize=9)

    paraphrases = stats["paraphrase"].n
    bottom.plot(
        x,
        [p.false_negatives / paraphrases for p in points],
        color=COLORS["paraphrase"],
        linewidth=2,
        label="share of paraphrases lost",
    )
    bottom.plot(
        x,
        [p.false_positive_rate_by_category["minimal_pair"] for p in points],
        color=COLORS["minimal_pair"],
        linewidth=2,
        label="share of minimal pairs admitted",
    )
    bottom.set_ylabel("share")
    bottom.set_xlabel("threshold")
    bottom.set_ylim(0, 1.02)
    bottom.set_title("The same frontier as rates, which the counts above cannot show")
    bottom.legend(loc="center left", fontsize=9)

    for ax in (top, bottom):
        ax.axvline(PRODUCTION_THRESHOLD, color="black", linestyle="--", linewidth=1.2)
        ax.set_xlim(0.80, 1.0)
        ax.grid(alpha=0.3)

    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_false_positives_by_category(points: list[SweepPoint], path: Path) -> None:
    fig, ax = plt.subplots(figsize=(10, 6))
    x = [p.threshold for p in points]

    for name in ORDER[1:]:
        ax.plot(
            x,
            [p.false_positive_rate_by_category[name] for p in points],
            color=COLORS[name],
            linewidth=2,
            label=name,
        )
    ax.plot(
        x,
        [p.recall for p in points],
        color=COLORS["paraphrase"],
        linewidth=2,
        linestyle=":",
        label="paraphrase (recall, wanted high)",
    )

    ax.axvline(PRODUCTION_THRESHOLD, color="black", linestyle="--", linewidth=1.2)
    ax.set_xlabel("threshold")
    ax.set_ylabel("share of the category admitted")
    ax.set_xlim(0.80, 1.0)
    ax.set_ylim(0, 1.02)
    ax.set_title(
        "Share of each category admitted, rate within category rather than raw count"
    )
    ax.legend(fontsize=9)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_edit_kinds(
    points: list[SweepPoint], edits: dict[str, CategoryStats], path: Path
) -> None:
    fig, ax = plt.subplots(figsize=(10, 6))
    x = [p.threshold for p in points]

    for kind in EDIT_ORDER:
        ax.plot(
            x,
            [p.false_positive_rate_by_edit[kind] for p in points],
            color=COLORS[kind],
            linewidth=2,
            label=f"{kind} (n={edits[kind].n})",
        )
    ax.plot(
        x,
        [p.recall for p in points],
        color=COLORS["paraphrase"],
        linewidth=2,
        linestyle=":",
        label="paraphrase (recall)",
    )

    ax.axvline(PRODUCTION_THRESHOLD, color="black", linestyle="--", linewidth=1.2)
    ax.set_xlabel("threshold")
    ax.set_ylabel("share admitted")
    ax.set_xlim(0.80, 1.0)
    ax.set_ylim(0, 1.02)
    ax.set_title(
        "Minimal pairs admitted by edit: negation stays above paraphrase throughout"
    )
    ax.legend(fontsize=9)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_precision_recall(points: list[SweepPoint], path: Path) -> None:
    fig, ax = plt.subplots(figsize=(10, 6))
    x = [p.threshold for p in points]

    ax.plot(
        x,
        [p.recall for p in points],
        color=COLORS["paraphrase"],
        linewidth=2,
        label="recall",
    )
    defined = [(p.threshold, p.precision) for p in points if p.precision is not None]
    ax.plot(
        [t for t, _ in defined],
        [v for _, v in defined],
        color=COLORS["minimal_pair"],
        linewidth=2,
        label="precision",
    )

    ax.axvline(PRODUCTION_THRESHOLD, color="black", linestyle="--", linewidth=1.2)
    ax.set_xlabel("threshold")
    ax.set_xlim(0.80, 1.0)
    ax.set_ylim(0, 1.02)
    ax.set_title(
        "Precision and recall, reported beside the frontier and never in place of it"
    )
    ax.legend(fontsize=9)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def main() -> None:
    results = load_results()
    print(results.provenance.summary())

    stats = by_category(results.scored)
    edits = by_edit_kind(results.scored)
    points = sweep(results.scored)

    print_distributions(stats)
    print_overlap(stats)
    print_sweep(points)
    print_edit_breakdown(points, edits)
    print_production(points, stats)
    print_cross_lingual(results.scored, stats)

    out = charts_dir()
    plot_distributions(stats, out / "similarity-distributions.png")
    plot_frontier(points, stats, out / "threshold-frontier.png")
    plot_false_positives_by_category(points, out / "admitted-by-category.png")
    plot_edit_kinds(points, edits, out / "minimal-pairs-by-edit.png")
    plot_precision_recall(points, out / "precision-recall.png")
    print(f"\ncharts written to {out}")


if __name__ == "__main__":
    main()
