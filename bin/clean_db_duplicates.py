import os
import time
from dotenv import load_dotenv
from astrapy import DataAPIClient

# Load environment variables
load_dotenv()

ASTRA_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
ASTRA_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")
# Collections to clean
COLLECTIONS_TO_CHECK = ["movies2026", "tvshows2026"]

if not all([ASTRA_TOKEN, ASTRA_ENDPOINT]):
    print("Error: Missing Astra DB environment variables.")
    exit(1)

client = DataAPIClient(ASTRA_TOKEN)
db = client.get_database(ASTRA_ENDPOINT)

def score_document(doc):
    """
    Calculate a 'quality score' for a document to decide which one to keep.
    Values closer to TMDB's rich data structure get higher scores.
    """
    score = 0
    
    # 1. Cast / Credits (Essential)
    if 'cast' in doc and doc['cast']: score += 20
    if 'cast_details' in doc and doc['cast_details']: score += 20
    
    # 2. Vector Embedding (Essential for search)
    if '$vector' in doc and doc['$vector']: score += 50
    
    # 3. Deep data
    if 'watch_providers' in doc and doc['watch_providers']: score += 10
    if 'keywords' in doc and doc['keywords']: score += 10
    if 'overview' in doc and len(doc.get('overview', '')) > 20: score += 5
    
    # 4. ID Format Preference
    # Prefer simple numeric IDs (e.g. "12345") over prefixed ones ("movie_12345")
    # This aligns with the new ingestion script.
    _id = str(doc['_id'])
    if _id.isdigit():
        score += 5
    elif _id.startswith("movie_") or _id.startswith("tv_"):
        score -= 5 # Penalize old format
        
    return score

def clean_collection(coll_name):
    print(f"\n--- Cleaning {coll_name} ---")
    try:
        collection = db.get_collection(coll_name)
    except Exception as e:
        print(f"Skipping {coll_name}: {e}")
        return

    # 1. Fetch all documents (projection to save bandwidth, but we need fields for scoring)
    # Using find({}) to scan. For massive DBs, pagination would be needed, 
    # but this fits within typical Astra limits for this app scale.
    print("Fetching documents...")
    all_docs = list(collection.find({}, limit=10000)) # Adjust limit if you have >10k movies
    
    print(f"Fetched {len(all_docs)} documents. Analyzing for duplicates...")
    
    # 2. Group by Title
    # Logic: normalize title to lowercase for comparison
    title_map = {}
    
    for doc in all_docs:
        # Get title based on collection type conventions
        title = doc.get('title') or doc.get('name')
        if not title:
            continue
            
        key = title.strip().lower()
        
        if key not in title_map:
            title_map[key] = []
        title_map[key].append(doc)
        
    # 3. Identify and Process Duplicates
    duplicates_found = 0
    deleted_count = 0
    
    for title_key, docs in title_map.items():
        if len(docs) > 1:
            duplicates_found += 1
            original_title = docs[0].get('title') or docs[0].get('name')
            print(f"\nDuplicate found: '{original_title}' ({len(docs)} copies)")
            
            # Score matches
            scored_docs = []
            for d in docs:
                s = score_document(d)
                scored_docs.append((s, d))
                
            # Sort descending by score
            scored_docs.sort(key=lambda x: x[0], reverse=True)
            
            winner = scored_docs[0][1]
            winner_score = scored_docs[0][0]
            
            print(f"  KEEPING: ID={winner['_id']} (Score: {winner_score})")
            
            # Delete losers
            for score, loser in scored_docs[1:]:
                print(f"  DELETING: ID={loser['_id']} (Score: {score})")
                try:
                    collection.delete_one({"_id": loser['_id']})
                    deleted_count += 1
                except Exception as e:
                    print(f"   Error deleting {loser['_id']}: {e}")
                    
    print(f"\nSummary for {coll_name}:")
    print(f"  Processed groups: {len(title_map)}")
    print(f"  Duplicate sets found: {duplicates_found}")
    print(f"  Records deleted: {deleted_count}")

def main():
    print("Starting database cleanup script...")
    print("This script will remove duplicate movies/shows, keeping the record with the most data (cast, vector, etc).")
    
    for col in COLLECTIONS_TO_CHECK:
        clean_collection(col)
        
    print("\nCleanup complete.")
    print("Note: If you deleted effective data, run the update script immediately after.")

if __name__ == "__main__":
    main()
