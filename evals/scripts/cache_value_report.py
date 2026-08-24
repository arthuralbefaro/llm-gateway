"""what the stored cache is worth, provenance first

uv run python scripts/cache_value_report.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from evals.cache_value import (  # noqa: E402
    EntryRow,
    RequestRow,
    concentration,
    disuse_policy_effect,
    hit_distribution,
    hit_rate,
    latency_by_outcome,
    load_entries,
    load_requests,
    overall_latency,
    provenance,
)

WINDOWS = (3600, 86400, 604800)


def charts_dir() -> Path:
    path = Path(__file__).resolve().parents[1] / "charts"
    path.mkdir(exist_ok=True)
    return path


def print_provenance(requests: list[RequestRow], entries: list[EntryRow]) -> None:
    prov = provenance(requests, entries)
    print("where this data came from")
    print(f"  {prov.summary()}")
    print(f"  requests span      {prov.request_span_seconds:.0f}s")
    print(f"  entries written in {prov.entry_span_seconds:.0f}s")
    print(f"  cache observed for {prov.observation_seconds:.0f}s")
    print(f"  templated prompts  {prov.templated_share:.1%}")
    print(f"  distinct api keys  {prov.api_keys}")
    if prov.is_synthetic:
        print(
            "\n  every row is generated load traffic from a single k6 run.\n"
            "  the distribution of hits per entry below is a readout of that\n"
            "  scenario's configuration, not a property of demand."
        )


def print_hits(entries: list[EntryRow]) -> None:
    distribution = hit_distribution(entries)
    used, top, share = concentration(entries)
    total = sum(entry.hits for entry in entries)

    print("\nhits per entry")
    print(f"{'hits':>6}{'entries':>10}")
    for hits, count in distribution.items():
        print(f"{hits:>6}{count:>10}")

    never = distribution.get(0, 0)
    print(
        f"\n  entries never used  {never}/{len(entries)} ({never / len(entries):.1%})"
    )
    print(f"  entries used        {used}/{len(entries)}")
    print(f"  hits recorded       {total}")
    print(f"  {top} entries ({share:.1%}) carry 95% of the hits")


def print_latency(requests: list[RequestRow]) -> None:
    print(f"\nlatency by outcome, measured hit rate {hit_rate(requests):.1%}")
    print(f"{'outcome':<10}{'n':>6}{'p50':>9}{'p95':>9}{'p99':>9}{'max':>9}")
    for outcome, stats in latency_by_outcome(requests).items():
        print(
            f"{outcome:<10}{stats['n']:>6.0f}{stats['p50']:>9.1f}"
            f"{stats['p95']:>9.1f}{stats['p99']:>9.1f}{stats['max']:>9.0f}"
        )

    overall = overall_latency(requests)
    miss = latency_by_outcome(requests)["miss"]
    print(
        f"{'overall':<10}{overall['n']:>6.0f}{overall['p50']:>9.1f}"
        f"{overall['p95']:>9.1f}{overall['p99']:>9.1f}"
    )
    print(
        f"\n  the median falls to {overall['p50']:.0f} ms, "
        f"{miss['p50'] / overall['p50']:.0f}x faster than a miss"
    )
    print(
        f"  the p99 is {overall['p99']:.0f} ms against {miss['p99']:.0f} ms for a "
        f"miss, {overall['p99'] / miss['p99']:.0%} of it"
    )


def print_disuse(entries: list[EntryRow]) -> None:
    print("\neffect of a disuse expiry policy")
    for window in WINDOWS:
        result = disuse_policy_effect(entries, window)
        label = f"{window // 3600}h" if window < 86400 else f"{window // 86400}d"
        if result is None:
            print(f"  {label:>4}  cannot be answered from this data")
        else:
            evicted, note = result
            print(f"  {label:>4}  would evict {evicted}/{len(entries)}, {note}")
    print(
        "\n  every entry was written within a few seconds of every other and the\n"
        "  cache was observed for well under a minute. nothing here has had the\n"
        "  chance to fall out of use, so any eviction count would be measuring\n"
        "  the length of the run rather than the policy."
    )


def plot_hits(entries: list[EntryRow], path: Path) -> None:
    hits = np.array(sorted((entry.hits for entry in entries), reverse=True))
    fig, (left, right) = plt.subplots(1, 2, figsize=(12, 5))

    left.bar(range(len(hits)), hits, color="#4393c3", width=1.0)
    left.set_xlabel("entries, ordered by hits")
    left.set_ylabel("hits")
    left.set_title("Hits per entry")
    left.grid(axis="y", alpha=0.3)

    cumulative = np.cumsum(hits) / hits.sum()
    right.plot(
        np.arange(1, len(hits) + 1) / len(hits),
        cumulative,
        color="#b2182b",
        linewidth=2,
    )
    right.plot([0, 1], [0, 1], color="#878787", linestyle="--", linewidth=1)
    right.set_xlabel("share of entries")
    right.set_ylabel("share of hits")
    right.set_title("Concentration, against an even split")
    right.grid(alpha=0.3)

    fig.suptitle(
        "Generated load traffic from one k6 run, not demand",
        fontsize=11,
    )
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_latency(requests: list[RequestRow], path: Path) -> None:
    grouped: dict[str, list[int]] = {}
    for row in requests:
        grouped.setdefault(row.outcome, []).append(row.latency_ms)
    order = [name for name in ("exact", "semantic", "miss") if name in grouped]

    fig, ax = plt.subplots(figsize=(10, 5.5))
    colors = {"exact": "#1b7837", "semantic": "#f4a582", "miss": "#b2182b"}
    for index, name in enumerate(order):
        values = np.array(grouped[name])
        ax.scatter(
            values,
            np.full(len(values), index) + 0.0,
            s=14,
            alpha=0.35,
            color=colors[name],
            edgecolors="none",
        )
        ax.scatter(
            [np.percentile(values, 99)], [index], marker="|", s=300, color="black"
        )

    overall = overall_latency(requests)
    ax.axvline(overall["p99"], color="black", linestyle="--", linewidth=1.2)
    ax.text(
        overall["p99"],
        len(order) - 0.4,
        f"  overall p99 {overall['p99']:.0f} ms",
        fontsize=9,
        va="center",
    )
    ax.set_yticks(range(len(order)))
    ax.set_yticklabels([f"{name}\n(n={len(grouped[name])})" for name in order])
    ax.set_xlabel("latency (ms), black bar marks p99")
    ax.set_title(
        f"A {hit_rate(requests):.0%} hit rate moves the median and not the tail"
    )
    ax.grid(axis="x", alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def main() -> None:
    requests = load_requests()
    entries = load_entries()

    print_provenance(requests, entries)
    print_hits(entries)
    print_latency(requests)
    print_disuse(entries)

    out = charts_dir()
    plot_hits(entries, out / "hits-per-entry.png")
    plot_latency(requests, out / "latency-by-outcome.png")
    print(f"\ncharts written to {out}")


if __name__ == "__main__":
    main()
