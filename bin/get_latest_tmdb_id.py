import requests
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

TMDB_API_KEY = os.getenv("TMDB_API_KEY")

if not TMDB_API_KEY:
    raise ValueError("TMDB_API_KEY not found")

TMDB_BASE_URL = "https://api.themoviedb.org/3"

def get_tmdb_latest_id():
    url = f"{TMDB_BASE_URL}/movie/latest"
    params = {"api_key": TMDB_API_KEY}
    try:
        response = requests.get(url, params=params)
        response.raise_for_status()
        return response.json().get('id')
    except Exception as e:
        print(f"Error fetching latest ID: {e}")
        return None

latest_id = get_tmdb_latest_id()
if latest_id:
    print(f"Latest TMDB movie ID: {latest_id}")
else:
    print("Could not fetch latest ID")