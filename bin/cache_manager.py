import os
import json
import hashlib
import time

# Cache configuration
CACHE_DIR = os.path.join(os.path.dirname(__file__), '../cache')
DEFAULT_EXPIRY = 3600 * 24  # 24 hours

# Ensure cache directory exists
if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)

def _generate_key(prefix, params):
    """Generates a unique filename based on the prefix and query parameters."""
    # Sort keys to ensure stable hashing for identical dictionaries
    param_str = json.dumps(params, sort_keys=True)
    hash_obj = hashlib.md5(param_str.encode('utf-8'))
    return f"{prefix}_{hash_obj.hexdigest()}.json"

def get_from_cache(prefix, params):
    """Retrieve data from cache if it exists and hasn't expired."""
    filename = _generate_key(prefix, params)
    filepath = os.path.join(CACHE_DIR, filename)

    if os.path.exists(filepath):
        # Check expiry
        if time.time() - os.path.getmtime(filepath) <= DEFAULT_EXPIRY:
            try:
                with open(filepath, 'r') as f:
                    return json.load(f)
            except Exception as e:
                print(f"Error reading cache {filename}: {e}")
    return None

def save_to_cache(prefix, params, data):
    """Save data to cache."""
    filename = _generate_key(prefix, params)
    filepath = os.path.join(CACHE_DIR, filename)
    try:
        with open(filepath, 'w') as f:
            json.dump(data, f)
    except Exception as e:
        print(f"Error writing cache {filename}: {e}")

# --- Application Specific Wrappers ---

def get_cached_movie_search(query, clean_response_func):
    """
    Check cache for 'movies' search. 
    If miss, calling code should execute search and save using save_cached_movie_search.
    """
    return get_from_cache("search_movies", query)

def save_cached_movie_search(query, results):
    save_to_cache("search_movies", query, results)

def get_cached_tv_search(query):
    return get_from_cache("search_tv", query)

def save_cached_tv_search(query, results):
    save_to_cache("search_tv", query, results)

def get_cached_combined_search(query):
    return get_from_cache("search_all", query)

def save_cached_combined_search(query, results):
    save_to_cache("search_all", query, results)
