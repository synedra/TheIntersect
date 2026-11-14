import requests
import os
import datetime
import time
from dotenv import load_dotenv
from openai import OpenAI
from astrapy import DataAPIClient

# Load environment variables
load_dotenv()

TMDB_TOKEN = os.getenv("TMDB_READ_TOKEN")
OPENAI_KEY = os.getenv("OPENAI_API_KEY")
ASTRA_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
ASTRA_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")

# Collection mapping
COLLECTIONS = {
    "movie": "movies2026",
    "tv": "tvshows2026"
}
METADATA_COLLECTION = "maintenance_metadata"

if not all([TMDB_TOKEN, OPENAI_KEY, ASTRA_TOKEN, ASTRA_ENDPOINT]):
    print("Error: Missing necessary environment variables.")
    exit(1)

# Initialize clients
openai_client = OpenAI(api_key=OPENAI_KEY)
astra_client = DataAPIClient(ASTRA_TOKEN)
db = astra_client.get_database(ASTRA_ENDPOINT)

# Ensure metadata collection exists
try:
    cols = db.list_collections()
    if not any(c.name == METADATA_COLLECTION for c in cols):
        db.create_collection(METADATA_COLLECTION)
except Exception as e:
    print(f"Note on metadata collection: {e}")

def get_last_processed_date(media_type):
    """Retrieves the last fully processed date from Astra, or defaults to 1 day ago."""
    try:
        collection = db.get_collection(METADATA_COLLECTION)
        doc_id = f"status_{media_type}"
        doc = collection.find_one({"_id": doc_id})
        
        if doc and "last_date" in doc:
            return datetime.datetime.strptime(doc["last_date"], "%Y-%m-%d").date()
    except Exception as e:
        print(f"Error reading metadata for {media_type}: {e}")
    
    # Default to yesterday if no history
    return datetime.date.today() - datetime.timedelta(days=1)

def update_checkpoint(media_type, date_obj):
    """Updates the checkpoint in Astra after a day is successfully processed."""
    try:
        collection = db.get_collection(METADATA_COLLECTION)
        doc_id = f"status_{media_type}"
        date_str = date_obj.strftime("%Y-%m-%d")
        
        collection.find_one_and_replace(
            {"_id": doc_id},
            {
                "_id": doc_id, 
                "last_date": date_str, 
                "updated_at": datetime.datetime.now().isoformat()
            },
            upsert=True
        )
        print(f"   [Checkpoint] Saved {media_type} progress: {date_str}")
    except Exception as e:
        print(f"Error updating checkpoint: {e}")

def get_changed_ids_for_date(media_type, target_date):
    """Fetches IDs that changed on a SPECIFIC date."""
    formatted_date = target_date.strftime("%Y-%m-%d")
    changed_ids = set()
    page = 1
    
    while True:
        url = f"https://api.themoviedb.org/3/{media_type}/changes?start_date={formatted_date}&end_date={formatted_date}&page={page}"
        headers = {
            "Authorization": f"Bearer {TMDB_TOKEN}",
            "accept": "application/json"
        }
        
        try:
            resp = requests.get(url, headers=headers)
            if resp.status_code != 200:
                print(f"   Failed to fetch changes page {page}: {resp.text}")
                break
                
            data = resp.json()
            results = data.get("results", [])
            
            if not results:
                break
                
            for item in results:
                if not item.get("adult"):
                    changed_ids.add(item["id"])
            
            total_pages = data.get("total_pages", 1)
            if page >= total_pages or page >= 100: 
                break
                
            page += 1
            time.sleep(0.1) 
            
        except Exception as e:
            print(f"   Error fetching changes: {e}")
            break
            
    return list(changed_ids)

def get_embedding(text):
    if not text:
        return None
    try:
        response = openai_client.embeddings.create(input=text, model="text-embedding-3-small")
        return response.data[0].embedding
    except Exception as e:
        print(f"   Embedding error: {e}")
        return None

