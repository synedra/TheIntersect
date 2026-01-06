import requests
import os
import json
import argparse
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

TMDB_API_KEY = os.getenv("TMDB_API_KEY")
TMDB_BASE_URL = "https://api.themoviedb.org/3"

if not TMDB_API_KEY:
    print("Error: TMDB_API_KEY not found in environment variables. Please check your .env file.")
    exit(1)

def search_movie(query):
    url = f"{TMDB_BASE_URL}/search/movie"
    params = {
        "api_key": TMDB_API_KEY,
        "query": query,
        "include_adult": "false",
        "language": "en-US",
        "page": 1
    }
    
    try:
        print(f"Searching for: '{query}'...")
        response = requests.get(url, params=params)
        response.raise_for_status()
        data = response.json()
        
        results = data.get("results", [])
        total_results = data.get("total_results", 0)
        
        print(f"Found {total_results} results.\n")
        
        for movie in results:
            print(f"ID: {movie.get('id')}")
            print(f"Title: {movie.get('title')}")
            print(f"Original Title: {movie.get('original_title')}")
            print(f"Release Date: {movie.get('release_date')}")
            print(f"Popularity: {movie.get('popularity')}")
            print(f"Average Rating: {movie.get('vote_average')}")
            print(f"Overview: {movie.get('overview')}")
            print("-" * 40)
            
    except requests.exceptions.RequestException as e:
        print(f"Error searching for movie: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Search for movies on TMDB")
    parser.add_argument("query", nargs="?", default="The Little Princess", help="Movie title to search for")
    args = parser.parse_args()
    
    search_movie(args.query)
