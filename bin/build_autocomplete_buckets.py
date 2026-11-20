#!/usr/bin/env python3
"""
Build autocomplete entries in Astra from movie, TV, and boardgame collections.

Uses CassIO for Astra connection initialization and astrapy Data API for
collection reads/writes.
"""

from __future__ import annotations

import math
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Set

import cassio
from astrapy import DataAPIClient
from dotenv import load_dotenv

load_dotenv(override=True)

ASTRA_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
ASTRA_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
ASTRA_DB_ID = os.getenv("ASTRA_DB_ID") or os.getenv("ASTRA_DB_DATABASE_ID")
ASTRA_KEYSPACE = os.getenv("ASTRA_DB_KEYSPACE")
BOARDGAME_KEYSPACE = os.getenv("ASTRA_BOARDGAME_KEYSPACE", "boardgames")

MEDIA_COLLECTIONS = (
    ("movies2026", "movie"),
    ("tvshows2026", "tv"),
)
BOARDGAME_COLLECTION = "bgg_board_games"
TARGET_COLLECTION = "autocomplete_entries"


@dataclass
class BuildState:
    batch: List[dict]
    seen_persons: Set[str]
    seen_genres: Set[str]


def normalize_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_search_name(value: str) -> str:
    out = normalize_text(value).lower()
    out = re.sub(r"[^a-z0-9\s]", " ", out)
    out = re.sub(r"\s+", " ", out).strip()
    return out


def to_score(value: object, fallback: float = 0.0) -> float:
    try:
        n = float(value)
        if math.isfinite(n):
            return n
    except Exception:
        pass
    return float(fallback)


def infer_database_id_from_endpoint(endpoint: Optional[str]) -> Optional[str]:
    if not endpoint:
        return None
    # e.g. https://<dbid>-<region>.apps.astra.datastax.com
    m = re.search(r"https?://([a-z0-9]{8,})-[^.]+\.", endpoint)
    if m:
        return m.group(1)
    return None


def autocomplete_prefixes(search_name):
    prefixes = set()
    for end in range(3, min(len(search_name), 16) + 1):
        prefixes.add(search_name[:end].rstrip())
    for token in search_name.split()[1:]:
        for end in range(3, min(len(token), 8) + 1):
            prefixes.add(token[:end])
    if len(search_name) < 3:
        prefixes.add(search_name)
    return sorted(prefixes)


def build_doc(*, item_type: str, scope: str, item_id: str, name: str, score: float, source: str, boardgamerank: Optional[int] = None, popularity: Optional[float] = None) -> Optional[dict]:
    search_name = normalize_search_name(name)
    if not search_name or len(search_name) < 2:
        return None

    safe_id = str(item_id or "")
    doc_id = f"{scope}:{item_type}:{safe_id or '_'}:{search_name}"

    doc = {
        "_id": doc_id,
        "scope": scope,
        "type": item_type,
        "name": name,
        "searchName": search_name,
        "prefixes": autocomplete_prefixes(search_name),
        "score": float(score),
        "source": source,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }

    if safe_id:
        doc["id"] = safe_id
    if boardgamerank is not None:
        doc["boardgamerank"] = boardgamerank
    if popularity is not None:
        doc["popularity"] = float(popularity)

    return doc


def normalize_genres(value: object) -> List[str]:
    if not value:
        return []
    if isinstance(value, list):
        out = []
        for g in value:
            if isinstance(g, str):
                n = normalize_text(g)
            elif isinstance(g, dict):
                n = normalize_text(g.get("name"))
            else:
                n = ""
            if n:
                out.append(n)
        return out
    if isinstance(value, str):
        return [normalize_text(x) for x in value.split(",") if normalize_text(x)]
    return []


def flush_batch(target_collection, state: BuildState) -> None:
    if not state.batch:
        return
    try:
        target_collection.insert_many(state.batch, ordered=False)
    except Exception as exc:  # noqa: BLE001
        # With ordered=False the non-duplicate documents are still inserted;
        # duplicate _ids carry identical content, so they are safe to skip.
        if "DOCUMENT_ALREADY_EXISTS" not in str(exc):
            raise
    state.batch.clear()


