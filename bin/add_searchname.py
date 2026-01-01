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
collection = database.get_collection("movies2026")

def add_searchname_to_cast():
    print("Adding searchName to cast members in movies collection...")
    documents = collection.find({})
    count = 0
    updated = 0
    for doc in documents:
        modified = False
        if 'cast' in doc and isinstance(doc['cast'], list):
            for person in doc['cast']:
                if isinstance(person, dict) and 'name' in person and 'searchName' not in person:
                    person['searchName'] = person['name'].lower()
                    modified = True
        if modified:
            # Update the document
            collection.find_one_and_replace({"_id": doc["_id"]}, doc)
            updated += 1
        count += 1
        if count % 100 == 0:
            print(f"Processed {count} documents, updated {updated}...")
    print(f"Finished. Processed {count} documents, updated {updated}.")

if __name__ == "__main__":
    add_searchname_to_cast()