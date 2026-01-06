#!/usr/bin/env python3
"""
Export unique autocomplete entries from Astra DB to a static JSON file.
This file can be loaded once on page start for instant in-memory filtering.
"""

import os
import json
import gzip
from dotenv import load_dotenv
from astrapy import DataAPIClient

load_dotenv()

ASTRA_DB_APPLICATION_TOKEN = os.getenv("ASTRA_DB_APPLICATION_TOKEN")
ASTRA_DB_API_ENDPOINT = os.getenv("ASTRA_DB_API_ENDPOINT")

def main():
    print("Connecting to Astra DB...")
    client = DataAPIClient(ASTRA_DB_APPLICATION_TOKEN)
    db = client.get_database(ASTRA_DB_API_ENDPOINT)
    
    # Read from autocomplete collection
    autocomplete_collection = db.get_collection("autocomplete")
    
    print("Fetching all autocomplete documents...")
    
    # Use a set to deduplicate by (type, name)
    seen = set()
    entries = []
    
    # Fetch all documents
    cursor = autocomplete_collection.find({}, projection={"type": 1, "name": 1, "searchName": 1})
    
    count = 0
    for doc in cursor:
        count += 1
        if count % 10000 == 0:
            print(f"  Processed {count} documents...")
        
        doc_type = doc.get("type")
        name = doc.get("name")
        search_name = doc.get("searchName", name.lower() if name else "")
        
        if not name or not doc_type:
            continue
            
        key = (doc_type, name)
        if key in seen:
            continue
        seen.add(key)
        
        # Compact format: [type, name, searchName]
        # type: 0=movie, 1=person, 2=genre (for smaller file size)
        type_code = {"movie": 0, "person": 1, "genre": 2}.get(doc_type, 0)
        entries.append([type_code, name, search_name])
    
    print(f"Total documents processed: {count}")
    print(f"Unique entries: {len(entries)}")
    
    # Sort by type then name for better compression
    entries.sort(key=lambda x: (x[0], x[2]))
    
    # Write compact JSON
    output = {
        "types": ["movie", "person", "genre"],  # Type index lookup
        "entries": entries  # [[typeCode, name, searchName], ...]
    }
    
    output_path = "public/autocomplete.json.gz"
    os.makedirs("public", exist_ok=True)
    
    with gzip.open(output_path, "wt", encoding="utf-8") as f:
        json.dump(output, f, separators=(",", ":"))  # Compact JSON
    
    # Check file size
    size_bytes = os.path.getsize(output_path)
    size_kb = size_bytes / 1024
    size_mb = size_kb / 1024
    
    print(f"\nOutput: {output_path}")
    print(f"Size: {size_kb:.1f} KB ({size_mb:.2f} MB)")
    print(f"Estimated gzipped: ~{size_kb/4:.1f} KB")
    
    # Also create a human-readable version for debugging
    with open("public/autocomplete_debug.json", "w") as f:
        json.dump(output, f, indent=2)
    
    print(f"\nDebug version: public/autocomplete_debug.json")

if __name__ == "__main__":
    main()
