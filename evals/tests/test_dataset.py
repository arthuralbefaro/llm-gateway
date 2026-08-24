"""invariants the dataset has to hold, so a bad edit fails loudly

the labels are the ground truth for everything downstream. Nothing else checks
them, so what can be checked mechanically is checked here
"""

import json
from pathlib import Path

import pytest

from evals.dataset import (
    CATEGORIES,
    CONTRACT_VERSION,
    Pair,
    data_dir,
    dataset_digest,
    load_pairs,
    load_results,
)

PAIRS = load_pairs()


def test_dataset_is_not_empty():
    assert len(PAIRS) == 220


def test_ids_are_unique():
    ids = [pair.id for pair in PAIRS]
    assert len(set(ids)) == len(ids)


def test_every_category_is_represented():
    present = {pair.category for pair in PAIRS}
    assert present == set(CATEGORIES)


def test_no_pair_compares_a_text_with_itself():
    same = [pair.id for pair in PAIRS if pair.left == pair.right]
    assert same == []


def test_only_paraphrase_is_labelled_should_hit():
    hits = {pair.category for pair in PAIRS if pair.should_hit}
    assert hits == {"paraphrase"}


def test_cross_lingual_pairs_actually_cross_languages():
    for pair in PAIRS:
        if pair.category == "cross_lingual":
            assert pair.is_cross_lingual, pair.id


def test_paraphrase_and_minimal_pairs_stay_within_one_language():
    for pair in PAIRS:
        if pair.category in {"paraphrase", "minimal_pair", "same_topic"}:
            assert not pair.is_cross_lingual, pair.id


def test_both_languages_are_covered():
    langs = {pair.left_lang for pair in PAIRS} | {pair.right_lang for pair in PAIRS}
    assert langs == {"en", "pt"}


def test_minimal_pairs_declare_their_edit_kind():
    kinds = {pair.note for pair in PAIRS if pair.category == "minimal_pair"}
    assert kinds == {"entity", "negation", "temporal"}


def test_minimal_pairs_are_a_small_edit():
    """a minimal pair that shares no vocabulary is not testing what it claims"""
    for pair in PAIRS:
        if pair.category != "minimal_pair":
            continue
        left = set(pair.left.lower().split())
        right = set(pair.right.lower().split())
        overlap = len(left & right) / max(len(left), len(right))
        assert overlap >= 0.5, f"{pair.id} overlaps only {overlap:.2f}"


def test_unrelated_controls_never_share_a_topic():
    for pair in PAIRS:
        if pair.category == "unrelated":
            left, right = pair.topic.split("|")
            assert left != right


def test_pairs_file_is_stable_under_a_rebuild():
    """the build script must be deterministic or diffs become unreadable"""
    import subprocess
    import sys

    before = dataset_digest()
    script = Path(__file__).resolve().parents[1] / "scripts" / "build_dataset.py"
    subprocess.run([sys.executable, str(script)], check=True, capture_output=True)
    assert dataset_digest() == before


class TestResultsContract:
    def test_results_match_the_dataset_on_disk(self):
        results = load_results()
        assert len(results.scored) == len(PAIRS)
        assert results.contract_version == CONTRACT_VERSION

    def test_provenance_fields_are_populated(self):
        provenance = load_results().provenance
        assert provenance.model
        assert provenance.dtype
        assert "onnxruntime-node" in provenance.runtime_version
        assert "unresolved" not in provenance.runtime_version
        assert provenance.dataset_sha256 == dataset_digest()

    def test_similarities_are_in_range(self):
        for scored in load_results().scored:
            assert -1.0 <= scored.similarity <= 1.0, scored.pair.id

    def test_a_results_file_without_provenance_is_refused(self, tmp_path):
        broken = tmp_path / "similarities.json"
        broken.write_text(json.dumps({"contract_version": 1, "rows": []}))
        with pytest.raises(ValueError, match="no provenance"):
            load_results(broken)

    def test_a_results_file_scored_against_another_dataset_is_refused(self, tmp_path):
        raw = json.loads((data_dir() / "similarities.json").read_text(encoding="utf-8"))
        raw["provenance"]["dataset_sha256"] = "0" * 64
        stale = tmp_path / "similarities.json"
        stale.write_text(json.dumps(raw), encoding="utf-8")
        with pytest.raises(ValueError, match="rescore"):
            load_results(stale)


def test_pair_round_trips_through_json():
    pair = PAIRS[0]
    line = json.dumps(pair.__dict__, ensure_ascii=False)
    assert Pair(**json.loads(line)) == pair
