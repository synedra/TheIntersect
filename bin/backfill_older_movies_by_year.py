#!/usr/bin/env python3
"""
Backfill older movies by year into movies2026.

This script targets historical gaps (e.g. beyond the last 10 years)
by iterating TMDB discover pages per year and upserting trimmed docs.

Usage:
  python3 bin/backfill_older_movies_by_year.py --start-year 2015 --end-year 1930 --max-pages 20
"""

import argparse
import datetime
import os
import time

import requests
from astrapy import DataAPIClient
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

TMDB_TOKEN = os.getenv("TMDB_READ_TOKEN")
OPENAI_KEY = os.getenv("OPENAI_API_KEY")
ASTRA_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
ASTRA_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
METADATA_COLLECTION = "maintenance_metadata"
MOVIE_COLLECTION = "movies2026"

if not all([TMDB_TOKEN, OPENAI_KEY, ASTRA_TOKEN, ASTRA_ENDPOINT]):
    raise ValueError("Missing required env vars: TMDB_READ_TOKEN, OPENAI_API_KEY, ASTRA_DB_APPLICATION_TOKEN, ASTRA_DB_API_ENDPOINT")

openai_client = OpenAI(api_key=OPENAI_KEY)
astra_client = DataAPIClient(ASTRA_TOKEN)
db = astra_client.get_database(ASTRA_ENDPOINT)


def auth_headers():
    return {
        "Authorization": f"Bearer {TMDB_TOKEN}",
        "accept": "application/json",
    }


