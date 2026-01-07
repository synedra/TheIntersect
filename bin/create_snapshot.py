import os
import json
from astrapy import DataAPIClient
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configuration
ASTRA_DB_APPLICATION_TOKEN = os.environ.get("ASTRA_DB_APPLICATION_TOKEN")
ASTRA_DB_API_ENDPOINT = os.environ.get("ASTRA_DB_API_ENDPOINT")
COLLECTION_NAME = "movies_and_tv" # Ensure this matches your populated collection
OUTPUT_FILE = "database_upload.json"

def main():
    if not ASTRA_DB_APPLICATION_TOKEN or not ASTRA_DB_API_ENDPOINT:
        print("Error: Environment variables ASTRA_DB_APPLICATION_TOKEN and ASTRA_DB_API_ENDPOINT are required.")
        return

    # Initialize client
    client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
    db = client.get_database(ASTRA_DB_API_ENDPOINT)
    
    print(f"Connecting to collection '{COLLECTION_NAME}'...")
    try:
        collection = db.get_collection(COLLECTION_NAME)
    except Exception as e:
        print(f"Error accessing collection: {e}")
        return

    print("Targeting top 10,000 Movies and TV Shows by popularity...")

    # Fetch Movies
    print("Fetching Movies...")
    movies_cursor = collection.find(
        filter={"type": "movie"},
        sort={"popularity": -1},
        limit=10000,
        projection={"*": 1}
    )
    movies = list(movies_cursor)
    print(f"Retrieved {len(movies)} movies.")

    # Fetch TV Shows
    print("Fetching TV Shows...")
    tv_cursor = collection.find(
        filter={"type": "tv"},
        sort={"popularity": -1},
        limit=10000,
        projection={"*": 1}
    )
    tv = list(tv_cursor)
    print(f"Retrieved {len(tv)} TV shows.")

    # Combine Data
    all_data = movies + tv

    # Write to JSON
    output_path = os.path.join(os.path.dirname(__file__), '..', OUTPUT_FILE)
    print(f"Writing {len(all_data)} records to {output_path}...")
    
    with open(output_path, "w") as f:
        json.dump(all_data, f, indent=2)
    
    print("Snapshot created successfully.")

if __name__ == "__main__":
    main()