def update_item(media_type, item_id):
    # Fetch FULL details including cast (credits), keywords, and providers
    url = f"https://api.themoviedb.org/3/{media_type}/{item_id}?append_to_response=credits,keywords,watch/providers"
    headers = {
        "Authorization": f"Bearer {TMDB_TOKEN}",
        "accept": "application/json"
    }
    
    try:
        resp = requests.get(url, headers=headers)
        if resp.status_code == 404:
            return # Deleted
        
        if resp.status_code != 200:
            return

        data = resp.json()
        
        if media_type == 'movie':
            title = data.get('title')
            # Assuming main collection uses raw ID, removing prefix to avoid duplicates
            _id = str(data['id']) 
        else: # tv
            title = data.get('name')
            _id = str(data['id'])

        overview = data.get('overview', '')
        
        if not title and not overview:
            return

        # Build a trimmed document to stay under Astra indexed-property limits.
        credits = data.get('credits', {})
        cast_raw = credits.get('cast', []) if isinstance(credits, dict) else []
        crew_raw = credits.get('crew', []) if isinstance(credits, dict) else []

        cast_details = []
        cast_names = []
        for actor in cast_raw[:20]:
            name = actor.get('name')
            if not name:
                continue
            cast_names.append(name)
            cast_details.append({
                'name': name,
                'character': actor.get('character', ''),
                'order': actor.get('order', 999),
                'searchName': name.lower()
            })

        directors = [c.get('name') for c in crew_raw if c.get('job') == 'Director' and c.get('name')][:5]
        writers = [c.get('name') for c in crew_raw if c.get('department') == 'Writing' and c.get('name')][:8]
        producers = [c.get('name') for c in crew_raw if c.get('job') == 'Producer' and c.get('name')][:8]

        kws = data.get('keywords', {})
        keyword_rows = []
        if isinstance(kws, dict):
            if isinstance(kws.get('keywords'), list):
                keyword_rows = kws.get('keywords', [])
            elif isinstance(kws.get('results'), list):
                keyword_rows = kws.get('results', [])
        keyword_names = [k.get('name') for k in keyword_rows if isinstance(k, dict) and k.get('name')][:80]

        wp = data.get('watch/providers', {})
        wp_results = wp.get('results', {}) if isinstance(wp, dict) else {}
        us_providers = wp_results.get('US', {}) if isinstance(wp_results, dict) else {}
        watch_providers = {
            'US': {
                'stream': [p.get('provider_name') for p in us_providers.get('flatrate', []) if p.get('provider_name')],
                'rent': [p.get('provider_name') for p in us_providers.get('rent', []) if p.get('provider_name')],
                'buy': [p.get('provider_name') for p in us_providers.get('buy', []) if p.get('provider_name')],
            }
        }

        base_doc = {
            '_id': _id,
            'type': media_type,
            'tmdb_id': data.get('id'),
            'original_language': data.get('original_language'),
            'overview': overview,
            'poster_path': data.get('poster_path'),
            'backdrop_path': data.get('backdrop_path'),
            'popularity': data.get('popularity'),
            'vote_average': data.get('vote_average'),
            'vote_count': data.get('vote_count'),
            'genres': [g.get('name') for g in data.get('genres', []) if isinstance(g, dict) and g.get('name')],
            'keywords': keyword_names,
            'cast': cast_names,
            'cast_details': cast_details,
            'directors': directors,
            'writers': writers,
            'producers': producers,
            'watch_providers': watch_providers,
            'indexed_at': datetime.datetime.utcnow().isoformat(),
        }

        if media_type == 'movie':
            base_doc.update({
                'title': title,
                'title_lower': title.lower() if title else '',
                'original_title': data.get('original_title'),
                'tagline': data.get('tagline'),
                'runtime': data.get('runtime'),
                'release_date': data.get('release_date'),
                'status': data.get('status'),
                'budget': data.get('budget'),
                'revenue': data.get('revenue'),
                'production_companies': [c.get('name') for c in data.get('production_companies', []) if isinstance(c, dict) and c.get('name')],
                'imdb_id': (data.get('external_ids') or {}).get('imdb_id') if isinstance(data.get('external_ids'), dict) else None,
                'homepage': data.get('homepage'),
            })
        else:
            base_doc.update({
                'name': title,
                'name_lower': title.lower() if title else '',
                'original_name': data.get('original_name'),
                'tagline': data.get('tagline'),
                'first_air_date': data.get('first_air_date'),
                'last_air_date': data.get('last_air_date'),
                'status': data.get('status'),
                'number_of_seasons': data.get('number_of_seasons'),
                'number_of_episodes': data.get('number_of_episodes'),
                'creators': [c.get('name') for c in data.get('created_by', []) if isinstance(c, dict) and c.get('name')],
                'networks': [n.get('name') for n in data.get('networks', []) if isinstance(n, dict) and n.get('name')],
                'production_companies': [c.get('name') for c in data.get('production_companies', []) if isinstance(c, dict) and c.get('name')],
                'imdb_id': (data.get('external_ids') or {}).get('imdb_id') if isinstance(data.get('external_ids'), dict) else None,
                'homepage': data.get('homepage'),
            })

        text_to_embed = f"{title}: {overview}"
        vector = get_embedding(text_to_embed)
        
        if vector:
            base_doc['$vector'] = vector
            
            target_collection_name = COLLECTIONS[media_type]
            collection = db.get_collection(target_collection_name)
            
            collection.find_one_and_replace(
                {"_id": _id},
                base_doc,
                upsert=True
            )
        else:
            print(f"   Skipping {item_id}: No vector generated.")

    except Exception as e:
        print(f"   Error updating {item_id}: {e}")

def main():
    today = datetime.date.today()
    
    for media_type in ["movie", "tv"]:
        print(f"\n=== Checking {media_type.upper()} updates ===")
        last_date = get_last_processed_date(media_type)
        
        current_date = last_date + datetime.timedelta(days=1)
        
        if current_date > today:
            print(f"Up to date. Last processed: {last_date}")
            continue

        print(f"Starting batch update from {current_date} to {today}")

        while current_date <= today:
            # Check for current date before processing
            if current_date > datetime.date.today():
                 break

            date_str = current_date.strftime("%Y-%m-%d")
            print(f"> Processing {date_str}...")
            
            ids = get_changed_ids_for_date(media_type, current_date)
            
            if not ids:
                print(f"   No changes found for {date_str}.")
            else:
                print(f"   Found {len(ids)} changes. Processing...")
                count = 0
                for mid in ids:
                    update_item(media_type, mid)
                    count += 1
                    if count % 50 == 0:
                        print(f"   ... processed {count}/{len(ids)}")
                    time.sleep(0.2) 
            
            update_checkpoint(media_type, current_date)
            current_date += datetime.timedelta(days=1)

    print("\nBatch update complete.")

if __name__ == "__main__":
    main()
