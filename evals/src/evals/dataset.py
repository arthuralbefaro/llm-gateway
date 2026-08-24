"""dataset of labelled prompt pairs and the contract for scored results

python never embeds anything, similarity is produced by the gateway's own
runtime and read back from a results file
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

Category = Literal[
    "paraphrase",
    "same_topic",
    "cross_lingual",
    "unrelated",
    "minimal_pair",
]

Language = Literal["en", "pt"]

# bumped whenever the results file layout changes in a way that makes an older
# file unreadable rather than merely stale
CONTRACT_VERSION = 1

# a hit on these is the cache working, a hit on anything else is a wrong answer
SHOULD_HIT: frozenset[str] = frozenset({"paraphrase"})

CATEGORIES: tuple[Category, ...] = (
    "paraphrase",
    "same_topic",
    "cross_lingual",
    "unrelated",
    "minimal_pair",
)


@dataclass(frozen=True)
class Pair:
    """one labelled comparison between two prompts"""

    id: str
    category: Category
    left: str
    right: str
    left_lang: Language
    right_lang: Language
    topic: str
    note: str = ""

    @property
    def should_hit(self) -> bool:
        return self.category in SHOULD_HIT

    @property
    def is_cross_lingual(self) -> bool:
        return self.left_lang != self.right_lang


@dataclass(frozen=True)
class Provenance:
    """shat produced a results file

    carried with the numbers rather than beside them, because a similarity is
    only comparable to another one computed the same way
    """

    model: str
    dtype: str
    runtime: str
    runtime_version: str
    graph_optimization: str
    prefix: str
    pooling: str
    normalized: bool
    generated_at: str
    dataset_version: int
    dataset_sha256: str

    def summary(self) -> str:
        return (
            f"{self.model} {self.dtype} via {self.runtime} "
            f"({self.runtime_version}), dataset v{self.dataset_version} "
            f"{self.dataset_sha256[:12]}, generated {self.generated_at}"
        )


@dataclass(frozen=True)
class ScoredPair:
    """a pair with the similarity the gateway's runtime measured for it"""

    pair: Pair
    similarity: float


@dataclass(frozen=True)
class Results:
    contract_version: int
    provenance: Provenance
    scored: list[ScoredPair]


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def data_dir() -> Path:
    return repo_root() / "evals" / "data"


def load_pairs(path: Path | None = None) -> list[Pair]:
    """reads the dataset, one json object per line"""
    target = path or (data_dir() / "pairs.jsonl")
    pairs: list[Pair] = []
    for line in target.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        pairs.append(Pair(**json.loads(line)))
    return pairs


def write_pairs(pairs: list[Pair], path: Path) -> None:
    lines = [json.dumps(asdict(pair), ensure_ascii=False) for pair in pairs]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def dataset_digest(path: Path | None = None) -> str:
    target = path or (data_dir() / "pairs.jsonl")
    return hashlib.sha256(target.read_bytes()).hexdigest()


def load_results(path: Path | None = None, *, verify: bool = True) -> Results:
    """Reads a scored results file.

    Refuses a file with no provenance, and by default refuses one scored
    against a different dataset than the one on disk. A similarity is only
    meaningful next to a description of what produced it.
    """
    target = path or (data_dir() / "similarities.json")
    if not target.exists():
        raise FileNotFoundError(
            f"{target} not found, run `node evals/scripts/score_pairs.mjs` first"
        )

    raw = json.loads(target.read_text(encoding="utf-8"))
    if "provenance" not in raw:
        raise ValueError(f"{target} has no provenance and cannot be compared")

    contract_version = int(raw.get("contract_version", 0))
    if contract_version != CONTRACT_VERSION:
        raise ValueError(
            f"{target} is contract v{contract_version}, "
            f"this code reads v{CONTRACT_VERSION}"
        )

    provenance = Provenance(**raw["provenance"])
    if verify:
        current = dataset_digest()
        if provenance.dataset_sha256 != current:
            raise ValueError(
                f"{target} scored dataset {provenance.dataset_sha256[:12]} but "
                f"pairs.jsonl is now {current[:12]}, rescore before analysing"
            )

    scored = [
        ScoredPair(pair=Pair(**row["pair"]), similarity=float(row["similarity"]))
        for row in raw["rows"]
    ]
    return Results(
        contract_version=contract_version, provenance=provenance, scored=scored
    )
