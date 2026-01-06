import requests
import os
from dotenv import load_dotenv
import json

load_dotenv()

TMDB_API_KEY = os.getenv("TMDB_API_KEY")
TMDB_BASE_URL = "https://api.themoviedb.org/3"

def search_tmdb(query):
    url = f"{TMDB_BASE_URL}/search/movie"
    params = {
        "api_key": TMDB_API_KEY,
        "query": query,
        "include_adult": "false"
    }
    response = requests.get(url, params=params)
    response.raise_for_status()
    return response.json()

def main():
    query = "Eternal Sunshine of the Spotless Mind"
    print(f"Searching TMDB for '{query}'...")
    data = search_tmdb(query)
    
    results = data.get('results', [])
    print(f"Found {len(results)} results:")
    
    for movie in results:
        print(json.dumps(movie, indent=2))

if __name__ == "__main__":
    main()
