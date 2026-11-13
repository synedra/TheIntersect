#!/usr/bin/env python3
"""
Daily data refresh orchestrator.

What it does:
1) Runs incremental TMDB updates for movies + TV (`bin/update_astra_movies.py`).
2) Optionally runs boardgame refresh command (`BOARDGAME_UPDATE_COMMAND`) if configured.
3) Rebuilds autocomplete metadata buckets (`bin/build_autocomplete_metadata_buckets.js`).
4) Writes/reads freshness checkpoints in Astra `maintenance_metadata`.

Usage:
  python3 bin/daily_refresh_data.py
  python3 bin/daily_refresh_data.py --status-only
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

from astrapy import DataAPIClient
from dotenv import load_dotenv

METADATA_COLLECTION = "maintenance_metadata"
STATUS_DOCS = ["status_movie", "status_tv", "status_boardgame", "status_daily_refresh"]


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def run_command(command: list[str], label: str, required: bool = True) -> bool:
    print(f"\n▶ {label}")
    print("  $ " + " ".join(shlex.quote(part) for part in command))
    try:
        subprocess.run(command, check=True)
        print(f"✓ {label} succeeded")
        return True
    except subprocess.CalledProcessError as exc:
        print(f"✗ {label} failed with exit code {exc.returncode}")
        if required:
            raise
        return False


def get_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def get_database():
    endpoint = os.getenv("ASTRA_DB_API_ENDPOINT")
    token = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
    if not endpoint or not token:
        return None
    client = DataAPIClient(token)
    return client.get_database(endpoint)


def upsert_status(db, doc_id: str, payload: dict):
    if db is None:
        return
    coll = db.get_collection(METADATA_COLLECTION)
    body = {"_id": doc_id, **payload, "updated_at": now_iso()}
    coll.find_one_and_replace({"_id": doc_id}, body, upsert=True)


def read_statuses(db) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if db is None:
        return out
    coll = db.get_collection(METADATA_COLLECTION)
    for doc_id in STATUS_DOCS:
        doc = coll.find_one({"_id": doc_id})
        if doc:
            out[doc_id] = doc
    return out


def print_statuses(statuses: dict[str, dict]):
    if not statuses:
        print("No status documents found (or Astra credentials unavailable).")
        return

    print("\n=== Freshness status (maintenance_metadata) ===")
    for key in STATUS_DOCS:
        doc = statuses.get(key)
        if not doc:
            continue
        reduced = {
            k: v
            for k, v in doc.items()
            if k in {"_id", "last_date", "last_run_at", "last_success_at", "updated_at", "note", "source", "source_mtime_utc", "steps"}
        }
        print(json.dumps(reduced, indent=2, sort_keys=True, default=str))


def status_only_mode() -> int:
    load_dotenv()
    db = get_database()
    statuses = read_statuses(db)
    print_statuses(statuses)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run daily content refresh and write freshness checkpoints.")
    parser.add_argument("--status-only", action="store_true", help="Only print current freshness/checkpoint status.")
    args = parser.parse_args()

    if args.status_only:
        return status_only_mode()

    load_dotenv(override=True)

    repo_root = get_repo_root()
    os.chdir(repo_root)

    db = get_database()
    started_at = now_iso()
    summary = {
        "started_at": started_at,
        "steps": {},
    }

    try:
        summary["steps"]["tmdb_incremental_update"] = run_command(
            [sys.executable, str(repo_root / "bin" / "update_astra_movies.py")],
            "Incremental TMDB sync (movies + TV)",
            required=True,
        )

        boardgame_cmd = (os.getenv("BOARDGAME_UPDATE_COMMAND") or "").strip()
        if boardgame_cmd:
            cmd = shlex.split(boardgame_cmd)
            boardgame_ok = run_command(cmd, "Boardgame refresh", required=False)
            summary["steps"]["boardgame_refresh"] = boardgame_ok
            upsert_status(
                db,
                "status_boardgame",
                {
                    "last_run_at": now_iso(),
                    "last_success_at": now_iso() if boardgame_ok else None,
                    "source": "BOARDGAME_UPDATE_COMMAND",
                    "note": "Boardgame refresh command executed from env var.",
                },
            )
        else:
            boardgame_source = repo_root / "public" / "autocomplete-boardgames.json"
            source_mtime = None
            if boardgame_source.exists():
                source_mtime = dt.datetime.fromtimestamp(boardgame_source.stat().st_mtime, tz=dt.timezone.utc).isoformat()
            upsert_status(
                db,
                "status_boardgame",
                {
                    "last_run_at": now_iso(),
                    "source": "public/autocomplete-boardgames.json",
                    "source_mtime_utc": source_mtime,
                    "note": "No BOARDGAME_UPDATE_COMMAND configured; boardgame DB sync skipped.",
                },
            )
            summary["steps"]["boardgame_refresh"] = False

        summary["steps"]["autocomplete_metadata_rebuild"] = run_command(
            ["node", str(repo_root / "bin" / "build_autocomplete_metadata_buckets.js")],
            "Rebuild autocomplete metadata buckets",
            required=True,
        )

        summary["finished_at"] = now_iso()
        summary["ok"] = all(bool(v) for k, v in summary["steps"].items() if k != "boardgame_refresh")

        upsert_status(
            db,
            "status_daily_refresh",
            {
                "last_run_at": summary["finished_at"],
                "last_success_at": summary["finished_at"] if summary["ok"] else None,
                "steps": summary["steps"],
                "note": "Daily refresh orchestrator execution result.",
            },
        )

        print("\n=== Daily refresh summary ===")
        print(json.dumps(summary, indent=2))

        print_statuses(read_statuses(db))
        return 0 if summary["ok"] else 2

    except Exception as exc:
        summary["finished_at"] = now_iso()
        summary["ok"] = False
        summary["error"] = str(exc)

        upsert_status(
            db,
            "status_daily_refresh",
            {
                "last_run_at": summary["finished_at"],
                "last_success_at": None,
                "steps": summary.get("steps", {}),
                "note": f"Daily refresh failed: {exc}",
            },
        )

        print("\n=== Daily refresh failed ===")
        print(json.dumps(summary, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
