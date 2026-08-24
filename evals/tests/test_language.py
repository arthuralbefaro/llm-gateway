"""the partitioning measurement, with its findings locked as assertions"""

import numpy as np

from evals.dataset import load_results
from evals.language import (
    centroid_margin,
    load_corpus,
    nearest_centroid_loo,
    paired_language_gap,
    partitioned_false_positives,
    top_one,
)
from evals.sweep import PRODUCTION_THRESHOLD, at_threshold, sweep, thresholds

CORPUS = load_corpus()
SCORED = load_results().scored
GAPS = paired_language_gap(SCORED)


class TestCorpus:
    def test_every_unique_text_is_present(self):
        assert CORPUS.n == 160

    def test_both_languages_are_equally_represented(self):
        assert int(CORPUS.mask("en").sum()) == 80
        assert int(CORPUS.mask("pt").sum()) == 80

    def test_vectors_arrive_normalized(self):
        norms = np.linalg.norm(CORPUS.vectors, axis=1)
        assert np.allclose(norms, 1.0, atol=1e-5)

    def test_vectors_match_the_scored_provenance(self):
        expected = load_results().provenance.dataset_sha256
        assert CORPUS.provenance.dataset_sha256 == expected


class TestLanguageSignal:
    def test_signal_survives_when_topic_is_shared(self):
        """the regime where difference of subject is not helping the signal"""
        assert float(np.median(GAPS["topic_shared"])) > 0

    def test_shared_topic_signal_is_not_weaker_than_distinct_topic(self):
        assert float(np.median(GAPS["topic_shared"])) >= float(
            np.median(GAPS["topic_distinct"])
        )

    def test_the_pair_level_signal_does_invert_sometimes(self):
        """three topics where a translation outscored a same language paraphrase"""
        assert int((GAPS["topic_shared"] <= 0).sum()) == 3

    def test_language_is_recoverable_from_a_single_embedding(self):
        accuracy, by_lang, wrong = nearest_centroid_loo(CORPUS)
        assert accuracy == 1.0
        assert wrong == []
        assert set(by_lang) == {"en", "pt"}

    def test_no_text_sits_near_the_decision_boundary(self):
        assert float(centroid_margin(CORPUS).min()) > 0.01


class TestRetrieval:
    def test_a_partition_makes_cross_language_retrieval_impossible(self):
        for outcome in top_one(CORPUS, restrict_to_language=True):
            assert not outcome.best_is_cross_language

    def test_without_a_partition_some_nearest_neighbours_cross_languages(self):
        outcomes = top_one(CORPUS, restrict_to_language=False)
        assert sum(1 for o in outcomes if o.best_is_cross_language) == 17

    def test_none_of_them_reach_the_production_threshold(self):
        """which is why the partition removes nothing at the value in use"""
        outcomes = top_one(CORPUS, restrict_to_language=False)
        crossing = [
            o
            for o in outcomes
            if o.best_is_cross_language and o.best_similarity >= PRODUCTION_THRESHOLD
        ]
        assert crossing == []


class TestPartitionEffect:
    def test_a_partition_never_adds_false_positives(self):
        for threshold in thresholds():
            without, with_partition = partitioned_false_positives(
                SCORED, float(threshold)
            )
            assert with_partition <= without

    def test_a_partition_removes_nothing_at_the_production_threshold(self):
        without, with_partition = partitioned_false_positives(
            SCORED, PRODUCTION_THRESHOLD
        )
        assert without == with_partition == 20

    def test_a_partition_removes_a_lot_lower_down(self):
        without, with_partition = partitioned_false_positives(SCORED, 0.88)
        assert without - with_partition == 23

    def test_a_partition_recovers_no_paraphrases_within_todays_error_budget(self):
        """the finding that decides etapa 3"""
        points = sweep(SCORED)
        today = at_threshold(points, PRODUCTION_THRESHOLD)
        viable = [
            point
            for point in points
            if partitioned_false_positives(SCORED, point.threshold)[1]
            <= today.false_positives
        ]
        lowest = min(viable, key=lambda point: point.threshold)
        assert lowest.false_negatives == today.false_negatives

    def test_the_binding_constraint_is_intra_language(self):
        point = at_threshold(sweep(SCORED), PRODUCTION_THRESHOLD)
        assert point.false_positives_by_category["cross_lingual"] == 0
        counts = point.false_positives_by_category
        assert counts["minimal_pair"] == point.false_positives