def discover_movies(year: int, page: int):
    url = "https://api.themoviedb.org/3/discover/movie"
    params = {
        "include_adult": "false",
        "include_video": "false",
        "language": "en-US",
        "sort_by": "popularity.desc",
        "primary_release_year": year,
        "page": page,
    }
    r = requests.get(url, headers=auth_headers(), params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def get_movie_details(movie_id: int):
    url = f"https://api.themoviedb.org/3/movie/{movie_id}"
    params = {
        "language": "en-US",
        "append_to_response": "credits,keywords,watch/providers,external_ids",
    }
    r = requests.get(url, headers=auth_headers(), params=params, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def get_embedding(text: str):
    if not text:
        return None
    resp = openai_client.embeddings.create(input=text, model="text-embedding-3-small")
    return resp.data[0].embedding


def to_trimmed_movie_doc(data: dict):
    title = data.get("title")
    overview = data.get("overview", "")
    if not title and not overview:
        return None

    credits = data.get("credits", {}) if isinstance(data.get("credits"), dict) else {}
    cast_raw = credits.get("cast", []) if isinstance(credits.get("cast"), list) else []
    crew_raw = credits.get("crew", []) if isinstance(credits.get("crew"), list) else []

    cast_details = []
    cast_names = []
    for actor in cast_raw[:20]:
        name = actor.get("name")
        if not name:
            continue
        cast_names.append(name)
        cast_details.append(
            {
                "name": name,
                "character": actor.get("character", ""),
                "order": actor.get("order", 999),
                "searchName": name.lower(),
            }
        )

    directors = [c.get("name") for c in crew_raw if c.get("job") == "Director" and c.get("name")][:5]
    writers = [c.get("name") for c in crew_raw if c.get("department") == "Writing" and c.get("name")][:8]
    producers = [c.get("name") for c in crew_raw if c.get("job") == "Producer" and c.get("name")][:8]

    kws = data.get("keywords", {}) if isinstance(data.get("keywords"), dict) else {}
    kw_rows = kws.get("keywords", []) if isinstance(kws.get("keywords"), list) else []
    keyword_names = [k.get("name") for k in kw_rows if isinstance(k, dict) and k.get("name")][:80]

    wp = data.get("watch/providers", {}) if isinstance(data.get("watch/providers"), dict) else {}
    wp_results = wp.get("results", {}) if isinstance(wp.get("results"), dict) else {}
    us = wp_results.get("US", {}) if isinstance(wp_results.get("US"), dict) else {}
    watch_providers = {
        "US": {
            "stream": [p.get("provider_name") for p in us.get("flatrate", []) if p.get("provider_name")],
            "rent": [p.get("provider_name") for p in us.get("rent", []) if p.get("provider_name")],
            "buy": [p.get("provider_name") for p in us.get("buy", []) if p.get("provider_name")],
        }
    }

    text = f"{title}: {overview}" if title else overview
    vec = get_embedding(text)
    if not vec:
        return None

    return {
        "_id": str(data.get("id")),
        "type": "movie",
        "tmdb_id": data.get("id"),
        "title": title,
        "title_lower": title.lower() if title else "",
        "original_title": data.get("original_title"),
        "tagline": data.get("tagline"),
        "overview": overview,
        "runtime": data.get("runtime"),
        "release_date": data.get("release_date"),
        "status": data.get("status"),
        "original_language": data.get("original_language"),
        "vote_average": data.get("vote_average"),
        "vote_count": data.get("vote_count"),
        "popularity": data.get("popularity"),
        "budget": data.get("budget"),
        "revenue": data.get("revenue"),
        "genres": [g.get("name") for g in data.get("genres", []) if isinstance(g, dict) and g.get("name")],
        "keywords": keyword_names,
        "directors": directors,
        "writers": writers,
        "producers": producers,
        "cast": cast_names,
        "cast_details": cast_details,
        "production_companies": [c.get("name") for c in data.get("production_companies", []) if isinstance(c, dict) and c.get("name")],
        "watch_providers": watch_providers,
        "imdb_id": (data.get("external_ids") or {}).get("imdb_id") if isinstance(data.get("external_ids"), dict) else None,
        "homepage": data.get("homepage"),
        "poster_path": data.get("poster_path"),
        "backdrop_path": data.get("backdrop_path"),
        "$vector": vec,
        "indexed_at": datetime.datetime.utcnow().isoformat(),
    }


def read_backfill_checkpoint():
    coll = db.get_collection(METADATA_COLLECTION)
    doc = coll.find_one({"_id": "status_movie_backfill"})
    if not doc:
        return None
    return doc.get("last_year")


def write_backfill_checkpoint(year: int):
    coll = db.get_collection(METADATA_COLLECTION)
    coll.find_one_and_replace(
        {"_id": "status_movie_backfill"},
        {
            "_id": "status_movie_backfill",
            "last_year": int(year),
            "updated_at": datetime.datetime.utcnow().isoformat(),
        },
        upsert=True,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-year", type=int, default=2015)
    parser.add_argument("--end-year", type=int, default=1930)
    parser.add_argument("--max-pages", type=int, default=20, help="Max discover pages per year (<=500).")
    parser.add_argument("--sleep-ms", type=int, default=120)
    parser.add_argument("--resume", action="store_true", help="Resume from maintenance_metadata.status_movie_backfill.last_year")
    args = parser.parse_args()

    if args.max_pages < 1:
        raise ValueError("--max-pages must be >= 1")

    coll = db.get_collection(MOVIE_COLLECTION)

    start_year = args.start_year
    if args.resume:
        checkpoint = read_backfill_checkpoint()
        if isinstance(checkpoint, int):
            start_year = checkpoint

    inserted = 0
    updated = 0
    skipped = 0
    errors = 0

    for year in range(start_year, args.end_year - 1, -1):
        print(f"\n=== Year {year} ===")
        try:
            first = discover_movies(year, 1)
        except Exception as exc:
            print(f"Failed year {year} page 1: {exc}")
            write_backfill_checkpoint(year)
            continue

        total_pages = int(first.get("total_pages", 1) or 1)
        pages = min(total_pages, args.max_pages, 500)

        for page in range(1, pages + 1):
            payload = first if page == 1 else discover_movies(year, page)
            results = payload.get("results", []) or []
            print(f"Year {year} page {page}/{pages}: {len(results)} ids")

            for row in results:
                movie_id = row.get("id")
                if not movie_id:
                    continue
                try:
                    existing = coll.find_one({"_id": str(movie_id)}, projection={"_id": 1})
                    details = get_movie_details(movie_id)
                    if not details:
                        skipped += 1
                        continue
                    doc = to_trimmed_movie_doc(details)
                    if not doc:
                        skipped += 1
                        continue
                    coll.find_one_and_replace({"_id": doc["_id"]}, doc, upsert=True)
                    if existing:
                        updated += 1
                    else:
                        inserted += 1
                except Exception as exc:
                    errors += 1
                    print(f"  Error movie {movie_id}: {exc}")
                time.sleep(args.sleep_ms / 1000.0)

        write_backfill_checkpoint(year - 1)

    print("\n=== Backfill done ===")
    print(f"Inserted: {inserted}")
    print(f"Updated: {updated}")
    print(f"Skipped: {skipped}")
    print(f"Errors: {errors}")


if __name__ == "__main__":
    main()
