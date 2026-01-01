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
COLLECTION_NAME = "moviesnew"
EMBEDDING_MODEL = "text-embedding-3-small"  # 1536 dimensions
EMBEDDING_DIMENSIONS = 1536

# Initialize OpenAI client
openai_client = OpenAI(api_key=OPENAI_API_KEY)


def init_astra_collection():
    """Initialize Astra DB collection for movies."""
    print("Initializing Astra DB connection...")
    
    # Initialize the client
    client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
    database = client.get_database(ASTRA_DB_API_ENDPOINT)
    
    # Create or get collection
    try:
        collection = database.create_collection(
            COLLECTION_NAME,
            dimension=EMBEDDING_DIMENSIONS,
            metric="cosine"
        )
        print(f"✅ Created new collection: {COLLECTION_NAME}")
    except Exception as e:
        if "already exists" in str(e).lower():
            collection = database.get_collection(COLLECTION_NAME)
            print(f"✅ Using existing collection: {COLLECTION_NAME}")
        else:
            raise
    
    return collection


def discover_movies(page=1, min_runtime=60):
    """
    Discover movies with runtime over specified minutes.
    TMDB API handles filtering for: runtime >= 60min, non-adult content.
    We only need to check vote_count based on movie age (can't be done in API).
    """
    url = f"{TMDB_BASE_URL}/discover/movie"
    params = {
        "api_key": TMDB_API_KEY,
        "language": "en-US",
        "sort_by": "popularity.desc",
        "include_adult": "false",  # Explicitly exclude adult content
        "include_video": False,
        "page": page,
        "with_runtime.gte": min_runtime,  # Only movies >= 60 minutes
        # Note: vote_count filter removed - we filter conditionally based on release date
    }
    
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()


def get_movie_full_details(movie_id):
    """Fetch comprehensive movie details."""
    url = f"{TMDB_BASE_URL}/movie/{movie_id}"
    params = {
        "api_key": TMDB_API_KEY,
        "language": "en-US",
        "append_to_response": "credits,keywords,videos,images,reviews,recommendations,similar,watch/providers,release_dates,external_ids"
    }
    
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()


def create_embedding_text(movie_details):
    """
    Create a text representation of the movie for embedding.
    Combines the most relevant information for semantic search.
    """
    parts = []
    
    # Title and tagline
    parts.append(f"Title: {movie_details.get('title', '')}")
    if movie_details.get('tagline'):
        parts.append(f"Tagline: {movie_details.get('tagline')}")
    
    # Overview (most important for semantic understanding)
    if movie_details.get('overview'):
        parts.append(f"Overview: {movie_details.get('overview')}")
    
    # Genres
    genres = movie_details.get('genres', [])
    if genres:
        genre_names = ', '.join([g['name'] for g in genres])
        parts.append(f"Genres: {genre_names}")
    
    # Keywords (important for semantic relationships)
    keywords = movie_details.get('keywords', {}).get('keywords', [])
    if keywords:
        keyword_names = ', '.join([k['name'] for k in keywords[:20]])  # Top 20 keywords
        parts.append(f"Keywords: {keyword_names}")
    
    # Director and top cast
    credits = movie_details.get('credits', {})
    crew = credits.get('crew', [])
    directors = [c['name'] for c in crew if c['job'] == 'Director']
    if directors:
        parts.append(f"Director: {', '.join(directors)}")
    
    cast = credits.get('cast', [])
    if cast:
        top_cast = ', '.join([c['name'] for c in cast[:5]])
        parts.append(f"Starring: {top_cast}")
    
    # Production companies
    companies = movie_details.get('production_companies', [])
    if companies:
        company_names = ', '.join([c['name'] for c in companies[:3]])
        parts.append(f"Production: {company_names}")
    
    return '\n'.join(parts)


def generate_embedding(text):
    """Generate embedding using OpenAI API."""
    response = openai_client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text,
        encoding_format="float"
    )
    return response.data[0].embedding


