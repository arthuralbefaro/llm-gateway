"""the cache value measurement, and the refusals it makes"""

from datetime import datetime, timedelta

from evals.cache_value import (
    EntryRow,
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

REQUESTS = load_requests()
ENTRIES = load_entries()
PROV = provenance(REQUESTS, ENTRIES)


class TestProvenance:
    def test_the_data_is_recognised_as_generated(self):
        assert PROV.is_synthetic

    def test_every_prompt_is_templated(self):
        assert PROV.templated_share == 1.0

    def test_it_came_from_one_caller(self):
        assert PROV.api_keys == 1

    def test_the_whole_run_is_under_a_minute(self):
        assert PROV.request_span_seconds < 60

    def test_entries_were_written_in_one_burst(self):
        """Which is why nothing here can speak to entry lifetime."""
        assert PROV.entry_span_seconds < 60


class TestHits:
    def test_most_entries_were_never_used(self):
        assert hit_distribution(ENTRIES)[0] == 179

    def test_the_benefit_is_concentrated(self):
        used, top, share = concentration(ENTRIES)
        assert used == 32
        assert top == 20
        assert share < 0.10

    def test_recorded_hits_match_the_requests(self):
        assert sum(entry.hits for entry in ENTRIES) == sum(
            row.cache_hit for row in REQUESTS
        )


class TestLatency:
    def test_the_three_outcomes_are_ordered(self):
        stats = latency_by_outcome(REQUESTS)
        assert stats["exact"]["p50"] < stats["semantic"]["p50"] < stats["miss"]["p50"]

    def test_the_median_moves_a_lot(self):
        overall = overall_latency(REQUESTS)
        miss = latency_by_outcome(REQUESTS)["miss"]
        assert miss["p50"] / overall["p50"] > 20

    def test_the_tail_barely_moves(self):
        """The finding: a 58% hit rate buys almost nothing at p99."""
        overall = overall_latency(REQUESTS)
        miss = latency_by_outcome(REQUESTS)["miss"]
        assert overall["p99"] / miss["p99"] > 0.95

    def test_the_hit_rate_is_reported_beside_the_latency(self):
        assert 0.5 < hit_rate(REQUESTS) < 0.7


class TestDisuseRefusal:
    def test_no_window_can_be_answered_from_this_data(self):
        for window in (3600, 86400, 604800):
            assert disuse_policy_effect(ENTRIES, window) is None

    def test_the_guard_allows_a_long_enough_observation(self):
        """The refusal is about this data, not about the question."""
        start = datetime.fromisoformat("2026-01-01T00:00:00+00:00")
        entries = [
            EntryRow(
                prompt_head="x",
                prompt_length=1,
                model="m",
                hits=0,
                created_at=start,
                last_used_at=start + timedelta(seconds=offset),
            )
            for offset in (0, 3600, 100_000)
        ]
        result = disuse_policy_effect(entries, 3600)
        assert result is not None
        evicted, note = result
        assert evicted == 2
        assert "100000s" in note
