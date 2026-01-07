import os
import json
from dotenv import load_dotenv
from astrapy import DataAPIClient

load_dotenv(override=True)

def run_search():
    token = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
    endpoint = os.getenv("ASTRA_DB_API_ENDPOINT")
    
    client = DataAPIClient(token)
    db = client.get_database(endpoint)

    collections_info = [
        {"name": "movies2026", "type": "movie"},
        {"name": "tvshows2026", "type": "tv"}
    ]

    # --- CONFIGURATION FOR TEST ---
    genre = "Mystery"
    providers = []
    payment_types = ["stream"]
    limit = 20
    # ------------------------------

    print(f"Testing search for Genre: {genre}, Providers: {', '.join(providers)}")

    filter_conditions = []
    if genre:
        filter_conditions.append({"genres": genre})

    if providers:
        provider_clauses = []
        for provider in providers:
            variants = [provider]
            if provider == "Disney+":
                variants.append("Disney Plus")
            if provider == "Paramount+":
                variants.extend(["Paramount Plus", "Paramount Plus Essential", "Paramount Plus Premium"])
            if provider == "Apple TV+":
                variants.extend(["Apple TV", "Apple TV Plus"])
            if provider == "Amazon Prime Video":
                variants.append("Amazon Prime Video with Ads")
            if provider == "Peacock":
                variants.extend(["Peacock Premium", "Peacock Premium Plus"])
            if provider == "YouTube":
                variants.extend(["YouTube Premium", "YouTube TV"])
            if provider == "Tubi":
                variants.append("Tubi TV")
            
            clauses = []
            if 'stream' in payment_types:
                clauses.append({"watch_providers.US.stream": {"$in": variants}})
            if 'rent' in payment_types:
                clauses.append({"watch_providers.US.rent": {"$in": variants}})
            if 'buy' in payment_types:
                clauses.append({"watch_providers.US.buy": {"$in": variants}})
            
            if not clauses:
                clauses.append({"watch_providers.US.stream": {"$in": variants}})
                
            provider_clauses.append({"$or": clauses})
        
        filter_conditions.append({"$or": provider_clauses})
    else:
        # Fallback: check for existence if no specific provider selected
        payment_clauses = []
        # Optimized: remove .0 for better performance/timeout avoidance
        if 'stream' in payment_types:
            payment_clauses.append({"watch_providers.US.stream": {"$exists": True}})
        if 'rent' in payment_types:
            payment_clauses.append({"watch_providers.US.rent": {"$exists": True}})
        if 'buy' in payment_types:
            payment_clauses.append({"watch_providers.US.buy": {"$exists": True}})
        
        if payment_clauses:
            filter_conditions.append({"$or": payment_clauses})

    # Logic matches astra.js: If searching by genre, ensure quality > 7
    if genre:
        filter_conditions.append({"vote_average": {"$gt": 7}})

    final_filter = {"$and": filter_conditions} if filter_conditions else {}
    
    search_options = {
        "limit": limit,
        "sort": {"popularity": -1}
    }

    print("Filter:", json.dumps(final_filter, indent=2))
    print("Options:", json.dumps(search_options, indent=2))

    all_results = []

    for coll_info in collections_info:
        try:
            print(f"Querying {coll_info['name']}...")
            collection = db.get_collection(coll_info['name'])
            
            # Using find() with explicit sort/limit options
            cursor = collection.find(
                filter=final_filter, 
                sort=search_options["sort"], 
                limit=search_options["limit"]
            )
            results = list(cursor)

            print(f"Found {len(results)} results in {coll_info['name']}")

            for r in results:
                r['content_type'] = coll_info['type']
                all_results.append(r)
        except Exception as e:
            print(f"Error querying {coll_info['name']}: {e}")

    # Sort combined results by popularity
    all_results.sort(key=lambda x: x.get('popularity', 0), reverse=True)

    print(f"\nTotal results: {len(all_results)}")
    print("Top 5 Results:")       
    for i, r in enumerate(all_results[:5]):
        title = r.get('title') or r.get('name')
        print(f"{i+1}. [{r.get('vote_average')}] {title} (Pop: {r.get('popularity')})")

if __name__ == "__main__":
    run_search()