def prepare_movie_document(movie_details, embedding):
    """Prepare movie document for Astra DB with all relevant fields."""
    
    # Extract watch providers
    watch_providers = {}
    wp_data = movie_details.get('watch/providers', {}).get('results', {})
    for region, providers in wp_data.items():
        watch_providers[region] = {
            'stream': [p['provider_name'] for p in providers.get('flatrate', [])],
            'rent': [p['provider_name'] for p in providers.get('rent', [])],
            'buy': [p['provider_name'] for p in providers.get('buy', [])]
        }
    
    # Extract cast and crew
    credits = movie_details.get('credits', {})
    cast = [
        {'name': c['name'], 'character': c.get('character', ''), 'order': c.get('order', 999)}
        for c in credits.get('cast', [])[:20]  # Top 20 cast members
    ]
    
    crew = credits.get('crew', [])
    directors = [c['name'] for c in crew if c['job'] == 'Director']
    writers = [c['name'] for c in crew if c['department'] == 'Writing'][:5]
    producers = [c['name'] for c in crew if c['job'] == 'Producer'][:5]
    
    # Document structure
    document = {
        "_id": str(movie_details['id']),
        
        # Basic Information
        "title": movie_details.get('title'),
        "original_title": movie_details.get('original_title'),
        "tagline": movie_details.get('tagline'),
        "overview": movie_details.get('overview'),
        "runtime": movie_details.get('runtime'),
        "release_date": movie_details.get('release_date'),
        "status": movie_details.get('status'),
        "original_language": movie_details.get('original_language'),
        
        # Ratings and Popularity
        "vote_average": movie_details.get('vote_average'),
        "vote_count": movie_details.get('vote_count'),
        "popularity": movie_details.get('popularity'),
        
        # Financial
        "budget": movie_details.get('budget'),
        "revenue": movie_details.get('revenue'),
        
        # Categories
        "genres": [g['name'] for g in movie_details.get('genres', [])],
        "keywords": [k['name'] for k in movie_details.get('keywords', {}).get('keywords', [])],
        
        # People
        "directors": directors,
        "writers": writers,
        "producers": producers,
        "cast": cast,
        
        # Production
        "production_companies": [c['name'] for c in movie_details.get('production_companies', [])],
        "production_countries": [c['name'] for c in movie_details.get('production_countries', [])],
        
        # Watch Providers
        "watch_providers": watch_providers,
        
        # External IDs
        "imdb_id": movie_details.get('external_ids', {}).get('imdb_id'),
        "tmdb_id": movie_details.get('id'),
        
        # Metadata
        "homepage": movie_details.get('homepage'),
        "poster_path": movie_details.get('poster_path'),
        "backdrop_path": movie_details.get('backdrop_path'),
        
        # Embedding
        "$vector": embedding,
        
        # Timestamp
        "indexed_at": datetime.utcnow().isoformat()
    }
    
    return document


def process_and_insert_movie(collection, movie_id, progress_bar=None):
    """Process a single movie and insert into Astra DB."""
    try:
        # Check if movie already exists in database
        existing = collection.find_one({"tmdb_id": movie_id})
        if existing:
            if progress_bar is not None:
                progress_bar.set_postfix_str(f"⏭️  Already exists")
            return "exists"
        
        # Get full movie details
        try:
            movie_details = get_movie_full_details(movie_id)
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 404:
                if progress_bar is not None:
                    progress_bar.set_postfix_str(f"❌ Not Found")
                return "not_found"
            raise e
            
        # Filter: Adult content
        if movie_details.get('adult'):
            if progress_bar is not None:
                progress_bar.set_postfix_str(f"⏭️  Skipped (Adult)")
            return "skipped_adult"

        # Filter: Runtime < 60 mins
        runtime = movie_details.get('runtime') or 0
        if runtime < 60:
            if progress_bar is not None:
                progress_bar.set_postfix_str(f"⏭️  Skipped (Short: {runtime}m)")
            return "skipped_short"
        
        # Apply vote count filter only to movies older than 6 months
        # (This can't be done in the API query, so we check it here)
        release_date = movie_details.get('release_date')
        if release_date:
            from datetime import datetime, timedelta
            try:
                release_dt = datetime.strptime(release_date, '%Y-%m-%d')
                six_months_ago = datetime.now() - timedelta(days=180)
                
                # If movie is older than 6 months, require minimum vote count
                if release_dt < six_months_ago:
                    vote_count = movie_details.get('vote_count', 0)
                    if vote_count < 50:
                        if progress_bar is not None:
                            progress_bar.set_postfix_str(f"Skipped (old, low votes: {vote_count})")
                        return False
            except ValueError:
                pass  # If date parsing fails, continue processing
        
        # Create embedding text
        embedding_text = create_embedding_text(movie_details)
        
        # Generate embedding
        embedding = generate_embedding(embedding_text)
        
        # Prepare document
        document = prepare_movie_document(movie_details, embedding)
        
        # Insert into Astra DB
        collection.insert_one(document)
        
        if progress_bar is not None:
            progress_bar.set_postfix_str(f"✅ {movie_details.get('title', '')[:30]}")
        
        return True
        
    except Exception as e:
        if progress_bar is not None:
            progress_bar.set_postfix_str(f"❌ Error: {str(e)[:30]}")
        print(f"\n⚠️  Error processing movie {movie_id}: {str(e)}")
        return False


