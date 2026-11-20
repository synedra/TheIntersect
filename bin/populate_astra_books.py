"""
Populate Astra DB with the top books from Hardcover (ranked by ratings_count).

Writes documents (with a rich embedding) to `books2026` and autocomplete entries
straight to `autocomplete_entries`; no intermediate files.

Usage:
  python3 bin/populate_astra_books.py                 # top 100,000, resumes if interrupted
  python3 bin/populate_astra_books.py --max-books 500 --no-resume
"""
import argparse
import math
import os
import re
import time
from datetime import datetime, timezone

import requests
from astrapy import DataAPIClient
from astrapy.info import CollectionDefinition
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm

load_dotenv("/Users/synedra/src/TheIntersect/.env")

HARDCOVER_API_URL = os.getenv("HARDCOVER_API_URL", "https://api.hardcover.app/v1/graphql")
HARDCOVER_TOKEN = (os.getenv("HARDCOVER_API_TOKEN") or "").replace("Bearer ", "").strip()
ASTRA_DB_API_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
ASTRA_DB_APPLICATION_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

COLLECTION_NAME = "books2026"
AUTOCOMPLETE_COLLECTION = "autocomplete_entries"
# Reuse the existing metadata collection; Astra's 100-index cap leaves no room for a new one.
METADATA_COLLECTION = "maintenance_metadata"
PROGRESS_DOC_ID = "hardcover_top_books_progress"

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
PAGE_SIZE = 100
# Hardcover allows 60 requests/minute.
REQUEST_DELAY_SECONDS = 1.1
DESCRIPTION_EMBED_CHARS = 1500
MAX_TAGS_PER_CATEGORY = 15
# Astra caps a database at 100 indexes, so only index the fields searched or sorted on.
INDEXED_FIELDS = [
    "title_lower", "authors", "genres", "keywords", "series", "language",
    "release_year", "popularity", "ratings_count", "rating",
]

BOOKS_QUERY = """
query TopBooks($limit: Int!, $offset: Int!) {
  books(
    where: {canonical_id: {_is_null: true}, ratings_count: {_gt: 0}}
    order_by: [{ratings_count: desc}, {id: asc}]
    limit: $limit
    offset: $offset
  ) {
    id slug title subtitle description release_year release_date pages
    rating ratings_count users_count users_read_count lists_count reviews_count
    audio_seconds literary_type_id compilation
    cached_contributors cached_image cached_tags cached_featured_series
    default_physical_edition { isbn_13 isbn_10 pages language { language } publisher { name } }
  }
}
"""

openai_client = OpenAI(api_key=OPENAI_API_KEY)


def gql(query, variables, retries=5):
    for attempt in range(retries):
        try:
            response = requests.post(
                HARDCOVER_API_URL,
                headers={"Authorization": f"Bearer {HARDCOVER_TOKEN}", "Content-Type": "application/json"},
                json={"query": query, "variables": variables},
                timeout=60,
            )
            if response.status_code == 429:
                time.sleep(15 * (attempt + 1))
                continue
            response.raise_for_status()
            payload = response.json()
            if payload.get("errors"):
                raise RuntimeError("; ".join(e.get("message", str(e)) for e in payload["errors"]))
            return payload["data"]
        except (requests.RequestException, RuntimeError) as exc:
            if attempt == retries - 1:
                raise
            print(f"⚠️  Hardcover request failed ({exc}); retrying...")
            time.sleep(5 * (attempt + 1))


def tags_in(book, category):
    tags = (book.get("cached_tags") or {}).get(category) or []
    ordered = sorted(tags, key=lambda t: t.get("count") or 0, reverse=True)
    return [t["tag"] for t in ordered if t.get("tag")][:MAX_TAGS_PER_CATEGORY]


def contributors(book):
    authors, others = [], []
    for c in book.get("cached_contributors") or []:
        name = (c.get("author") or {}).get("name")
        if not name:
            continue
        role = (c.get("contribution") or "").strip()
        if role in ("", "Author"):
            if name not in authors:
                authors.append(name)
        elif name not in others:
            others.append(name)
    return authors, others


def series_info(book):
    featured = book.get("cached_featured_series") or {}
    name = (featured.get("series") or {}).get("name")
    return name, featured.get("position")


