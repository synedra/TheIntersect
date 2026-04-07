import os
import time
import json
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

def _get_cache_key(query_type, vector, limit, filters=None, sort=None, sort_order=None):
    # Include filters and sort in cache key for more accurate caching
    filter_str = str(sorted(filters.items())) if filters else ""
    sort_str = f"{sort}_{sort_order}" if sort else ""
    return f"{query_type}_{hash(str(vector))}_{limit}_{hash(filter_str)}_{hash(sort_str)}"

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

def search_movies(vector=None, limit=20, genre=None, person=None, sort=None, sort_order=None):
    """
    Search movies with optional type filtering.
    
    Args:
        vector: Embedding vector for similarity search (optional)
        limit: Maximum number of results
        genre: Optional genre name to filter by
        person: Optional person name (cast member) to filter by
        sort: Sort field
        sort_order: Sort order ('asc' or 'desc')
    """
    filters = {}
    if genre:
        filters['genres'] = genre
    if person:
        filters['cast'] = person
    
    cache_key = _get_cache_key("movies", vector, limit, filters, sort, sort_order)
    cached = _get_cached_result(cache_key)
    if cached:
        return cached

    collection = get_collection("movies2026")
    
    # Build query with filters
    query = {}
    if filters:
        query = {k: v for k, v in filters.items()}
    
    # Build sort
    sort_dict = None
    if vector:
        sort_dict = {"$vector": vector}
    elif sort and sort_order:
        sort_dict = {sort: -1 if sort_order == 'desc' else 1}
    
    results = list(collection.find(
        query,
        sort=sort_dict,
        limit=limit,
        projection={"$vector": 0}
    ))
    
    # Filter for release_date and deduplicate by id
    seen_ids = set()
    filtered_results = []
    for r in results:
        if r.get('release_date') and r.get('id') and r['id'] not in seen_ids:
            filtered_results.append(r)
            seen_ids.add(r['id'])
    
    _save_to_cache(cache_key, filtered_results)
    return filtered_results

def search_tv(vector=None, limit=20, genre=None, person=None, sort=None, sort_order=None):
    """
    Search TV shows with optional type filtering.
    
    Args:
        vector: Embedding vector for similarity search (optional)
        limit: Maximum number of results
        genre: Optional genre name to filter by
        person: Optional person name (cast member) to filter by
        sort: Sort field
        sort_order: Sort order ('asc' or 'desc')
    """
    filters = {}
    if genre:
        filters['genres'] = genre
    if person:
        filters['cast'] = person
    
    cache_key = _get_cache_key("tv", vector, limit, filters, sort, sort_order)
    cached = _get_cached_result(cache_key)
    if cached:
        return cached

    collection = get_collection("tvshows2026")
    
    # Build query with filters
    query = {}
    if filters:
        query = {k: v for k, v in filters.items()}
    
    # Build sort
    sort_dict = None
    if vector:
        sort_dict = {"$vector": vector}
    elif sort and sort_order:
        sort_dict = {sort: -1 if sort_order == 'desc' else 1}
    
    results = list(collection.find(
        query,
        sort=sort_dict,
        limit=limit,
        projection={"$vector": 0}
    ))
    
    # Filter for first_air_date and deduplicate by id
    seen_ids = set()
    filtered_results = []
    for r in results:
        if r.get('first_air_date') and r.get('id') and r['id'] not in seen_ids:
            filtered_results.append(r)
            seen_ids.add(r['id'])
    
    _save_to_cache(cache_key, filtered_results)
    return filtered_results

def search_all(vector=None, limit=20, genre=None, person=None, sort=None, sort_order=None):
    """
    Search both movies and TV shows with optional type filtering.
    
    Args:
        vector: Embedding vector for similarity search (optional)
        limit: Maximum number of results (split between movies and TV)
        genre: Optional genre name to filter by
        person: Optional person name (cast member) to filter by
        sort: Sort field
        sort_order: Sort order ('asc' or 'desc')
    """
    filters = {}
    if genre:
        filters['genres'] = genre
    if person:
        filters['cast'] = person
    
    cache_key = _get_cache_key("all", vector, limit, filters, sort, sort_order)
    cached = _get_cached_result(cache_key)
    if cached:
        return cached

    # Perform searches with filters
    movies = search_movies(vector, limit, genre=genre, person=person, sort=sort, sort_order=sort_order)
    tv = search_tv(vector, limit, genre=genre, person=person, sort=sort, sort_order=sort_order)
    
    # Combine results and deduplicate by id across both
    combined = movies + tv
    seen_ids = set()
    deduped_combined = []
    for r in combined:
        if r.get('id') and r['id'] not in seen_ids:
            deduped_combined.append(r)
            seen_ids.add(r['id'])
    
    _save_to_cache(cache_key, deduped_combined)
    return deduped_combined