def get_latest_tmdb_id(collection):
    """Get the highest TMDB ID currently in the database."""
    try:
        # Sort by tmdb_id descending and get the first one
        result = collection.find_one({}, sort={"tmdb_id": -1}, projection={"tmdb_id": 1})
        return result["tmdb_id"] if result else 0
    except Exception as e:
        print(f"Error getting latest ID: {e}")
        return 0


def crawl_and_populate(start_id=1):
    """
    Iterate through TMDB IDs and populate Astra DB.
    """
    # Initialize Astra collection
    collection = init_astra_collection()
    
    # Get last processed ID to resume
    last_db_id = get_latest_tmdb_id(collection)
    current_id = max(last_db_id, start_id)
    
    print(f"\n🚀 Starting crawl from TMDB ID: {current_id + 1}")
    if last_db_id > 0:
        print(f"   (Resumed from highest ID in DB: {last_db_id})")
    
    # Statistics
    stats = {
        'processed': 0,
        'inserted': 0,
        'skipped': 0,
        'already_exists': 0,
        'not_found': 0,
        'errors': 0
    }
    
    # Process IDs indefinitely
    pbar = tqdm(initial=current_id, unit="id", desc="Processing", ncols=100)
    
    while True:
        current_id += 1
        try:
            stats['processed'] += 1
            
            # Process and insert
            success = process_and_insert_movie(collection, current_id, pbar)
            
            if success == True:
                stats['inserted'] += 1
                pbar.set_description(f"Processing ID {current_id} (Inserted)")
            elif success == "exists":
                stats['already_exists'] += 1
                pbar.set_description(f"Processing ID {current_id} (Exists)")
            elif success == "not_found":
                stats['not_found'] += 1
                pbar.set_description(f"Processing ID {current_id} (404)")
            else:
                stats['skipped'] += 1
                pbar.set_description(f"Processing ID {current_id} (Skipped)")
            
            pbar.update(1)
            
            # Rate limiting - be nice to APIs
            time.sleep(0.1)
            
            # Periodic status update
            if stats['processed'] % 100 == 0:
                pbar.write(f"Stats: {stats['inserted']} inserted, {stats['skipped']} skipped, {stats['not_found']} 404s")
                
        except KeyboardInterrupt:
            print("\n\n🛑 Stopping crawl...")
            break
        except Exception as e:
            print(f"\n⚠️  Error on ID {current_id}: {str(e)}")
            stats['errors'] += 1
            time.sleep(2)  # Wait before retrying
            continue
    
    pbar.close()
    
    # Final statistics
    print(f"\n{'='*80}")
    print(f"🎉 CRAWL STOPPED")
    print(f"{'='*80}")
    print(f"Total Processed: {stats['processed']:,}")
    print(f"Successfully Inserted: {stats['inserted']:,}")
    print(f"Already Existed: {stats['already_exists']:,}")
    print(f"Not Found (404): {stats['not_found']:,}")
    print(f"Skipped (Filters): {stats['skipped']:,}")
    print(f"Errors: {stats['errors']:,}")
    print(f"{'='*80}\n")


def main():
    print("="*80)
    print("TMDB to Astra Vector Database Crawler (ID Iteration Mode)")
    print("="*80)
    
    # You can adjust these parameters
    START_ID = 0  # Start from ID 1 (0 + 1)
    
    print(f"\n⚙️  Configuration:")
    print(f"   Min Runtime: 60 minutes")
    print(f"   Embedding Model: {EMBEDDING_MODEL}")
    print(f"   Embedding Dimensions: {EMBEDDING_DIMENSIONS}")
    print(f"   Start ID: {START_ID + 1}")
    
    # Confirmation
    response = input("\n⚠️  This will iterate through TMDB IDs indefinitely. Continue? (yes/no): ")
    if response.lower() != 'yes':
        print("Cancelled.")
        return
    
    # Start crawling
    crawl_and_populate(start_id=START_ID)


if __name__ == "__main__":
    main()
