import requests
import json
import os
import time
from datetime import datetime, timedelta
from calendar import monthrange
from dotenv import load_dotenv
from astrapy import DataAPIClient
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
COLLECTION_NAME = "tvshows2026"
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
            dimension=EMBEDDING_DIMENSIONS,
            metric="cosine",
            indexing={"deny": ["none"]}
        )
        print(f"✅ Created new collection: {COLLECTION_NAME} with index on everything")
    except Exception as e:
        if "already exists" in str(e).lower():
            collection = database.get_collection(COLLECTION_NAME)
            print(f"✅ Using existing collection: {COLLECTION_NAME}")
        else:
            raise
    try:
        database.create_collection("crawler_metadata_tv_2026")
        print(f"✅ Created new collection: crawler_metadata_tv_2026")
    except Exception as e:
        if "already exists" in str(e).lower():
            print(f"✅ Using existing collection: crawler_metadata_tv_2026")
        else:
            print(f"⚠️ Warning: Could not create metadata collection: {e}")
    return collection, database

def discover_tv_by_date(page=1, date_min=None, date_max=None):
    url = f"{TMDB_BASE_URL}/discover/tv"
    params = {
        "api_key": TMDB_API_KEY,
        "language": "en-US",
        "sort_by": "popularity.desc",
        "include_adult": "false",
        "page": page,
        "first_air_date.gte": date_min,
        "first_air_date.lte": date_max
    }
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()

def get_tv_full_details(tv_id):
    url = f"{TMDB_BASE_URL}/tv/{tv_id}"
    params = {
        "api_key": TMDB_API_KEY,
        "language": "en-US",
        "append_to_response": "credits,keywords,videos,images,reviews,recommendations,similar,watch/providers,external_ids,content_ratings,aggregate_credits"
    }
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()

def create_autocomplete_documents(tv_details):
    """
    Create flattened autocomplete documents from a TV show.
    Returns a list of arrays [type_code, name, optional_id].
    """
    documents = []
    name = tv_details.get('name')
    tv_id = tv_details.get('id')
    
    # 1. TV show name document (Type 0)
    if name:
        documents.append([0, name, tv_id])

    # 2. Cast member documents (limit to top 5) (Type 1)
    cast = tv_details.get('credits', {}).get('cast', [])
    for idx, actor in enumerate(cast[:5]):
        actor_name = actor.get('name')
        if actor_name:
            documents.append([1, actor_name])

    # 3. Genre documents (Type 2)
    genres = tv_details.get('genres', [])
    for genre in genres:
        genre_name = genre['name'] if isinstance(genre, dict) else genre
        if genre_name:
            documents.append([2, genre_name])
            
    return documents

def create_embedding_text(tv_details):
    parts = []
    parts.append(f"Title: {tv_details.get('name', '')}")
    if tv_details.get('tagline'):
        parts.append(f"Tagline: {tv_details.get('tagline')}")
    if tv_details.get('overview'):
        parts.append(f"Overview: {tv_details.get('overview')}")
    genres = tv_details.get('genres', [])
    if genres:
        genre_names = ', '.join([g['name'] for g in genres])
        parts.append(f"Genres: {genre_names}")
    keywords = tv_details.get('keywords', {}).get('results', [])
    if keywords:
        keyword_names = ', '.join([k['name'] for k in keywords[:20]])
        parts.append(f"Keywords: {keyword_names}")
    credits = tv_details.get('credits', {})
    crew = credits.get('crew', [])
    creators = tv_details.get('created_by', [])
    if creators:
        parts.append(f"Created by: {', '.join([c['name'] for c in creators])}")
    cast = credits.get('cast', [])
    if cast:
        top_cast = ', '.join([c['name'] for c in cast[:5]])
        parts.append(f"Starring: {top_cast}")
    networks = tv_details.get('networks', [])
    if networks:
        network_names = ', '.join([n['name'] for n in networks[:3]])
        parts.append(f"Networks: {network_names}")
    return '\n'.join(parts)

def generate_embedding(text):
    response = openai_client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text,
        encoding_format="float"
    )
    return response.data[0].embedding

