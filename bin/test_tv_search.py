import os
import json
import time
from dotenv import load_dotenv
from astrapy import DataAPIClient

load_dotenv(override=True)

def run_search():
    token = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
    endpoint = os.getenv("ASTRA_DB_API_ENDPOINT")
    
    client = DataAPIClient(token)
    db = client.get_database(endpoint)

    # TARGET ONLY TV SHOWS
    collections_info = [
        {"name": "tvshows2026", "type": "tv"}
    ]

    # --- CONFIGURATION FOR TEST ---
    genre = "Mystery"
    providers = [] # e.g. ["Netflix", "Hulu"]
    payment_types = ["stream"]
    limit = 20
    # ------------------------------

    print(f"Testing search for Genre: {genre}, Providers: {', '.join(providers)} (TV Shows Only)")

    # 1. CONSTRUCT SUB-QUERIES
    # Instead of one big complex query or fetching 500 items, we run multiple small specific queries
    # and merge the results. This leverages indexes better and hits the 20-item limit naturally.
    
    base_filters = []
    if genre:
        base_filters.append({"genres": genre})
        # Ensure we have a selective filter for sorting
        base_filters.append({"vote_average": {"$gt": 7}})
    else:
        # Floor for popularity if no genre
        base_filters.append({"popularity": {"$gt": 10}})

    queries_to_run = []

    if providers:
        # Strategy: One query per provider.
        # "5 fast searches of 20"
        for provider in providers:
            variants = [provider]
            if provider == "Disney+": variants.append("Disney Plus")
            if provider == "Paramount+": variants.extend(["Paramount Plus", "Paramount Plus Essential", "Paramount Plus Premium"])
            if provider == "Apple TV+": variants.extend(["Apple TV", "Apple TV Plus"])
            if provider == "Amazon Prime Video": variants.append("Amazon Prime Video with Ads")
            if provider == "Peacock": variants.extend(["Peacock Premium", "Peacock Premium Plus"])
            if provider == "YouTube": variants.extend(["YouTube Premium", "YouTube TV"])
            if provider == "Tubi": variants.append("Tubi TV")
            
            # Combine provider specific check with payment types
            clauses = []
            if 'stream' in payment_types: clauses.append({"watch_providers.US.stream": {"$in": variants}})
            if 'rent' in payment_types: clauses.append({"watch_providers.US.rent": {"$in": variants}})
            if 'buy' in payment_types: clauses.append({"watch_providers.US.buy": {"$in": variants}})
            
            # If no specific payment types, default to stream
            if not clauses: clauses.append({"watch_providers.US.stream": {"$in": variants}})
            
            # Combine into one filter for this provider
            q_filter = {"$and": base_filters + [{"$or": clauses}]}
            queries_to_run.append((f"Provider: {provider}", q_filter))
    else:
        # Fallback: Availability check (Stream/Rent/Buy)
        # Split by payment type so each query is simpler
        for pt in payment_types:
            # Using direct field check
            field = f"watch_providers.US.{pt}"
            q_filter = {"$and": base_filters + [{field: {"$exists": True}}]}
            queries_to_run.append((f"Availability: {pt}", q_filter))

    # Common options for all sub-queries
    search_options = {
        "limit": limit, # Keep limit small per query for speed
        "sort": {"popularity": -1},
        "projection": {"$vector": 0} 
    }

    # 2. EXECUTE & MERGE
    all_results_map = {}
    
    for coll_info in collections_info:
        try:
            print(f"Querying {coll_info['name']}...")
            collection = db.get_collection(coll_info['name'])
            
            for label, q_filter in queries_to_run:
                print(f"  Running sub-query [{label}]...")
                # print("  Filter:", json.dumps(q_filter)) # Debug
                
                start_time = time.time()
                cursor = collection.find(
                    filter=q_filter, 
                    sort=search_options["sort"], 
                    limit=search_options["limit"],
                    projection=search_options["projection"]
                )
                results = list(cursor)
                end_time = time.time()
                
                print(f"  -> Found {len(results)} items in {end_time - start_time:.4f}s")

                for r in results:
                    rid = r.get('_id')
                    if rid not in all_results_map:
                        r['content_type'] = coll_info['type']
                        all_results_map[rid] = r

        except Exception as e:
            print(f"Error querying {coll_info['name']}: {e}")

    # 3. SORT & OUTPUT
    all_results = list(all_results_map.values())
    all_results.sort(key=lambda x: x.get('popularity', 0), reverse=True)
    all_results = all_results[:limit] # Trim final list

    print(f"\nTotal unique results merged: {len(all_results)}")
    print("Top 5 Results:")
    for i, r in enumerate(all_results[:5]):
        title = r.get('title') or r.get('name')
        print(f"{i+1}. [{r.get('vote_average')}] {title} (Pop: {r.get('popularity')})")

if __name__ == "__main__":
    run_search()
