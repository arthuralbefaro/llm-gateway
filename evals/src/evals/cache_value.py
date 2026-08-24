"""what the stored cache is worth, and what this data cannot say

the rows come from csv exported by scripts/export_cache_data.ps1 so nothing here
needs a database driver, and provenance is derived from the rows rather than
asserted, because the honesty of every number below depends on it
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np

from evals.dataset import data_dir

# the k6 generator builds every prompt as an angle over a topic followed by a
# fixed trailing clause, which is what makes generated traffic identifiable
TEMPLATE_MARKER = ", and how it relates to"

# a disuse policy needs entries observed for long enough that disuse is
# distinguishable from having just been written
MINIMUM_OBSERVATION_MULTIPLE = 10


@dataclass(frozen=True)
class RequestRow:
    api_key_id: str
    provider: str
    model: str
    cost_usd: float
    cost_estimated: bool
    latency_ms: int
    cache_hit: bool
    cache_kind: str
    status: str
    created_at: datetime

    @property
    def outcome(self) -> str:
        return self.cache_kind or "miss"


@dataclass(frozen=True)
class EntryRow:
    prompt_head: str
    prompt_length: int
    model: str
    hits: int
    created_at: datetime
    last_used_at: datetime

    @property
    def templated(self) -> bool:
        return TEMPLATE_MARKER in self.prompt_head


@dataclass(frozen=True)
class DataProvenance:
    requests: int
    entries: int
    api_keys: int
    request_span_seconds: float
    entry_span_seconds: float
    observation_seconds: float
    templated_share: float

    @property
    def is_synthetic(self) -> bool:
        return self.templated_share > 0.95 and self.api_keys == 1

    def summary(self) -> str:
        kind = "generated load traffic" if self.is_synthetic else "mixed or real"
        return (
            f"{self.requests} requests and {self.entries} entries from {kind}, "
            f"{self.api_keys} api key, requests spanning "
            f"{self.request_span_seconds:.0f}s, "
            f"{self.templated_share:.1%} of prompts templated"
        )


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value)


def load_requests(path: Path | None = None) -> list[RequestRow]:
    target = path or (data_dir() / "requests.csv")
    with target.open(encoding="utf-8", newline="") as handle:
        return [
            RequestRow(
                api_key_id=row["apiKeyId"],
                provider=row["provider"],
                model=row["model"],
                cost_usd=float(row["costUsd"]),
                cost_estimated=row["costEstimated"] == "t",
                latency_ms=int(row["latencyMs"]),
                cache_hit=row["cacheHit"] == "t",
                cache_kind=row["cacheKind"],
                status=row["status"],
                created_at=_parse_time(row["createdAt"]),
            )
            for row in csv.DictReader(handle)
        ]


def load_entries(path: Path | None = None) -> list[EntryRow]:
    target = path or (data_dir() / "cache_entries.csv")
    with target.open(encoding="utf-8", newline="") as handle:
        return [
            EntryRow(
                prompt_head=row["prompt_head"],
                prompt_length=int(row["prompt_length"]),
                model=row["model"],
                hits=int(row["hits"]),
                created_at=_parse_time(row["createdAt"]),
                last_used_at=_parse_time(row["lastUsedAt"]),
            )
            for row in csv.DictReader(handle)
        ]


def provenance(requests: list[RequestRow], entries: list[EntryRow]) -> DataProvenance:
    request_times = [row.created_at for row in requests]
    entry_times = [row.created_at for row in entries]
    last_used = [row.last_used_at for row in entries]
    return DataProvenance(
        requests=len(requests),
        entries=len(entries),
        api_keys=len({row.api_key_id for row in requests}),
        request_span_seconds=(max(request_times) - min(request_times)).total_seconds(),
        entry_span_seconds=(max(entry_times) - min(entry_times)).total_seconds(),
        observation_seconds=(max(last_used) - min(entry_times)).total_seconds(),
        templated_share=sum(row.templated for row in entries) / len(entries),
    )


def hit_distribution(entries: list[EntryRow]) -> dict[int, int]:
    counts: dict[int, int] = {}
    for entry in entries:
        counts[entry.hits] = counts.get(entry.hits, 0) + 1
    return dict(sorted(counts.items()))


def concentration(entries: list[EntryRow]) -> tuple[int, int, float]:
    """how few entries carry how much of the benefit"""
    hits = np.array(sorted((entry.hits for entry in entries), reverse=True))
    total = int(hits.sum())
    if total == 0:
        return 0, 0, 0.0
    used = int((hits > 0).sum())
    top = int(np.searchsorted(np.cumsum(hits), 0.95 * total) + 1)
    return used, top, top / len(entries)


def latency_by_outcome(requests: list[RequestRow]) -> dict[str, dict[str, float]]:
    grouped: dict[str, list[int]] = {}
    for row in requests:
        grouped.setdefault(row.outcome, []).append(row.latency_ms)

    summary: dict[str, dict[str, float]] = {}
    for outcome, values in grouped.items():
        array = np.array(values)
        summary[outcome] = {
            "n": float(len(array)),
            "p50": float(np.percentile(array, 50)),
            "p95": float(np.percentile(array, 95)),
            "p99": float(np.percentile(array, 99)),
            "max": float(array.max()),
        }
    return dict(sorted(summary.items(), key=lambda item: item[1]["p50"]))


def overall_latency(requests: list[RequestRow]) -> dict[str, float]:
    array = np.array([row.latency_ms for row in requests])
    return {
        "n": float(len(array)),
        "p50": float(np.percentile(array, 50)),
        "p95": float(np.percentile(array, 95)),
        "p99": float(np.percentile(array, 99)),
    }


def hit_rate(requests: list[RequestRow]) -> float:
    return sum(row.cache_hit for row in requests) / len(requests)


def disuse_policy_effect(
    entries: list[EntryRow], window_seconds: float
) -> tuple[int, str] | None:
    """entries a disuse expiry would evict, or None when the data cannot say

    returns None rather than a number when the cache was not observed for long
    enough, because an entry written seconds before the export is indistinguishable
    from one that fell out of use
    """
    times = [row.created_at for row in entries]
    observed = (max(row.last_used_at for row in entries) - min(times)).total_seconds()
    if observed < window_seconds * MINIMUM_OBSERVATION_MULTIPLE:
        return None

    cutoff = max(row.last_used_at for row in entries)
    evicted = sum(
        1
        for row in entries
        if (cutoff - row.last_used_at).total_seconds() >= window_seconds
    )
    return evicted, f"observed {observed:.0f}s against a {window_seconds:.0f}s window"
