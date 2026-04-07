import os
import time
from astrapy import DataAPIClient

# Simple in-memory cache
# Structure: { "query_key": { "data": [...], "timestamp": 1234567890 } }
_SEARCH_CACHE = {}
CACHE_TTL_SECONDS = 3600  # 1 hour

def _get_cache_key(prefix, query, limit):
    return f"{prefix}:{query}:{limit}"

def _get_from_cache(key):
    if key in _SEARCH_CACHE:
        entry = _SEARCH_CACHE[key]
        if time.time() - entry['timestamp'] < CACHE_TTL_SECONDS:
            return entry['data']
        else:
            del _SEARCH_CACHE[key]  # Expired
    return None

def _save_to_cache(key, data):
    _SEARCH_CACHE[key] = {
        "data": data,
        "timestamp": time.time()
    }

# Initialize Astra DB client
client = DataAPIClient(os.getenv("ASTRA_DB_APPLICATION_TOKEN"))
database = client.get_database(os.getenv("ASTRA_DB_API_ENDPOINT"))

def search_movies(query_vector, limit=10):
    cache_key = _get_cache_key("movies", str(query_vector), limit)
    cached = _get_from_cache(cache_key)
    if cached:
        return cached

    collection = database.get_collection("movies")
    results = list(collection.find({"$vector": {"$near": {"$list": query_vector}}}).limit(limit))

    _save_to_cache(cache_key, results)
    return results

def search_tv(query_vector, limit=10):
    cache_key = _get_cache_key("tv", str(query_vector), limit)
    cached = _get_from_cache(cache_key)
    if cached:
        return cached

    collection = database.get_collection("tvshows2026")
    results = list(collection.find({"$vector": {"$near": {"$list": query_vector}}}).limit(limit))

    _save_to_cache(cache_key, results)
    return results

def search_all(query_vector, limit=10):
    cache_key = _get_cache_key("all", str(query_vector), limit)
    cached = _get_from_cache(cache_key)
    if cached:
        return cached

    # Assuming a union of movie and TV show searches
    movie_results = search_movies(query_vector, limit)
    tv_results = search_tv(query_vector, limit)
    results = movie_results + tv_results

    _save_to_cache(cache_key, results)
    return results