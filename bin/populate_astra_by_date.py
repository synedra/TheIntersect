import argparse
import requests
import math
import re
import os
import time
from datetime import datetime, timedelta, timezone
from calendar import monthrange
from dotenv import load_dotenv
from astrapy import DataAPIClient
from astrapy.info import CollectionDefinition
from openai import OpenAI
from tqdm import tqdm

# Load environment variables
load_dotenv()

# API Keys and Configuration
TMDB_API_KEY = os.getenv("TMDB_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ASTRA_DB_API_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
ASTRA_DB_APPLICATION_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")

# Validate environment variables
if not TMDB_API_KEY:
    raise ValueError("TMDB_API_KEY not found in .env file")
if not OPENAI_API_KEY:
    raise ValueError("OPENAI_API_KEY not found in .env file")
if not ASTRA_DB_API_ENDPOINT:
    raise ValueError("ASTRA_DB_API_ENDPOINT not found in .env file")
if not ASTRA_DB_APPLICATION_TOKEN:
    raise ValueError("ASTRA_DB_APPLICATION_TOKEN not found in .env file")

TMDB_BASE_URL = "https://api.themoviedb.org/3"
COLLECTION_NAME = "movies2026"
EMBEDDING_MODEL = "text-embedding-3-small"  # 1536 dimensions
EMBEDDING_DIMENSIONS = 1536

# Initialize OpenAI client
openai_client = OpenAI(api_key=OPENAI_API_KEY)

def init_astra_collections():
    print("Initializing Astra DB connection...")
    client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
    database = client.get_database(ASTRA_DB_API_ENDPOINT)
    try:
        collection = database.create_collection(
            COLLECTION_NAME,
            definition=CollectionDefinition.builder()
            .set_vector_dimension(EMBEDDING_DIMENSIONS)
            .set_vector_metric("cosine")
            .build(),
        )
        print(f"✅ Created new collection: {COLLECTION_NAME} with index on everything")
    except Exception as e:
        if "already exists" in str(e).lower():
            collection = database.get_collection(COLLECTION_NAME)
            print(f"✅ Using existing collection: {COLLECTION_NAME}")
        else:
            raise
    try:
        database.create_collection("crawler_metadata_2026_filtered")
        print(f"✅ Created new collection: crawler_metadata_2026_filtered")
    except Exception as e:
        if "already exists" in str(e).lower():
            print(f"✅ Using existing collection: crawler_metadata_2026_filtered")
        else:
            print(f"⚠️ Warning: Could not create metadata collection: {e}")
    return collection, database

def discover_movies_by_date(page=1, date_min=None, date_max=None):
    url = f"{TMDB_BASE_URL}/discover/movie"
    params = {
        "api_key": TMDB_API_KEY,
        "sort_by": "popularity.desc",
        "include_adult": "false",
        "include_video": False,
        "runtime.gte": 60,  # Minimum 60 minutes - ONLY FOR MOVIES
        "page": page,
        "primary_release_date.gte": date_min,
        "primary_release_date.lte": date_max
    }
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()

def get_movie_full_details(movie_id):
    url = f"{TMDB_BASE_URL}/movie/{movie_id}"
    params = {
        "api_key": TMDB_API_KEY,
        "language": "en-US",
        "append_to_response": "credits,keywords,videos,images,reviews,recommendations,similar,watch/providers,release_dates,external_ids"
    }
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()

def update_progress(database, current_date):
    try:
        metadata_col = database.get_collection("crawler_metadata_2026_filtered")
        metadata_col.find_one_and_update(
            {"_id": "tmdb_progress_date"},
            {"$set": {"last_date": current_date, "updated_at": datetime.utcnow().isoformat()}},
            upsert=True
        )
    except Exception:
        pass

def get_last_processed_date(database):
    try:
        metadata_col = database.get_collection("crawler_metadata_2026_filtered")
        result = metadata_col.find_one({"_id": "tmdb_progress_date"})
        if result and result.get('last_date'):
            return result['last_date']
    except Exception:
        pass
    return None

def normalize_search_name(value):
    out = re.sub(r"[^a-z0-9\s]", " ", str(value or "").lower())
    return re.sub(r"\s+", " ", out).strip()

def build_autocomplete_doc(item_type, scope, item_id, name, score, source):
    search_name = normalize_search_name(name)
    if len(search_name) < 2:
        return None
    doc = {
        "_id": f"{scope}:{item_type}:{item_id or '_'}:{search_name}",
        "scope": scope,
        "type": item_type,
        "name": name,
        "searchName": search_name,
        "score": float(score),
        "source": source,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    if item_id:
        doc["id"] = item_id
    return doc

def create_autocomplete_documents(movie_details):
    """
    Build autocomplete_entries documents (same shape as build_autocomplete_buckets.py)
    for a movie, its top cast, and its genres, in both the "media" and "all" scopes.
    """
    documents = []
    title = movie_details.get('title')
    item_id = str(movie_details.get('id'))
    popularity = float(movie_details.get('popularity') or 0)
    score = popularity + math.log10(max(1, movie_details.get('vote_count') or 0))

    entries = []
    if title:
        entries.append(("movie", item_id, title, score))
    for actor in movie_details.get('credits', {}).get('cast', [])[:5]:
        if actor.get('name'):
            entries.append(("person", "", actor['name'], 10))
    for genre in movie_details.get('genres', []):
        genre_name = genre['name'] if isinstance(genre, dict) else genre
        if genre_name:
            entries.append(("genre", "", genre_name, 8))

    for item_type, entry_id, name, entry_score in entries:
        for scope in ("media", "all"):
            doc = build_autocomplete_doc(item_type, scope, entry_id, name, entry_score, "movie")
            if doc:
                documents.append(doc)
    return documents

def create_embedding_text(movie_details):
    parts = []
    parts.append(f"Title: {movie_details.get('title', '')}")
    if movie_details.get('tagline'):
        parts.append(f"Tagline: {movie_details.get('tagline')}")
    if movie_details.get('overview'):
        parts.append(f"Overview: {movie_details.get('overview')}")
    genres = movie_details.get('genres', [])
    if genres:
        genre_names = ', '.join([g['name'] for g in genres])
        parts.append(f"Genres: {genre_names}")
    keywords = movie_details.get('keywords', {}).get('keywords', [])
    if keywords:
        keyword_names = ', '.join([k['name'] for k in keywords[:20]])
        parts.append(f"Keywords: {keyword_names}")
    credits = movie_details.get('credits', {})
    crew = credits.get('crew', [])
    directors = [c['name'] for c in crew if c['job'] == 'Director']
    if directors:
        parts.append(f"Director: {', '.join(directors)}")
    cast = credits.get('cast', [])
    if cast:
        top_cast = ', '.join([c['name'] for c in cast[:5]])
        parts.append(f"Starring: {top_cast}")
    companies = movie_details.get('production_companies', [])
    if companies:
        company_names = ', '.join([c['name'] for c in companies[:3]])
        parts.append(f"Production: {company_names}")
    return '\n'.join(parts)

def generate_embedding(text):
    response = openai_client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text,
        encoding_format="float"
    )
    return response.data[0].embedding

def prepare_movie_document(movie_details, embedding):
    watch_providers = {}
    wp_data = movie_details.get('watch/providers', {}).get('results', {})
    for region, providers in wp_data.items():
        if region != 'US':
            continue
        watch_providers[region] = {
            'stream': [p['provider_name'] for p in providers.get('flatrate', [])],
            'rent': [p['provider_name'] for p in providers.get('rent', [])],
            'buy': [p['provider_name'] for p in providers.get('buy', [])]
        }
    credits = movie_details.get('credits', {})
    cast_details = [
        {'name': c['name'], 'character': c.get('character', ''), 'order': c.get('order', 999), 'searchName': c['name'].lower()}
        for c in credits.get('cast', [])[:20]
    ]
    cast = [c['name'] for c in cast_details]
    crew = credits.get('crew', [])
    directors = [c['name'] for c in crew if c['job'] == 'Director']
    writers = [c['name'] for c in crew if c['department'] == 'Writing'][:5]
    producers = [c['name'] for c in crew if c['job'] == 'Producer'][:5]

    document = {
        "_id": str(movie_details['id']),
        "title": movie_details.get('title'),
        "title_lower": movie_details.get('title', '').lower(),
        "original_title": movie_details.get('original_title'),
        "tagline": movie_details.get('tagline'),
        "overview": movie_details.get('overview'),
        "runtime": movie_details.get('runtime'),
        "release_date": movie_details.get('release_date'),
        "status": movie_details.get('status'),
        "original_language": movie_details.get('original_language'),
        "vote_average": movie_details.get('vote_average'),
        "vote_count": movie_details.get('vote_count'),
        "popularity": movie_details.get('popularity'),
        "budget": movie_details.get('budget'),
        "revenue": movie_details.get('revenue'),
        "genres": [g['name'] for g in movie_details.get('genres', [])],
        "keywords": [k['name'] for k in movie_details.get('keywords', {}).get('keywords', [])],
        "directors": directors,
        "writers": writers,
        "producers": producers,
        "cast": cast,
        "cast_details": cast_details,
        "production_companies": [c['name'] for c in movie_details.get('production_companies', [])],
        "watch_providers": watch_providers,
        "imdb_id": movie_details.get('external_ids', {}).get('imdb_id'),
        "tmdb_id": movie_details.get('id'),
        "homepage": movie_details.get('homepage'),
        "poster_path": movie_details.get('poster_path'),
        "backdrop_path": movie_details.get('backdrop_path'),
        "$vector": embedding,
        "indexed_at": datetime.utcnow().isoformat()
    }
    return document

def process_single_day(collection, autocomplete_col, date, stats, seen_keys):
    """
    Process a single day. If it has >500 pages, cap at 500 (API limit).
    """
    # Check total pages for this day
    try:
        data = discover_movies_by_date(page=1, date_min=date, date_max=date)
        total_pages = data.get('total_pages', 1)
        total_results = data.get('total_results', 0)
            
    except Exception as e:
        print(f"\n⚠️  Error checking {date}: {e}")
        return
    
    # Skip if no results
    if total_results == 0:
        return
    
    # Cap at 500 pages if needed
    if total_pages > 500:
        print(f"\n⚠️  {date} has {total_pages} pages - capping at 500 (API limit)")
        total_pages = 500
    
    # Process this day page by page
    print(f"\n🚀 Processing {date} ({total_results} movies, {min(total_pages, 500)} pages)")
    
    current_page = 1
    while current_page <= total_pages:
        try:
            data = discover_movies_by_date(page=current_page, date_min=date, date_max=date)
            results = data.get('results', [])
            
            if not results:
                break
            
            # Batch process this page
            batch_documents = []
            pbar = tqdm(results, desc=f"{date} | Page {current_page}/{total_pages}", ncols=100)
            
            for movie in pbar:
                movie_id = movie.get('id')
                stats['processed'] += 1
                
                # Check if already exists
                try:
                    existing = collection.find_one({"tmdb_id": movie_id})
                    if existing:
                        pbar.set_postfix_str(f"⏭️  Exists")
                        stats['already_exists'] += 1
                        continue
                except Exception as e:
                    print(f"Error checking existence: {e}")

                # Get full details
                try:
                    movie_details = get_movie_full_details(movie_id)
                except requests.exceptions.HTTPError as e:
                    if e.response.status_code == 404:
                        stats['not_found'] += 1
                        pbar.set_postfix_str(f"❌ Not Found")
                        continue
                    else:
                        stats['errors'] += 1
                        continue
                except Exception as e:
                    stats['errors'] += 1
                    continue
                
                # Skip movies shorter than 60 minutes
                runtime = movie_details.get('runtime', 0)
                if not runtime or runtime < 60:
                    stats['skipped_short'] += 1
                    pbar.set_postfix_str(f"⏭️  Short ({runtime}m)")
                    continue

                # Prepare document
                try:
                    embedding_text = create_embedding_text(movie_details)
                    embedding = generate_embedding(embedding_text)
                    document = prepare_movie_document(movie_details, embedding)
                    batch_documents.append(document)
                    
                    pbar.set_postfix_str(f"✅ {movie_details.get('title', '')[:20]}")
                except Exception as e:
                    stats['errors'] += 1
                    print(f"⚠️  Error preparing movie {movie_id}: {e}")
                
                # Autocomplete entries, written straight to Astra
                try:
                    for doc in create_autocomplete_documents(movie_details):
                        if doc["_id"] in seen_keys:
                            continue
                        seen_keys.add(doc["_id"])
                        autocomplete_col.find_one_and_replace({"_id": doc["_id"]}, doc, upsert=True)
                except Exception as e:
                    print(f"⚠️  Error writing autocomplete entries for movie {movie_id}: {e}")
            
            # Batch insert all documents from this page
            if batch_documents:
                try:
                    for doc in batch_documents:
                        collection.find_one_and_replace(
                            {"_id": doc["_id"]},
                            doc,
                            upsert=True
                        )
                    stats['inserted'] += len(batch_documents)
                except Exception as e:
                    stats['errors'] += len(batch_documents)
                    print(f"⚠️  Error batch inserting page {current_page}: {e}")
            
            current_page += 1
            time.sleep(0.25)
            
        except KeyboardInterrupt:
            raise
        except Exception as e:
            print(f"\n⚠️  Error on page {current_page}: {e}")
            stats['errors'] += 1
            break

def crawl_and_populate_by_day(start, end, resume=True):
    collection, database = init_astra_collections()
    autocomplete_col = database.get_collection("autocomplete_entries")
    
    stats = {
        'processed': 0,
        'inserted': 0,
        'already_exists': 0,
        'not_found': 0,
        'errors': 0,
        'skipped_short': 0
    }
    
    seen_keys = set()

    start_date, end_date = start, end
    last_date = get_last_processed_date(database) if resume else None
    if last_date:
        resume_from = datetime.strptime(last_date, "%Y-%m-%d") - timedelta(days=1)
        if end_date <= resume_from < start_date:
            start_date = resume_from
            print(f"\n📍 Resuming from {start_date.strftime('%Y-%m-%d')} (last processed: {last_date})")
    if start_date == start:
        print(f"\n🆕 Starting from {start_date.strftime('%Y-%m-%d')}")
    current_date = start_date
    
    while current_date >= end_date:
        date_str = current_date.strftime("%Y-%m-%d")
        
        try:
            process_single_day(collection, autocomplete_col, date_str, stats, seen_keys)
            if resume:
                update_progress(database, date_str)
        except KeyboardInterrupt:
            print("\n🛑 Stopping crawl...")
            break
        
        # Move to previous day
        current_date -= timedelta(days=1)
    
    print(f"\n{'='*80}")
    print(f"🎉 CRAWL COMPLETE")
    print(f"{'='*80}")
    print(f"Total Processed: {stats['processed']:,}")
    print(f"Successfully Inserted: {stats['inserted']:,}")
    print(f"Already Existed: {stats['already_exists']:,}")
    print(f"Skipped (<60m): {stats['skipped_short']:,}")
    print(f"Not Found (404): {stats['not_found']:,}")
    print(f"Errors: {stats['errors']:,}")
    print(f"{'='*80}\n")

def parse_date(value):
    return datetime.strptime(value, "%Y-%m-%d")

def main():
    parser = argparse.ArgumentParser(description="Crawl TMDB day by day (newest to oldest) into Astra DB.")
    parser.add_argument("--start", type=parse_date, default=datetime(2025, 12, 31), help="Newest date, YYYY-MM-DD (default 2025-12-31)")
    parser.add_argument("--end", type=parse_date, default=datetime(1930, 1, 1), help="Oldest date, YYYY-MM-DD (default 1930-01-01)")
    parser.add_argument("--no-resume", action="store_true", help="Ignore and do not update the stored progress date")
    args = parser.parse_args()
    if args.end > args.start:
        parser.error("--end must not be after --start")
    print("="*80)
    print("TMDB to Astra Vector Database Crawler (By Day)")
    print("="*80)
    print(f"\n⚙️  Configuration:")
    print(f"   Date Range: {args.start:%Y-%m-%d} → {args.end:%Y-%m-%d} (day by day)")
    print(f"   Caps at 500 pages per day (API limit)")
    print(f"   Embedding Model: {EMBEDDING_MODEL}")
    print(f"   Embedding Dimensions: {EMBEDDING_DIMENSIONS}")
    print()
    crawl_and_populate_by_day(args.start, args.end, resume=not args.no_resume)

if __name__ == "__main__":
    main()