def prepare_tv_document(tv_details, embedding):
    watch_providers = {}
    wp_data = tv_details.get('watch/providers', {}).get('results', {})
    for region, providers in wp_data.items():
        if region != 'US':
            continue
        watch_providers[region] = {
            'stream': [p['provider_name'] for p in providers.get('flatrate', [])],
            'rent': [p['provider_name'] for p in providers.get('rent', [])],
            'buy': [p['provider_name'] for p in providers.get('buy', [])]
        }
    credits = tv_details.get('credits', {})
    cast_details = [
        {'name': c['name'], 'character': c.get('character', ''), 'order': c.get('order', 999), 'searchName': c['name'].lower()}
        for c in credits.get('cast', [])[:20]
    ]
    cast = [c['name'] for c in cast_details]
    creators = [c['name'] for c in tv_details.get('created_by', [])]

    document = {
        "_id": str(tv_details['id']),
        "name": tv_details.get('name'),
        "name_lower": tv_details.get('name', '').lower(),
        "original_name": tv_details.get('original_name'),
        "tagline": tv_details.get('tagline'),
        "overview": tv_details.get('overview'),
        "first_air_date": tv_details.get('first_air_date'),
        "last_air_date": tv_details.get('last_air_date'),
        "status": tv_details.get('status'),
        "type": tv_details.get('type'),
        "number_of_seasons": tv_details.get('number_of_seasons'),
        "number_of_episodes": tv_details.get('number_of_episodes'),
        "original_language": tv_details.get('original_language'),
        "vote_average": tv_details.get('vote_average'),
        "vote_count": tv_details.get('vote_count'),
        "popularity": tv_details.get('popularity'),
        "genres": [g['name'] for g in tv_details.get('genres', [])],
        "keywords": [k['name'] for k in tv_details.get('keywords', {}).get('results', [])],
        "creators": creators,
        "cast": cast,
        "cast_details": cast_details,
        "networks": [n['name'] for n in tv_details.get('networks', [])],
        "production_companies": [c['name'] for c in tv_details.get('production_companies', [])],
        "watch_providers": watch_providers,
        "imdb_id": tv_details.get('external_ids', {}).get('imdb_id'),
        "tmdb_id": tv_details.get('id'),
        "homepage": tv_details.get('homepage'),
        "poster_path": tv_details.get('poster_path'),
        "backdrop_path": tv_details.get('backdrop_path'),
        "$vector": embedding,
        "indexed_at": datetime.utcnow().isoformat()
    }
    return document

def update_progress(database, current_date):
    try:
        metadata_col = database.get_collection("crawler_metadata_tv_2026")
        metadata_col.find_one_and_update(
            {"_id": "tmdb_progress_date"},
            {"$set": {"last_date": current_date, "updated_at": datetime.utcnow().isoformat()}},
            upsert=True
        )
    except Exception:
        pass

def get_last_processed_date(database):
    try:
        metadata_col = database.get_collection("crawler_metadata_tv_2026")
        result = metadata_col.find_one({"_id": "tmdb_progress_date"})
        if result and result.get('last_date'):
            return result['last_date']
    except Exception:
        pass
    return None

def process_single_day(collection, date, stats, autocomplete_docs, seen_keys, json_path):
    """
    Process a single day for TV shows. Batch insert by page.
    Returns the number of new documents written since last checkpoint.
    """
    new_since_last_write = 0
    
    # Check total pages for this day
    try:
        data = discover_tv_by_date(page=1, date_min=date, date_max=date)
        total_pages = data.get('total_pages', 1)
        total_results = data.get('total_results', 0)
            
    except Exception as e:
        print(f"\n⚠️  Error checking {date}: {e}")
        return new_since_last_write
    
    # Skip if no results
    if total_results == 0:
        return new_since_last_write
    
    # Cap at 500 pages if needed
    if total_pages > 500:
        print(f"\n⚠️  {date} has {total_pages} pages - capping at 500 (API limit)")
        total_pages = 500
    
    # Process this day page by page
    print(f"\n🚀 Processing {date} ({total_results} TV shows, {min(total_pages, 500)} pages)")
    
    current_page = 1
    while current_page <= total_pages:
        try:
            data = discover_tv_by_date(page=current_page, date_min=date, date_max=date)
            results = data.get('results', [])
            
            if not results:
                break
            
            # Batch process this page
            batch_documents = []
            pbar = tqdm(results, desc=f"{date} | Page {current_page}/{total_pages}", ncols=100)
            
            for tv_show in pbar:
                tv_id = tv_show.get('id')
                stats['processed'] += 1
                
                # Check if already exists
                try:
                    existing = collection.find_one({"tmdb_id": tv_id})
                    if existing:
                        pbar.set_postfix_str(f"⏭️  Exists")
                        stats['already_exists'] += 1
                        continue
                except Exception as e:
                    print(f"Error checking existence: {e}")

                # Get full details
                try:
                    tv_details = get_tv_full_details(tv_id)
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
                
                # Prepare document
                try:
                    embedding_text = create_embedding_text(tv_details)
                    embedding = generate_embedding(embedding_text)
                    document = prepare_tv_document(tv_details, embedding)
                    batch_documents.append(document)
                    
                    pbar.set_postfix_str(f"✅ {tv_details.get('name', '')[:20]}")
                except Exception as e:
                    stats['errors'] += 1
                    print(f"⚠️  Error preparing TV show {tv_id}: {e}")
                
                # Autocomplete doc creation
                try:
                    ac_docs = create_autocomplete_documents(tv_details)
                    for doc in ac_docs:
                        key = (doc[0], doc[1])
                        if key in seen_keys:
                            continue
                        seen_keys.add(key)
                        autocomplete_docs.append(doc)
                        new_since_last_write += 1
                        if new_since_last_write >= 100:
                            with open(json_path, "w") as f:
                                json.dump(autocomplete_docs, f, ensure_ascii=False, separators=(",", ":"))
                            new_since_last_write = 0
                except Exception as e:
                    print(f"⚠️  Error generating autocomplete doc for TV show {tv_id}: {e}")
            
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
    
    return new_since_last_write

