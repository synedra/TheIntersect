import os
from astrapy.db import AstraDB

ASTRA_DB_API_ENDPOINT = os.environ.get("ASTRA_DB_API_ENDPOINT")
ASTRA_DB_APPLICATION_TOKEN = os.environ.get("ASTRA_DB_APPLICATION_TOKEN")

# Source and target collections
SOURCE_COLLECTION = "tmdb_movies"
TARGET_COLLECTION = "movies"

astra_db = AstraDB(
    api_endpoint=ASTRA_DB_API_ENDPOINT,
    token=ASTRA_DB_APPLICATION_TOKEN
)
source = astra_db.collection(SOURCE_COLLECTION)
target = astra_db.collection(TARGET_COLLECTION)

def migrate_movies():
    print("Migrating documents from tmdb_movies to movies...")
    cursor = source.find({}, limit=1000)
    count = 0
    for doc in cursor:
        # Remove Astra's internal _id if present
        doc.pop("_id", None)
        target.insert_one(doc)
        count += 1
        if count % 100 == 0:
            print(f"{count} documents migrated...")
    print(f"Migration complete. {count} documents moved.")

if __name__ == "__main__":
    migrate_movies()
