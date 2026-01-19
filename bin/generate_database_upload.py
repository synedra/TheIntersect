import requests
import os
import json
import time
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

TMDB_READ_TOKEN = os.getenv("TMDB_READ_TOKEN")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

if not TMDB_READ_TOKEN or not OPENAI_API_KEY:
    print("Error: TMDB_READ_TOKEN and OPENAI_API_KEY are required in .env")
    exit(1)

client = OpenAI(api_key=OPENAI_API_KEY)
headers = {
    "accept": "application/json",
    "Authorization": f"Bearer {TMDB_READ_TOKEN}"
}

def get_embedding(text):
    if not text:
        return None
    try:
        response = client.embeddings.create(input=text, model="text-embedding-3-small")
        return response.data[0].embedding
    except Exception as e:
        print(f"Error generating embedding: {e}")
        return None

def fetch_popular(media_type, limit=100):
    results = []
    page = 1
    while len(results) < limit:
        url = f"https://api.themoviedb.org/3/{media_type}/popular?language=en-US&page={page}"
        response = requests.get(url, headers=headers)
        if response.status_code != 200:
            print(f"Error fetching {media_type}: {response.status_code}")
            break
        
        data = response.json()
        items = data.get('results', [])
        
        for item in items:
            if len(results) >= limit:
                break
            
            # Construct text for embedding
            title = item.get('title') if media_type == 'movie' else item.get('name')
            overview = item.get('overview', '')
            text_to_embed = f"{title}: {overview}"
            
            # Add Vector
            vector = get_embedding(text_to_embed)
            
            if vector:
                item['$vector'] = vector
                item['type'] = media_type
                # Ensure unique ID format if not present
                if '_id' not in item:
                    item['_id'] = f"{media_type}_{item['id']}"
                
                results.append(item)
                print(f"Processed {len(results)}/{limit} {media_type}: {title}")
                
        page += 1
        time.sleep(0.2) # clear rate limits
        
    return results

def main():
    print("Fetching Top Movies...")
    movies = fetch_popular('movie', limit=1000) 
    
    print("Fetching Top TV Shows...")
    tv_shows = fetch_popular('tv', limit=1000) 
    
    # Structure data with specific keys for separate collections
    data_payload = {
        "movies2026": movies,
        "tvshows2026": tv_shows
    }
    
    output_file = os.path.join(os.path.dirname(__file__), '../database_upload.json')
    with open(output_file, 'w') as f:
        json.dump(data_payload, f)
        
    print(f"Successfully saved {len(movies)} movies and {len(tv_shows)} tv shows to {output_file}")

    # Process Autocomplete for this specific dataset (separate file)
    autocomplete_file = os.path.join(os.path.dirname(__file__), '../autocomplete_upload.json')
    
    # Extract {name, id, type} from new data
    autocomplete_data = []
    seen = set()

    for m in movies:
        if 'title' in m:
            clean_id = str(m.get('id', ''))
            key = ('movie', clean_id)
            if key not in seen:
                seen.add(key)
                autocomplete_data.append({
                    "name": m['title'],
                    "id": clean_id,
                    "type": "movie"
                })
            
    for t in tv_shows:
        if 'name' in t:
            clean_id = str(t.get('id', ''))
            key = ('tv', clean_id)
            if key not in seen:
                seen.add(key)
                autocomplete_data.append({
                    "name": t['name'],
                    "id": clean_id,
                    "type": "tv"
                })

    with open(autocomplete_file, 'w') as f:
        json.dump(autocomplete_data, f, indent=2)

    print(f"Created {autocomplete_file} with {len(autocomplete_data)} entries matching the upload dataset.")

if __name__ == "__main__":
    main()
