import requests
import json
import os
import time
from datetime import datetime
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
            dimension=EMBEDDING_DIMENSIONS,
            metric="cosine",
            indexing={"deny": ["none"]}  # Example indexed fields
        )
        print(f"✅ Created new collection: {COLLECTION_NAME} with index on everything")
    except Exception as e:
        if "already exists" in str(e).lower():
            collection = database.get_collection(COLLECTION_NAME)
            print(f"✅ Using existing collection: {COLLECTION_NAME} with index on tmdb_id, cast.searchName, genres, title")
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
    return collection

def discover_movies_filtered(page=1):
    url = f"{TMDB_BASE_URL}/discover/movie"
    params = {
        "api_key": TMDB_API_KEY,
        "language": "en-US",
        "sort_by": "popularity.desc",
        "include_adult": "false",
        "include_video": False,
        "page": page,
        "with_runtime.gte": 60,
        "vote_average.gte": 5,
        "vote_count.gte": 50
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

def create_autocomplete_documents(movie_details):
    """
    Create flattened autocomplete documents from a movie.
    Returns a list of documents to insert.
    """
    documents = []
    title = movie_details.get('title')
    movie_id = movie_details.get('id')
    poster_path = movie_details.get('poster_path')
    # 1. Movie title document
    if title:
        documents.append({
            '_id': f"movie_{movie_id}",
            'type': 'movie',
            'name': title,
            'searchName': title.lower(),
            'poster_path': poster_path,
            'movieId': movie_id
        })
    # 2. Cast member documents (limit to top 5)
    cast = movie_details.get('credits', {}).get('cast', [])
    for idx, actor in enumerate(cast[:20]):
        actor_name = actor.get('name')
        if actor_name:
            documents.append({
                '_id': f"person_{movie_id}_{idx}",
                'type': 'person',
                'name': actor_name,
                'searchName': actor_name.lower()
            })
    # 3. Genre documents
    genres = movie_details.get('genres', [])
    for genre in genres:
        genre_name = genre['name'] if isinstance(genre, dict) else genre
        if genre_name:
            documents.append({
                '_id': f"genre_{movie_id}_{genre_name.replace(' ', '_')}",
                'type': 'genre',
                'name': genre_name,
                'searchName': genre_name.lower()
            })
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
    #for region, providers in wp_data.items():
    for region, providers in wp_data.items():
        if region != 'US':
            continue
        watch_providers[region] = {
            'stream': [p['provider_name'] for p in providers.get('flatrate', [])],
            'rent': [p['provider_name'] for p in providers.get('rent', [])],
            'buy': [p['provider_name'] for p in providers.get('buy', [])]
        }
    credits = movie_details.get('credits', {})
    cast = [
        {'name': c['name'], 'character': c.get('character', ''), 'order': c.get('order', 999), 'searchName': c['name'].lower()}
        for c in credits.get('cast', [])[:20]
    ]
    crew = credits.get('crew', [])
    directors = [c['name'] for c in crew if c['job'] == 'Director']
    writers = [c['name'] for c in crew if c['department'] == 'Writing'][:5]
    producers = [c['name'] for c in crew if c['job'] == 'Producer'][:5]
    cast = [c['name'] for c in cast]

    document = {
        "_id": str(movie_details['id']),
        "title": movie_details.get('title'),
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
        "production_companies": [c['name'] for c in movie_details.get('production_companies', [])],
        "production_countries": [c['name'] for c in movie_details.get('production_countries', [])],
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

def process_and_insert_movie(collection, movie_id, progress_bar=None):
    try:
        existing = collection.find_one({"tmdb_id": movie_id})
        if existing:
            if progress_bar is not None:
                progress_bar.set_postfix_str(f"⏭️  Already exists")
            return "exists"
        try:
            movie_details = get_movie_full_details(movie_id)
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 404:
                if progress_bar is not None:
                    progress_bar.set_postfix_str(f"❌ Not Found")
                return "not_found"
            raise e
        embedding_text = create_embedding_text(movie_details)
        embedding = generate_embedding(embedding_text)
        document = prepare_movie_document(movie_details, embedding)
        collection.insert_one(document)
        if progress_bar is not None:
            progress_bar.set_postfix_str(f"✅ {movie_details.get('title', '')[:30]}")
        return True
    except Exception as e:
        if progress_bar is not None:
            progress_bar.set_postfix_str(f"❌ Error: {str(e)[:30]}")
        print(f"\n⚠️  Error processing movie {movie_id}: {str(e)}")
        return False

def update_progress(database, current_page):
    try:
        metadata_col = database.get_collection("crawler_metadata_2026_filtered")
        metadata_col.find_one_and_update(
            {"_id": "tmdb_progress_page"},
            {"$set": {"last_page": current_page}},
            upsert=True
        )
    except Exception:
        pass

def crawl_and_populate_filtered():
    collection = init_astra_collections()
    database = collection.database
    current_page = 1
    # Try to resume from metadata
    try:
        metadata_col = database.get_collection("crawler_metadata_2026_filtered")
        progress = metadata_col.find_one({"_id": "tmdb_progress_page"})
        progress = 0
        if progress and "last_page" in progress:
            current_page = progress["last_page"]
            print(f"Resuming from page {current_page}")
    except Exception:
        pass
    print(f"\n🚀 Starting crawl from TMDB Discover API, page {current_page}")
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
    json_path = "public/autocomplete.json"
    new_since_last_write = 0
    while True:
        try:
            data = discover_movies_filtered(page=current_page)
            results = data.get('results', [])
            total_pages = data.get('total_pages', 1)
            if not results:
                print(f"No results on page {current_page}. Stopping.")
                break
            pbar = tqdm(results, desc=f"Page {current_page}", ncols=100)
            for movie in pbar:
                movie_id = movie.get('id')
                stats['processed'] += 1
                # Get full details once for both DB and autocomplete
                try:
                    movie_details = get_movie_full_details(movie_id)
                except Exception as e:
                    stats['errors'] += 1
                    print(f"⚠️  Error fetching details for movie {movie_id}: {e}")
                    continue
                # Insert into Astra DB
                try:
                    existing = collection.find_one({"tmdb_id": movie_id})
                    if existing:
                        if pbar is not None:
                            pbar.set_postfix_str(f"⏭️  Already exists")
                        stats['already_exists'] += 1
                    else:
                        embedding_text = create_embedding_text(movie_details)
                        embedding = generate_embedding(embedding_text)
                        document = prepare_movie_document(movie_details, embedding)
                        collection.insert_one(document)
                        if pbar is not None:
                            pbar.set_postfix_str(f"✅ {movie_details.get('title', '')[:30]}")
                        stats['inserted'] += 1
                except Exception as e:
                    stats['errors'] += 1
                    print(f"⚠️  Error inserting movie {movie_id}: {e}")
                # Autocomplete doc creation
                try:
                    ac_docs = create_autocomplete_documents(movie_details)
                    for doc in ac_docs:
                        key = (doc.get('type'), doc.get('name'))
                        if key in seen_keys:
                            continue
                        seen_keys.add(key)
                        autocomplete_docs.append(doc)
                        new_since_last_write += 1
                        if new_since_last_write >= 100:
                            with open(json_path, "w") as f:
                                json.dump(autocomplete_docs, f, ensure_ascii=False, separators=(",", ":"), indent=2)
                            print(f"Checkpoint: Exported {len(autocomplete_docs)} entries to {json_path}")
                            new_since_last_write = 0
                except Exception as e:
                    print(f"⚠️  Error generating autocomplete doc for movie {movie_id}: {e}")
            update_progress(database, current_page)
            print(f"Page {current_page} done. Inserted: {stats['inserted']}, Exists: {stats['already_exists']}, Not found: {stats['not_found']}, Errors: {stats['errors']}")
            if current_page >= total_pages:
                print("All pages processed.")
                break
            current_page += 1
            time.sleep(0.5)
        except KeyboardInterrupt:
            print("\n🛑 Stopping crawl...")
            break
        except Exception as e:
            print(f"\n⚠️  Error on page {current_page}: {str(e)}")
            stats['errors'] += 1
            break
    # Final write at the end if there are unwritten entries
    if new_since_last_write > 0:
        with open(json_path, "w") as f:
            json.dump(autocomplete_docs, f, ensure_ascii=False, separators=(",", ":"), indent=2)
        print(f"Final checkpoint: Exported {len(autocomplete_docs)} entries to {json_path}")
    print(f"\n{'='*80}")
    print(f"🎉 CRAWL STOPPED")
    print(f"{'='*80}")
    print(f"Total Processed: {stats['processed']:,}")
    print(f"Successfully Inserted: {stats['inserted']:,}")
    print(f"Already Existed: {stats['already_exists']:,}")
    print(f"Not Found (404): {stats['not_found']:,}")
    print(f"Errors: {stats['errors']:,}")
    print(f"{'='*80}\n")

def main():
    print("="*80)
    print("TMDB to Astra Vector Database Crawler (Discover API, Filtered)")
    print("="*80)
    print(f"\n⚙️  Configuration:")
    print(f"   Min Runtime: 60 minutes")
    print(f"   Vote Average: >= 5")
    print(f"   Vote Count: >= 50")
    print(f"   Embedding Model: {EMBEDDING_MODEL}")
    print(f"   Embedding Dimensions: {EMBEDDING_DIMENSIONS}")
    response = input("\n⚠️  This will crawl TMDB Discover API with filters. Continue? (yes/no): ")
    if response.lower() not in ('yes', 'y', ''):
        print("Cancelled.")
        return
    crawl_and_populate_filtered()

if __name__ == "__main__":
    main()
