"""measures the five options for the week 6 cache decision on the dataset

nothing here changes the gateway, it only prices each option so the choice is
made on numbers instead of taste

    uv run python scripts/decision_report.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from probe_negation import polarity_differs  # noqa: E402

from evals.cache_value import (  # noqa: E402
    latency_by_outcome,
    load_entries,
    load_requests,
)
from evals.dataset import ScoredPair, load_results  # noqa: E402
from evals.sweep import PRODUCTION_THRESHOLD, at_threshold, sweep  # noqa: E402

OPTION_B_THRESHOLDS = (0.95, 0.96, 0.97, 0.98)
OPTION_C_THRESHOLDS = (0.92, 0.93, 0.94, 0.95)
BANDS = ((0.95, 0.96), (0.96, 0.97), (0.97, 0.98), (0.98, 1.01))


def confusion(
    scored: list[ScoredPair], threshold: float, *, negation_filter: bool
) -> tuple[int, int, int, int]:
    tp = fn = fp = tn = 0
    for item in scored:
        admitted = item.similarity >= threshold
        if admitted and negation_filter and polarity_differs(item.pair):
            admitted = False
        if item.pair.should_hit:
            tp, fn = (tp + 1, fn) if admitted else (tp, fn + 1)
        else:
            fp, tn = (fp + 1, tn) if admitted else (fp, tn + 1)
    return tp, fn, fp, tn


def print_option_a(scored: list[ScoredPair]) -> None:
    point = at_threshold(sweep(scored), PRODUCTION_THRESHOLD)
    print("option a, keep 0.95 and declare the limitation to the caller")
    print(
        f"  behaviour unchanged: TP {point.true_positives}, FN "
        f"{point.false_negatives}, FP {point.false_positives}"
    )
    print("  the caller learns a hit may not be equivalent, nothing else moves")


def print_option_b(scored: list[ScoredPair]) -> None:
    print("\noption b, raise the threshold")
    points = sweep(scored)
    print(f"{'thresh':>7}{'TP':>5}{'FN':>5}{'FP':>5}{'FP cut':>8}{'TP cut':>8}")
    base = at_threshold(points, PRODUCTION_THRESHOLD)
    for target in OPTION_B_THRESHOLDS:
        p = at_threshold(points, target)
        fp_cut = (base.false_positives - p.false_positives) / base.false_positives
        tp_cut = (base.true_positives - p.true_positives) / base.true_positives
        print(
            f"{p.threshold:>7.2f}{p.true_positives:>5}{p.false_negatives:>5}"
            f"{p.false_positives:>5}{fp_cut:>8.0%}{tp_cut:>8.0%}"
        )

    zero_fp = min(
        (p for p in points if p.false_positives == 0), key=lambda p: p.threshold
    )
    print(
        f"  first threshold with zero wrong answers: {zero_fp.threshold:.4f}, "
        f"recall {zero_fp.recall:.3f}"
    )
    print("  every step cuts correct hits faster than wrong ones, negations die last")


def print_option_c(scored: list[ScoredPair]) -> None:
    print("\noption c, negation filter after the vector search")
    print(f"{'thresh':>7}{'TP':>5}{'FN':>5}{'FP':>5}{'precision':>11}{'recall':>9}")
    for target in OPTION_C_THRESHOLDS:
        for filtered in (False, True):
            tp, fn, fp, _ = confusion(scored, target, negation_filter=filtered)
            label = f"{target:.2f}" + ("+f" if filtered else "  ")
            precision = tp / (tp + fp) if tp + fp else 0.0
            print(f"{label:>7}{tp:>5}{fn:>5}{fp:>5}{precision:>11.3f}{tp / 40:>9.3f}")
    print("  the filter costs zero paraphrases at 0.95 and removes 8 of 20 wrong")
    print("  answers, the syntactically marked ones, and cannot see the rest")


def print_option_d(scored: list[ScoredPair]) -> None:
    print("\noption d, restrict to a high similarity band")
    print(f"{'band':>13}{'hits':>6}{'right':>7}{'wrong':>7}{'precision':>11}")
    for low, high in BANDS:
        inside = [s for s in scored if low <= s.similarity < high]
        right = sum(1 for s in inside if s.pair.should_hit)
        wrong = len(inside) - right
        precision = right / len(inside) if inside else 0.0
        print(
            f"{f'{low:.2f}-{min(high, 1.0):.2f}':>13}{len(inside):>6}"
            f"{right:>7}{wrong:>7}{precision:>11.3f}"
        )
    print("  the top band is the worst, negations occupy it, nearly identical")
    print("  does not mean safe, it means the edit was too small for the model")


def print_option_e() -> None:
    requests = load_requests()
    entries = load_entries()
    outcomes = latency_by_outcome(requests)
    semantic = outcomes.get("semantic")
    total_hits = sum(row.cache_hit for row in requests)
    print("\noption e, drop the semantic tier and keep exact")
    if semantic is None:
        print("  no semantic hits in the exported traffic")
        return
    n = int(semantic["n"])
    print(
        f"  in the one exported k6 run: {n} of {total_hits} hits were semantic "
        f"({n / total_hits:.1%}), {n} of {len(requests)} requests "
        f"({n / len(requests):.1%})"
    )
    saved = outcomes["miss"]["p50"] - semantic["p50"]
    print(
        f"  each semantic hit saved {saved:.0f} ms of median latency and one "
        f"provider call"
    )
    print(
        "  on the dataset it forfeits the 16 paraphrases 0.95 serves, and "
        "eliminates all 20 wrong answers"
    )
    print(
        f"  entries stored for semantic search: {len(entries)}, the write path "
        f"and the hnsw index become dead weight unless removed too"
    )


def main() -> None:
    results = load_results()
    print(results.provenance.summary())
    print()
    print_option_a(results.scored)
    print_option_b(results.scored)
    print_option_c(results.scored)
    print_option_d(results.scored)
    print_option_e()


if __name__ == "__main__":
    main()