def collect_media_entries(source_collection, media_type: str, target_collection, state: BuildState) -> None:
    scanned = 0
    for doc in source_collection.find({}, projection={"$vector": 0}):
        scanned += 1

        title = normalize_text(doc.get("title") or doc.get("name") or doc.get("original_title") or doc.get("original_name"))
        item_id = str(doc.get("id") or doc.get("_id") or "")

        if title and item_id:
            popularity = to_score(doc.get("popularity"), 0)
            vote_count = to_score(doc.get("vote_count"), 0)
            score = popularity + math.log10(max(1, vote_count))

            for scope in ("media", "all"):
                row = build_doc(
                    item_type=media_type,
                    scope=scope,
                    item_id=item_id,
                    name=title,
                    score=score,
                    source=media_type,
                    popularity=popularity,
                )
                if row:
                    state.batch.append(row)

        cast = doc.get("cast_details") if isinstance(doc.get("cast_details"), list) else []
        for person in cast:
            person_name = normalize_text((person or {}).get("name"))
            if not person_name:
                continue

            # Key on the normalized search name: distinct raw spellings (punctuation,
            # diacritics) collapse to the same document _id.
            person_key = normalize_search_name(person_name)
            if not person_key or person_key in state.seen_persons:
                continue
            state.seen_persons.add(person_key)

            person_score = 10 + to_score((person or {}).get("popularity"), 0)
            person_id = str((person or {}).get("id") or "")

            for scope in ("media", "all"):
                row = build_doc(
                    item_type="person",
                    scope=scope,
                    item_id=person_id,
                    name=person_name,
                    score=person_score,
                    source=media_type,
                )
                if row:
                    state.batch.append(row)

        for genre in normalize_genres(doc.get("genres")):
            key = normalize_search_name(genre)
            if not key or key in state.seen_genres:
                continue
            state.seen_genres.add(key)

            for scope in ("media", "all"):
                row = build_doc(
                    item_type="genre",
                    scope=scope,
                    item_id="",
                    name=genre,
                    score=8,
                    source=media_type,
                )
                if row:
                    state.batch.append(row)

        if len(state.batch) >= 1500:
            flush_batch(target_collection, state)

        if scanned % 20000 == 0:
            print(f"[{media_type}] scanned {scanned} docs...")

    print(f"[{media_type}] done; scanned {scanned} docs.")


def collect_boardgame_entries(source_collection, target_collection, state: BuildState) -> None:
    scanned = 0
    for doc in source_collection.find({}, projection={"$vector": 0}):
        scanned += 1

        title = normalize_text(doc.get("name") or doc.get("name0") or doc.get("title"))
        item_id = str(doc.get("bggid") or doc.get("id") or doc.get("_id") or "")

        if title and item_id:
            rank_raw = to_score(doc.get("boardgamerank"), 999999)
            users_rated = to_score(doc.get("usersrated"), 0)
            avg = to_score(doc.get("average"), 0)
            rank_bonus = (100000 / rank_raw) if rank_raw > 0 else 0
            score = rank_bonus + (avg * 10) + math.log10(max(1, users_rated))

            rank_int = int(rank_raw) if math.isfinite(rank_raw) else None
            for scope in ("boardgames", "all"):
                row = build_doc(
                    item_type="boardgame",
                    scope=scope,
                    item_id=item_id,
                    name=title,
                    score=score,
                    source="boardgame",
                    boardgamerank=rank_int,
                )
                if row:
                    state.batch.append(row)

        if len(state.batch) >= 1500:
            flush_batch(target_collection, state)

        if scanned % 20000 == 0:
            print(f"[boardgame] scanned {scanned} docs...")

    print(f"[boardgame] done; scanned {scanned} docs.")


def init_cassio() -> None:
    if not ASTRA_TOKEN:
        raise RuntimeError("Missing ASTRA_DB_APPLICATION_TOKEN")

    db_id = ASTRA_DB_ID or infer_database_id_from_endpoint(ASTRA_ENDPOINT)
    if not db_id:
        raise RuntimeError(
            "Could not infer ASTRA database id. Set ASTRA_DB_ID or ASTRA_DB_DATABASE_ID."
        )

    init_kwargs: Dict[str, object] = {
        "database_id": db_id,
        "token": ASTRA_TOKEN,
    }
    if ASTRA_KEYSPACE:
        init_kwargs["keyspace"] = ASTRA_KEYSPACE

    cassio.init(**init_kwargs)


def main() -> None:
    if not ASTRA_ENDPOINT or not ASTRA_TOKEN:
        raise RuntimeError("Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN")

    # CassIO is not required for the Data API reads/writes below; don't fail the build on it.
    try:
        init_cassio()
    except Exception as exc:  # noqa: BLE001
        print(f"cassio init skipped ({exc}); continuing with Data API only.")

    client = DataAPIClient(ASTRA_TOKEN)
    media_db = client.get_database(ASTRA_ENDPOINT)
    boardgame_db = client.get_database(ASTRA_ENDPOINT, keyspace=BOARDGAME_KEYSPACE)

    target_collection = media_db.get_collection(TARGET_COLLECTION)

    print("Resetting autocomplete_entries collection...")
    try:
        target_collection.delete_many({})
    except Exception as exc:  # noqa: BLE001
        print(f"delete_many failed; continuing insert-only run: {exc}")

    state = BuildState(batch=[], seen_persons=set(), seen_genres=set())

    print("Collecting autocomplete entries from Astra...")
    for collection_name, media_type in MEDIA_COLLECTIONS:
        source = media_db.get_collection(collection_name)
        collect_media_entries(source, media_type, target_collection, state)

    boardgames = boardgame_db.get_collection(BOARDGAME_COLLECTION)
    collect_boardgame_entries(boardgames, target_collection, state)

    flush_batch(target_collection, state)
    print("Done. Autocomplete entries rebuilt in collection 'autocomplete_entries'.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to build autocomplete buckets: {exc}")
        sys.exit(1)
