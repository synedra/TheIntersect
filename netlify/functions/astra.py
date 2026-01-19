import os
import time
from astrapy import DataAPIClient
from dotenv import load_dotenv

load_dotenv()

ASTRA_DB_API_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
ASTRA_DB_APPLICATION_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")

# Initialize client
client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
database = client.get_database(ASTRA_DB_API_ENDPOINT)

# Cache configuration
_SEARCH_CACHE = {}
CACHE_TTL = 3600  # 1 hour

def _get_cache_key(query_type, vector, limit, filters=None):
    # Include filters in cache key for more accurate caching
    filter_str = str(sorted(filters.items())) if filters else ""
    return f"{query_type}_{hash(str(vector))}_{limit}_{hash(filter_str)}"

def _get_cached_result(key):
    if key in _SEARCH_CACHE:
        entry = _SEARCH_CACHE[key]
        # Check if cache entry is still valid
        if time.time() - entry['timestamp'] < CACHE_TTL:
            return entry['data']
        else:
            # Expired
            del _SEARCH_CACHE[key]
    return None

def _save_to_cache(key, data):
    _SEARCH_CACHE[key] = {
        "timestamp": time.time(),
        "data": data
    }

def get_collection(name):
    return database.get_collection(name)

def search_movies(vector, limit=20, genre=None, person=None):
    """
    Search movies with optional type filtering.
    
    Args:
        vector: Embedding vector for similarity search
        limit: Maximum number of results
        genre: Optional genre name to filter by
        person: Optional person name (cast member) to filter by
    """
    filters = {}
    if genre:
        filters['genres'] = genre
    if person:
        filters['cast'] = person
    
    cache_key = _get_cache_key("movies", vector, limit, filters)
    cached = _get_cached_result(cache_key)
    if cached:
        return cached

    collection = get_collection("movies2026")
    
    # Build query with filters
    query = {}
    if filters:
        query = {k: v for k, v in filters.items()}
    
    results = list(collection.find(
        query,
        sort={"$vector": vector},
        limit=limit,
        projection={"$vector": 0}
    ))
    
    _save_to_cache(cache_key, results)
    return results

def search_tv(vector, limit=20, genre=None, person=None):
    """
    Search TV shows with optional type filtering.
    
    Args:
        vector: Embedding vector for similarity search
        limit: Maximum number of results
        genre: Optional genre name to filter by
        person: Optional person name (cast member) to filter by
    """
    filters = {}
    if genre:
        filters['genres'] = genre
    if person:
        filters['cast'] = person
    
    cache_key = _get_cache_key("tv", vector, limit, filters)
    cached = _get_cached_result(cache_key)
    if cached:
        return cached

    collection = get_collection("tvshows2026")
    
    # Build query with filters
    query = {}
    if filters:
        query = {k: v for k, v in filters.items()}
    
    results = list(collection.find(
        query,
        sort={"$vector": vector},
        limit=limit,
        projection={"$vector": 0}
    ))
    
    _save_to_cache(cache_key, results)
    return results

def search_all(vector, limit=20, genre=None, person=None):
    """
    Search both movies and TV shows with optional type filtering.
    
    Args:
        vector: Embedding vector for similarity search
        limit: Maximum number of results (split between movies and TV)
        genre: Optional genre name to filter by
        person: Optional person name (cast member) to filter by
    """
    filters = {}
    if genre:
        filters['genres'] = genre
    if person:
        filters['cast'] = person
    
    cache_key = _get_cache_key("all", vector, limit, filters)
    cached = _get_cached_result(cache_key)
    if cached:
        return cached

    # Perform searches with filters
    movies = search_movies(vector, limit, genre=genre, person=person)
    tv = search_tv(vector, limit, genre=genre, person=person)
    
    # Combine results
    combined = movies + tv
    
    _save_to_cache(cache_key, combined)
    return combined
