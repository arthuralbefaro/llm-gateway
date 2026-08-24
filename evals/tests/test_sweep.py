"""invariants of the sweep, and the findings it produced locked as assertion.

the findings are tested so a later change to the dataset or the scorer that
would overturn them fails here instead of quietly changing a chart
"""

import pytest

from evals.dataset import load_results
from evals.sweep import (
    PRODUCTION_THRESHOLD,
    at_threshold,
    by_category,
    by_edit_kind,
    separable,
    subset,
    sweep,
)

RESULTS = load_results()
STATS = by_category(RESULTS.scored)
EDITS = by_edit_kind(RESULTS.scored)
POINTS = sweep(RESULTS.scored)

PARAPHRASES = STATS["paraphrase"].n
NEGATIVES = sum(s.n for name, s in STATS.items() if name != "paraphrase")


class TestSweepInvariants:
    def test_positives_are_always_accounted_for(self):
        for point in POINTS:
            assert point.true_positives + point.false_negatives == PARAPHRASES

    def test_negatives_are_always_accounted_for(self):
        for point in POINTS:
            assert point.false_positives + point.true_negatives == NEGATIVES

    def test_false_negatives_never_fall_as_the_threshold_rises(self):
        values = [p.false_negatives for p in POINTS]
        assert values == sorted(values)

    def test_false_positives_never_rise_as_the_threshold_rises(self):
        values = [p.false_positives for p in POINTS]
        assert values == sorted(values, reverse=True)

    def test_recall_is_a_share_of_paraphrases(self):
        for point in POINTS:
            assert 0.0 <= point.recall <= 1.0

    def test_precision_is_undefined_only_when_nothing_is_admitted(self):
        for point in POINTS:
            admitted = point.true_positives + point.false_positives
            assert (point.precision is None) == (admitted == 0)

    def test_category_false_positives_sum_to_the_total(self):
        for point in POINTS:
            assert sum(point.false_positives_by_category.values()) == (
                point.false_positives
            )

    def test_edit_false_positives_sum_to_the_minimal_pair_total(self):
        for point in POINTS:
            assert (
                sum(point.false_positives_by_edit.values())
                == (point.false_positives_by_category["minimal_pair"])
            )


class TestFindings:
    def test_minimal_pairs_sit_above_paraphrases(self):
        """the inversion. Everything else in the sweep follows from it"""
        assert STATS["minimal_pair"].percentile(50) > STATS["paraphrase"].percentile(50)

    def test_no_threshold_separates_paraphrase_from_minimal_pair(self):
        assert not separable(STATS["paraphrase"], STATS["minimal_pair"])

    def test_no_threshold_separates_paraphrase_from_cross_lingual(self):
        """ADR 0001 measured this on eleven pairs, it holds on eighty"""
        assert not separable(STATS["paraphrase"], STATS["cross_lingual"])

    def test_unrelated_controls_are_separable(self):
        """the one category a threshold does handle, which is why one exists"""
        assert separable(STATS["paraphrase"], STATS["unrelated"])

    def test_negation_is_admitted_more_often_than_paraphrase_at_every_threshold(self):
        for point in POINTS:
            assert point.false_positive_rate_by_edit["negation"] >= point.recall

    def test_entity_swaps_are_caught_before_paraphrases_are_lost(self):
        """the opposite of negation, and the reason the split is reported"""
        for point in POINTS:
            assert point.false_positive_rate_by_edit["entity"] <= point.recall + 1e-9

    def test_precision_never_reaches_half(self):
        best = max(p.precision for p in POINTS if p.precision is not None)
        assert best < 0.5

    @pytest.mark.parametrize(
        ("field", "expected"),
        [
            ("true_positives", 16),
            ("false_negatives", 24),
            ("false_positives", 20),
            ("true_negatives", 160),
        ],
    )
    def test_production_threshold_counts(self, field, expected):
        point = at_threshold(POINTS, PRODUCTION_THRESHOLD)
        assert getattr(point, field) == expected

    def test_every_false_positive_in_production_is_a_minimal_pair(self):
        point = at_threshold(POINTS, PRODUCTION_THRESHOLD)
        by_category_counts = point.false_positives_by_category
        assert by_category_counts["minimal_pair"] == point.false_positives
        assert by_category_counts["same_topic"] == 0
        assert by_category_counts["cross_lingual"] == 0
        assert by_category_counts["unrelated"] == 0

    def test_all_negations_survive_the_production_threshold(self):
        point = at_threshold(POINTS, PRODUCTION_THRESHOLD)
        assert point.false_positives_by_edit["negation"] == EDITS["negation"].n

    def test_language_shows_up_in_the_unrelated_controls(self):
        """same topic distance, different languages, so only language differs"""
        same = [
            s.similarity
            for s in subset(RESULTS.scored, category="unrelated")
            if not s.pair.is_cross_lingual
        ]
        across = [
            s.similarity
            for s in subset(RESULTS.scored, category="unrelated")
            if s.pair.is_cross_lingual
        ]
        assert sum(same) / len(same) > sum(across) / len(across)
