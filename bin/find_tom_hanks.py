import os
from dotenv import load_dotenv
from astrapy import DataAPIClient

# Load environment variables
load_dotenv()

ASTRA_DB_API_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
ASTRA_DB_APPLICATION_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
COLLECTION_NAME = "movies"

# Initialize the client
client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
database = client.get_database(ASTRA_DB_API_ENDPOINT)
collection = database.get_collection(COLLECTION_NAME)

def find_tom_hanks():
    # Try both 'cast.searchName' and 'cast.name'
    queries = [
        {"cast.searchName": {"$eq": "tom hanks"}},
        {"cast.name": {"$eq": "Tom Hanks"}}
    ]
    for query in queries:
        print(f"Searching with query: {query}")
        results = list(collection.find(query, limit=10))
        print(f"Found {len(results)} results.")
        for movie in results:
            print(f"Movie: {movie.get('title', 'Unknown Title')}")
            for person in movie.get("cast", []):
                if person.get("name", "").lower() == "tom hanks" or person.get("searchName", "") == "tom hanks":
                    print(f"  Cast: {person}")

if __name__ == "__main__":
    find_tom_hanks()