def crawl_and_populate_by_day():
    collection, database = init_astra_collections()
    
    stats = {
        'processed': 0,
        'inserted': 0,
        'already_exists': 0,
        'not_found': 0,
        'errors': 0
    }
    
    # Autocomplete export setup
    autocomplete_docs = []
    seen_keys = set()
    os.makedirs("public", exist_ok=True)
    json_path = "public/autocomplete-tv-fresh.json"
    
    # Check for last processed date
    last_date = get_last_processed_date(database)
    if last_date:
        # Start from the day before the last processed date
        start_date = datetime.strptime(last_date, "%Y-%m-%d") - timedelta(days=1)
        print(f"\n📍 Resuming from {start_date.strftime('%Y-%m-%d')} (last processed: {last_date})")
    else:
        start_date = datetime(2025, 12, 31)
        print(f"\n🆕 Starting fresh from {start_date.strftime('%Y-%m-%d')}")
    
    end_date = datetime(1930, 1, 1)
    current_date = start_date
    
    while current_date >= end_date:
        date_str = current_date.strftime("%Y-%m-%d")
        
        try:
            new_since_last_write = process_single_day(
                collection, date_str, stats, autocomplete_docs, seen_keys, json_path
            )
            
            # Update metadata with current date
            update_progress(database, date_str)
            
            # Write any remaining data
            if new_since_last_write > 0:
                with open(json_path, "w") as f:
                    json.dump(autocomplete_docs, f, ensure_ascii=False, separators=(",", ":"))
                    
        except KeyboardInterrupt:
            print("\n🛑 Stopping crawl...")
            # Final write before exiting
            with open(json_path, "w") as f:
                json.dump(autocomplete_docs, f, ensure_ascii=False, separators=(",", ":"))
            print(f"Saved {len(autocomplete_docs)} autocomplete entries before stopping")
            break
        
        # Move to previous day
        current_date -= timedelta(days=1)
    
    # Final write
    with open(json_path, "w") as f:
        json.dump(autocomplete_docs, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Final export: {len(autocomplete_docs)} autocomplete entries to {json_path}")
    
    print(f"\n{'='*80}")
    print(f"🎉 CRAWL COMPLETE")
    print(f"{'='*80}")
    print(f"Total Processed: {stats['processed']:,}")
    print(f"Successfully Inserted: {stats['inserted']:,}")
    print(f"Already Existed: {stats['already_exists']:,}")
    print(f"Not Found (404): {stats['not_found']:,}")
    print(f"Errors: {stats['errors']:,}")
    print(f"{'='*80}\n")

def main():
    print("="*80)
    print("TMDB TV Shows to Astra Vector Database Crawler (By Day)")
    print("="*80)
    print(f"\n⚙️  Configuration:")
    print(f"   Date Range: 2025-12-31 → 1930-01-01 (day by day)")
    print(f"   Embedding Model: {EMBEDDING_MODEL}")
    print(f"   Embedding Dimensions: {EMBEDDING_DIMENSIONS}")
    print()
    crawl_and_populate_by_day()

if __name__ == "__main__":
    main()
