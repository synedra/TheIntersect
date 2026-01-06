import os
from dotenv import load_dotenv
from astrapy import DataAPIClient

# Load environment variables
load_dotenv()

ASTRA_DB_API_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
ASTRA_DB_APPLICATION_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")

if not ASTRA_DB_API_ENDPOINT or not ASTRA_DB_APPLICATION_TOKEN:
    raise ValueError("Astra DB environment variables not set")

# Initialize the client
client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
database = client.get_database(ASTRA_DB_API_ENDPOINT)

# Get collection
collection = database.get_collection("movies2026")

# Find the document with the highest tmdb_id
result = collection.find_one({}, sort={"tmdb_id": -1}, projection={"tmdb_id": 1})

if result:
    print(f"Highest tmdb_id: {result['tmdb_id']}")
else:
    print("No documents found")