def build_embedding_text(doc):
    parts = [f"Title: {doc['title']}"]
    if doc.get("subtitle"):
        parts.append(f"Subtitle: {doc['subtitle']}")
    if doc["authors"]:
        parts.append(f"Authors: {', '.join(doc['authors'])}")
    if doc.get("series"):
        parts.append(f"Series: {doc['series']}" + (f" #{doc['series_position']}" if doc.get("series_position") else ""))
    if doc["genres"]:
        parts.append(f"Genres: {', '.join(doc['genres'])}")
    if doc["moods"]:
        parts.append(f"Moods: {', '.join(doc['moods'])}")
    if doc["tags"]:
        parts.append(f"Themes and tags: {', '.join(doc['tags'])}")
    if doc["content_warnings"]:
        parts.append(f"Content warnings: {', '.join(doc['content_warnings'])}")
    if doc.get("release_year"):
        parts.append(f"Published: {doc['release_year']}")
    if doc.get("language"):
        parts.append(f"Language: {doc['language']}")
    if doc.get("publisher"):
        parts.append(f"Publisher: {doc['publisher']}")
    if doc.get("pages"):
        parts.append(f"Length: {doc['pages']} pages")
    if doc.get("rating"):
        parts.append(f"Average rating: {doc['rating']:.2f} from {doc['ratings_count']} ratings")
    if doc.get("description"):
        parts.append(f"Description: {doc['description'][:DESCRIPTION_EMBED_CHARS]}")
    return "\n".join(parts)


def build_document(book):
    authors, other_contributors = contributors(book)
    series, series_position = series_info(book)
    edition = book.get("default_physical_edition") or {}
    image = book.get("cached_image") or {}
    genres = tags_in(book, "Genre")
    moods = tags_in(book, "Mood")
    tags = tags_in(book, "Tag")
    title = book.get("title") or ""
    rating = book.get("rating")

    doc = {
        "_id": str(book["id"]),
        "hardcover_id": book["id"],
        "slug": book.get("slug"),
        "title": title,
        "title_lower": title.lower(),
        "subtitle": book.get("subtitle"),
        "description": book.get("description"),
        "authors": authors,
        "other_contributors": other_contributors,
        "genres": genres,
        "moods": moods,
        "tags": tags,
        "keywords": list(dict.fromkeys(tags + moods)),
        "content_warnings": tags_in(book, "Content Warning"),
        "series": series,
        "series_position": series_position,
        "release_year": book.get("release_year"),
        "release_date": book.get("release_date"),
        "pages": book.get("pages") or edition.get("pages"),
        "audio_seconds": book.get("audio_seconds"),
        "language": (edition.get("language") or {}).get("language"),
        "publisher": (edition.get("publisher") or {}).get("name"),
        "rating": round(rating, 3) if rating else None,
        "vote_average": round(rating * 2, 2) if rating else None,
        "ratings_count": book.get("ratings_count") or 0,
        "users_count": book.get("users_count") or 0,
        "users_read_count": book.get("users_read_count") or 0,
        "lists_count": book.get("lists_count") or 0,
        "reviews_count": book.get("reviews_count") or 0,
        "popularity": float(book.get("ratings_count") or 0),
        "isbn_13": edition.get("isbn_13"),
        "isbn_10": edition.get("isbn_10"),
        "cover_url": image.get("url"),
        "hardcover_url": f"https://hardcover.app/books/{book.get('slug')}" if book.get("slug") else None,
        "indexed_at": datetime.now(timezone.utc).isoformat(),
    }
    return doc


def embed_batch(texts):
    for attempt in range(5):
        try:
            response = openai_client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
            return [item.embedding for item in response.data]
        except Exception as exc:
            if attempt == 4:
                raise
            print(f"⚠️  Embedding request failed ({exc}); retrying...")
            time.sleep(5 * (attempt + 1))


def normalize_search_name(value):
    out = re.sub(r"[^a-z0-9\s]", " ", str(value or "").lower())
    return re.sub(r"\s+", " ", out).strip()


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


