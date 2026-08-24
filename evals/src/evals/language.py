"""whether language can be recovered from the embedding the gateway already computes

partitioning needs a language label for one prompt at a time, so the operative
question is per prompt rather than per pair.
everything here reads vectors
produced by the Node runtime and never computes one
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from evals.dataset import Provenance, ScoredPair, data_dir


@dataclass(frozen=True)
class Corpus:
    texts: list[str]
    langs: list[str]
    vectors: np.ndarray
    provenance: Provenance

    @property
    def n(self) -> int:
        return len(self.texts)

    def mask(self, lang: str) -> np.ndarray:
        return np.array([value == lang for value in self.langs])

    def similarity_matrix(self) -> np.ndarray:
        """vectors arrive L2 normalized, so the gram matrix is the cosine matrix"""
        return self.vectors @ self.vectors.T


def load_corpus(path: Path | None = None) -> Corpus:
    target = path or (data_dir() / "vectors.json")
    if not target.exists():
        raise FileNotFoundError(
            f"{target} not found, run `node evals/scripts/score_pairs.mjs` first"
        )
    raw = json.loads(target.read_text(encoding="utf-8"))
    rows = raw["rows"]
    return Corpus(
        texts=[row["text"] for row in rows],
        langs=[row["lang"] for row in rows],
        vectors=np.array([row["vector"] for row in rows], dtype=np.float64),
        provenance=Provenance(**raw["provenance"]),
    )


def nearest_centroid_loo(corpus: Corpus) -> tuple[float, dict[str, float], list[int]]:
    """leave one out accuracy of the cheapest possible language readout

    two mean vectors and a dot product. If this separates the languages then the
    signal is already in the embedding and no classifier has to be trained
    """
    labels = sorted(set(corpus.langs))
    langs = np.array(corpus.langs)
    correct = 0
    per_lang = {label: [0, 0] for label in labels}
    wrong: list[int] = []

    for index in range(corpus.n):
        held = corpus.vectors[index]
        scores = {}
        for label in labels:
            members = (langs == label).copy()
            members[index] = False
            centroid = corpus.vectors[members].mean(axis=0)
            scores[label] = float(held @ centroid)
        predicted = max(scores, key=lambda key: scores[key])
        actual = corpus.langs[index]
        per_lang[actual][1] += 1
        if predicted == actual:
            correct += 1
            per_lang[actual][0] += 1
        else:
            wrong.append(index)

    accuracy = correct / corpus.n
    by_lang = {label: hit / total for label, (hit, total) in per_lang.items()}
    return accuracy, by_lang, wrong


def centroid_margin(corpus: Corpus) -> np.ndarray:
    """signed distance to the decision boundary, positive when classified correctly"""
    labels = sorted(set(corpus.langs))
    langs = np.array(corpus.langs)
    centroids = {label: corpus.vectors[langs == label].mean(axis=0) for label in labels}
    margins = np.zeros(corpus.n)
    for index in range(corpus.n):
        own = corpus.langs[index]
        other = next(label for label in labels if label != own)
        margins[index] = corpus.vectors[index] @ (centroids[own] - centroids[other])
    return margins


def paired_language_gap(scored: list[ScoredPair]) -> dict[str, np.ndarray]:
    """the language penalty in two regimes, paired by topic so nothing else moves

    topic distinct comes from the unrelated controls, topic shared compares a
    same-language paraphrase against the same question in the other language,
    which is where the signal has no difference of subject helping it
    """
    same_topic_same_lang: dict[str, float] = {}
    same_topic_cross_lang: dict[str, float] = {}
    distinct_same_lang: dict[str, list[float]] = {}
    distinct_cross_lang: dict[str, float] = {}

    for item in scored:
        pair = item.pair
        if pair.category == "paraphrase" and pair.left_lang == "en":
            same_topic_same_lang[pair.topic] = item.similarity
        elif pair.category == "cross_lingual" and pair.note == "base":
            same_topic_cross_lang[pair.topic] = item.similarity
        elif pair.category == "unrelated":
            if pair.is_cross_lingual:
                distinct_cross_lang[pair.topic] = item.similarity
            else:
                distinct_same_lang.setdefault(pair.topic, []).append(item.similarity)

    shared = np.array(
        [
            same_topic_same_lang[topic] - same_topic_cross_lang[topic]
            for topic in sorted(same_topic_same_lang)
            if topic in same_topic_cross_lang
        ]
    )
    distinct = np.array(
        [
            float(np.mean(distinct_same_lang[topic])) - distinct_cross_lang[topic]
            for topic in sorted(distinct_cross_lang)
            if topic in distinct_same_lang
        ]
    )
    return {"topic_shared": shared, "topic_distinct": distinct}


@dataclass(frozen=True)
class RetrievalOutcome:
    query: str
    lang: str
    best_text: str
    best_lang: str
    best_similarity: float
    best_is_cross_language: bool


def top_one(corpus: Corpus, *, restrict_to_language: bool) -> list[RetrievalOutcome]:
    """nearest neighbour for every text, which is what the cache actually does

    pairwise labels cannot show whether a wrong language entry would outrank the
    right one, because that is a property of the whole table and not of a pair
    """
    matrix = corpus.similarity_matrix()
    np.fill_diagonal(matrix, -np.inf)
    langs = np.array(corpus.langs)

    outcomes: list[RetrievalOutcome] = []
    for index in range(corpus.n):
        scores = matrix[index].copy()
        if restrict_to_language:
            scores[langs != corpus.langs[index]] = -np.inf
        best = int(np.argmax(scores))
        outcomes.append(
            RetrievalOutcome(
                query=corpus.texts[index],
                lang=corpus.langs[index],
                best_text=corpus.texts[best],
                best_lang=corpus.langs[best],
                best_similarity=float(scores[best]),
                best_is_cross_language=corpus.langs[best] != corpus.langs[index],
            )
        )
    return outcomes


def partitioned_false_positives(
    scored: list[ScoredPair], threshold: float
) -> tuple[int, int]:
    """false positives with and without a language partition

    a partition removes cross language pairs from consideration entirely, so its
    whole effect is whatever those pairs were contributing
    """
    without = sum(
        1 for s in scored if not s.pair.should_hit and s.similarity >= threshold
    )
    with_partition = sum(
        1
        for s in scored
        if not s.pair.should_hit
        and s.similarity >= threshold
        and not s.pair.is_cross_lingual
    )
    return without, with_partition
