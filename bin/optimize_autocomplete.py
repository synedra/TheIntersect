import json
import os
import gzip

INPUT_FILE = 'public/autocomplete.json'
FALLBACK_INPUT = 'public/autocomplete.json.gz'
OUTPUT_FILE = 'public/autocomplete.json.gz'

def optimize():
    input_path = INPUT_FILE if os.path.exists(INPUT_FILE) else FALLBACK_INPUT
    print(f"Reading from {input_path}...")
    
    try:
        if input_path.endswith('.gz'):
            with gzip.open(input_path, 'rt', encoding='utf-8') as f:
                data = json.load(f)
        else:
            with open(input_path, 'r') as f:
                data = json.load(f)
    except FileNotFoundError:
        print(f"Error: Could not find {INPUT_FILE} or {FALLBACK_INPUT}")
        return
    
    entries = data if isinstance(data, list) else data.get('entries', [])
    
    optimized_entries = []
    type_map = {'movie': 0, 'person': 1, 'genre': 2}
    
    print(f"Processing {len(entries)} entries...")
    
    for entry in entries:
        if isinstance(entry, list):
            # Skip if already in array format (or handle if needed)
            continue
            
        type_str = entry.get('type', 'movie')
        type_code = type_map.get(type_str, 0)
        name = entry.get('name', '')
        movie_id = entry.get('movieId')
        
        # Create compact array: [type_code, name, movie_id]
        if movie_id:
            new_entry = [type_code, name, movie_id]
        else:
            new_entry = [type_code, name]
            
        optimized_entries.append(new_entry)
        
    print(f"Writing {len(optimized_entries)} optimized entries to {OUTPUT_FILE}...")
    
    with gzip.open(OUTPUT_FILE, 'wt', encoding='utf-8') as f:
        json.dump(optimized_entries, f, separators=(',', ':'))
        
    print("Done!")

if __name__ == "__main__":
    optimize()