def build_autocomplete_doc(item_type, scope, item_id, name, score):
    search_name = normalize_search_name(name)
    if len(search_name) < 2:
        return None
    doc = {
        "_id": f"{scope}:v2:{item_type}:{item_id or '_'}:{search_name}",
        "scope": scope,
        "type": item_type,
        "name": name,
        "searchName": search_name,
        "prefixes": autocomplete_prefixes(search_name),
        "score": float(score),
        "source": "book",
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    if item_id:
        doc["id"] = item_id
    return doc


def autocomplete_documents(doc):
    score = math.log10(max(1, doc["ratings_count"])) * 2 + (doc.get("rating") or 0)
    entries = [("book", doc["_id"], doc["title"], score)]
    for author in doc["authors"][:2]:
        entries.append(("person", "", author, 10))
    for genre in doc["genres"][:5]:
        entries.append(("genre", "", genre, 8))
    for item_type, entry_id, name, entry_score in entries:
        for scope in ("books",):
            entry = build_autocomplete_doc(item_type, scope, entry_id, name, entry_score)
            if entry:
                yield entry


def init_astra():
    client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
    database = client.get_database(ASTRA_DB_API_ENDPOINT)
    existing = set(database.list_collection_names())
    if COLLECTION_NAME not in existing:
        database.create_collection(
            COLLECTION_NAME,
            definition=CollectionDefinition.builder()
            .set_vector_dimension(EMBEDDING_DIMENSIONS)
            .set_vector_metric("cosine")
            .set_indexing("allow", INDEXED_FIELDS)
            .build(),
        )
        print(f"✅ Created collection {COLLECTION_NAME}")
    return (
        database.get_collection(COLLECTION_NAME),
        database.get_collection(AUTOCOMPLETE_COLLECTION),
        database.get_collection(METADATA_COLLECTION),
    )


def main():
    parser = argparse.ArgumentParser(description="Load top Hardcover books into Astra DB")
    parser.add_argument("--max-books", type=int, default=100000, help="How many top-rated books to load (default 100000)")
    parser.add_argument("--no-resume", action="store_true", help="Ignore stored progress and start from the top")
    args = parser.parse_args()

    for name, value in [("HARDCOVER_API_TOKEN", HARDCOVER_TOKEN), ("ASTRA_DB_API_ENDPOINT", ASTRA_DB_API_ENDPOINT),
                        ("ASTRA_DB_APPLICATION_TOKEN", ASTRA_DB_APPLICATION_TOKEN), ("OPENAI_API_KEY", OPENAI_API_KEY)]:
        if not value:
            raise SystemExit(f"Missing {name} in environment.")

    books_col, autocomplete_col, metadata_col = init_astra()

    offset = 0
    if not args.no_resume:
        progress = metadata_col.find_one({"_id": PROGRESS_DOC_ID})
        if progress:
            offset = int(progress.get("offset") or 0)
            print(f"Resuming from offset {offset:,}")

    stats = {"inserted": 0, "existing": 0, "errors": 0}
    seen_autocomplete = set()
    bar = tqdm(total=args.max_books, initial=offset, unit="book")

    while offset < args.max_books:
        limit = min(PAGE_SIZE, args.max_books - offset)
        data = gql(BOOKS_QUERY, {"limit": limit, "offset": offset})
        books = data["books"]
        if not books:
            break

        docs = [build_document(b) for b in books if b.get("title")]
        existing_ids = {d["_id"] for d in books_col.find({"_id": {"$in": [d["_id"] for d in docs]}}, projection={"_id": 1})}
        fresh = [d for d in docs if d["_id"] not in existing_ids]
        stats["existing"] += len(docs) - len(fresh)

        if fresh:
            embeddings = embed_batch([build_embedding_text(d) for d in fresh])
            for d, vector in zip(fresh, embeddings):
                d["$vector"] = vector
            try:
                books_col.insert_many(fresh, ordered=False)
                stats["inserted"] += len(fresh)
            except Exception as exc:
                stats["errors"] += 1
                print(f"⚠️  insert_many error at offset {offset}: {exc}")

        new_entries = []
        for d in docs:
            for entry in autocomplete_documents(d):
                if entry["_id"] not in seen_autocomplete:
                    seen_autocomplete.add(entry["_id"])
                    new_entries.append(entry)
        if new_entries:
            try:
                autocomplete_col.insert_many(new_entries, ordered=False)
            except Exception as exc:
                # Duplicates from earlier runs are expected on resume; unordered inserts still write the rest.
                if "DOCUMENT_ALREADY_EXISTS" not in str(exc):
                    print(f"⚠️  autocomplete insert error at offset {offset}: {exc}")

        offset += len(books)
        bar.update(len(books))
        bar.set_postfix(inserted=stats["inserted"], existing=stats["existing"], errors=stats["errors"])
        if not args.no_resume:
            metadata_col.find_one_and_replace(
                {"_id": PROGRESS_DOC_ID},
                {"_id": PROGRESS_DOC_ID, "offset": offset, "updated_at": datetime.now(timezone.utc).isoformat()},
                upsert=True,
            )
        time.sleep(REQUEST_DELAY_SECONDS)

    bar.close()
    print(f"Done. {stats}")


if __name__ == "__main__":
    main()
