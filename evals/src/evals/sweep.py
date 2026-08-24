"""threshold sweep over the scored dataset

false positives and false negatives are carried separately at every step and
never summed, they are different errors: a false negative costs a provider
call, a false positive returns an answer to a question nobody asked
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from evals.dataset import CATEGORIES, ScoredPair

# the data spans 0.71 to 0.99, so this covers every decision boundary that
# changes an outcome plus room above the highest pair
SWEEP_START = 0.80
SWEEP_STOP = 1.0
SWEEP_STEP = 0.0025

PRODUCTION_THRESHOLD = 0.95


@dataclass(frozen=True)
class CategoryStats:
    category: str
    n: int
    values: np.ndarray

    @property
    def minimum(self) -> float:
        return float(self.values.min())

    @property
    def maximum(self) -> float:
        return float(self.values.max())

    def percentile(self, q: float) -> float:
        return float(np.percentile(self.values, q))

    def admitted(self, threshold: float) -> int:
        return int((self.values >= threshold).sum())

    def admitted_rate(self, threshold: float) -> float:
        return self.admitted(threshold) / self.n


@dataclass(frozen=True)
class SweepPoint:
    threshold: float
    true_positives: int
    false_negatives: int
    false_positives: int
    true_negatives: int
    # kept per category because the aggregate count is weighted by how many
    # pairs of each kind the dataset happens to contain, which is a property of
    # how it was written rather than of traffic
    false_positives_by_category: dict[str, int] = field(default_factory=dict)
    false_positive_rate_by_category: dict[str, float] = field(default_factory=dict)
    false_positives_by_edit: dict[str, int] = field(default_factory=dict)
    false_positive_rate_by_edit: dict[str, float] = field(default_factory=dict)

    @property
    def precision(self) -> float | None:
        admitted = self.true_positives + self.false_positives
        return self.true_positives / admitted if admitted else None

    @property
    def recall(self) -> float:
        wanted = self.true_positives + self.false_negatives
        return self.true_positives / wanted if wanted else 0.0


def thresholds() -> np.ndarray:
    return np.arange(SWEEP_START, SWEEP_STOP + SWEEP_STEP / 2, SWEEP_STEP)


def by_category(scored: list[ScoredPair]) -> dict[str, CategoryStats]:
    grouped: dict[str, list[float]] = {category: [] for category in CATEGORIES}
    for item in scored:
        grouped[item.pair.category].append(item.similarity)
    return {
        category: CategoryStats(category, len(values), np.array(values))
        for category, values in grouped.items()
    }


def by_edit_kind(scored: list[ScoredPair]) -> dict[str, CategoryStats]:
    grouped: dict[str, list[float]] = {}
    for item in scored:
        if item.pair.category == "minimal_pair":
            grouped.setdefault(item.pair.note, []).append(item.similarity)
    return {
        kind: CategoryStats(kind, len(values), np.array(values))
        for kind, values in sorted(grouped.items())
    }


def subset(scored: list[ScoredPair], **criteria: object) -> list[ScoredPair]:
    return [
        item
        for item in scored
        if all(getattr(item.pair, key) == value for key, value in criteria.items())
    ]


def sweep(scored: list[ScoredPair]) -> list[SweepPoint]:
    positives = np.array([s.similarity for s in scored if s.pair.should_hit])
    negatives = np.array([s.similarity for s in scored if not s.pair.should_hit])
    categories = {
        name: stats
        for name, stats in by_category(scored).items()
        if name != "paraphrase"
    }
    edits = by_edit_kind(scored)

    points: list[SweepPoint] = []
    for threshold in thresholds():
        value = float(threshold)
        points.append(
            SweepPoint(
                threshold=value,
                true_positives=int((positives >= value).sum()),
                false_negatives=int((positives < value).sum()),
                false_positives=int((negatives >= value).sum()),
                true_negatives=int((negatives < value).sum()),
                false_positives_by_category={
                    name: stats.admitted(value) for name, stats in categories.items()
                },
                false_positive_rate_by_category={
                    name: stats.admitted_rate(value)
                    for name, stats in categories.items()
                },
                false_positives_by_edit={
                    kind: stats.admitted(value) for kind, stats in edits.items()
                },
                false_positive_rate_by_edit={
                    kind: stats.admitted_rate(value) for kind, stats in edits.items()
                },
            )
        )
    return points


def at_threshold(points: list[SweepPoint], threshold: float) -> SweepPoint:
    return min(points, key=lambda point: abs(point.threshold - threshold))


def overlap(left: CategoryStats, right: CategoryStats) -> tuple[float, float]:
    """the band both categories occupy, where no cut can separate them"""
    return max(left.minimum, right.minimum), min(left.maximum, right.maximum)


def separable(left: CategoryStats, right: CategoryStats) -> bool:
    """true when some threshold puts every pair of one above every pair of the other"""
    return left.minimum > right.maximum or right.minimum > left.maximum