# Add search_boardgames function with similar filtering
def search_boardgames(vector=None, limit=20, genre=None, person=None, sort=None, sort_order=None):
    """
    Search board games with optional type filtering, supporting paging if limit > 100.
    """
    filters = {}
    if genre:
        filters['categories'] = genre  # Assuming categories for board games
    if person:
        filters['designers'] = person

    cache_key = _get_cache_key("boardgames", vector, limit, filters, sort, sort_order)
    cached = _get_cached_result(cache_key)
    if cached:
        return cached

    collection = get_collection("bgg_board_games")
    print("Searching board games in collection: bgg_board_games")
    print("Filters applied:", filters)

    projection = {
        "_id": 1,
        "id": 1,
        "name0": 1,
        "name": 1,
        "year": 1,
        "yearpublished": 1,
        "usersrated": 1,
        "average": 1,
        "rank": 1,
        "thumbnail": 1,
        "image": 1,
        "bggid": 1,
        "$vector": 0
    }

    query = {}
    if filters:
        query = {k: v for k, v in filters.items()}

    if not sort:
        sort = "usersrated"
        sort_order = "desc"

    sort_dict = None
    if vector:
        sort_dict = {"$vector": vector}
    elif sort and sort_order:
        sort_dict = {sort: -1 if sort_order == 'desc' else 1}

    # Paging logic
    results = []
    fetched = 0
    page_size = 100
    last_id = None

    while fetched < limit:
        find_query = dict(query)
        if last_id:
            find_query["_id"] = {"$gt": last_id}
        batch_limit = min(page_size, limit - fetched)
        batch = list(collection.find(
            find_query,
            sort=sort_dict,
            limit=batch_limit,
            projection=projection
        ))
        if not batch:
            break
        for r in batch:
            item_id = r.get('bggid') or r.get('_id') or r.get('id')
            year = r.get('year') or r.get('yearpublished')
            if year and item_id:
                results.append(r)
        fetched = len(results)
        last_id = batch[-1]["_id"]

    # Deduplicate by id
    seen_ids = set()
    filtered_results = []
    for r in results:
        item_id = r.get('bggid') or r.get('_id') or r.get('id')
        if item_id and item_id not in seen_ids:
            filtered_results.append(r)
            seen_ids.add(item_id)
        if len(filtered_results) >= limit:
            break

    _save_to_cache(cache_key, filtered_results)
    return filtered_results

def get_details(id, content_mode):
    """Get details for a specific item."""
    if content_mode == 'boardgames':
        collection = get_collection("bgg_board_games")
    elif content_mode == 'tvshows':
        collection = get_collection("tvshows2026")
    else:
        collection = get_collection("movies2026")
    
    result = collection.find_one({'$or': [{'id': id}, {'_id': id}]}, projection={"$vector": 0})
    return result if result else {}

def get_similar(id, content_mode, limit=10):
    """Get similar items."""
    if content_mode == 'boardgames':
        collection = get_collection("bgg_board_games")
    elif content_mode == 'tvshows':
        collection = get_collection("tvshows2026")
    else:
        collection = get_collection("movies2026")
    
    item = collection.find_one({'$or': [{'id': id}, {'_id': id}]})
    if not item:
        return []
    
    vector = item.get('$vector')
    if not vector:
        return []
    
    if content_mode == 'boardgames':
        results = search_boardgames(vector, limit)
    elif content_mode == 'tvshows':
        results = search_tv(vector, limit)
    else:
        results = search_movies(vector, limit)
    
    # Remove the item itself
    results = [r for r in results if r.get('id') != id and r.get('_id') != id]
    return results

def handler(event, context):
    """Netlify function handler."""
    params = event.get('queryStringParameters', {})
    action = params.get('action')
    
    if not action:
        return {
            'statusCode': 400,
            'body': json.dumps({'error': 'Missing action'})
        }
    
    try:
        if action == 'search':
            content_types = params.get('content_types', 'movies')
            limit = int(params.get('limit', 20))
            genre = params.get('genre')
            person = params.get('person')
            sort = params.get('sort')
            sort_order = params.get('sort_order')
            
            if content_types == 'movies':
                results = search_movies(None, limit, genre, person, sort, sort_order)
            elif content_types == 'tvshows':
                results = search_tv(None, limit, genre, person, sort, sort_order)
            elif content_types == 'boardgames':
                results = search_boardgames(None, limit, genre, person, sort, sort_order)
            else:
                results = search_all(None, limit, genre, person, sort, sort_order)
        
        elif action == 'discover':
            content_types = params.get('content_types', 'movies')
            limit = int(params.get('limit', 20))
            sort = params.get('sort')
            sort_order = params.get('sort_order')
            
            if content_types == 'movies':
                results = search_movies(None, limit, None, None, sort, sort_order)
            elif content_types == 'tvshows':
                results = search_tv(None, limit, None, None, sort, sort_order)
            elif content_types == 'boardgames':
                results = search_boardgames(None, limit, None, None, sort, sort_order)
            else:
                results = search_all(None, limit, None, None, sort, sort_order)
        
        elif action == 'details':
            id = params.get('id')
            content_mode = params.get('content_mode', 'movies')
            results = get_details(id, content_mode)
        
        elif action == 'similar':
            id = params.get('id')
            content_mode = params.get('content_mode', 'movies')
            limit = int(params.get('limit', 10))
            results = get_similar(id, content_mode, limit)
        
        elif action == 'similar_boardgames':
            id = params.get('id')
            content_mode = 'boardgames'
            limit = int(params.get('limit', 10))
            results = get_similar(id, content_mode, limit)
        
        else:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': f'Unknown action {action}'})
            }
        
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps(results)
        }
    
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
