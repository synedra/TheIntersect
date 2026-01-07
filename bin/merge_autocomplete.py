import json
import os

# Define paths relative to the script location
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Both inputs and output are in the public/ directory
PUBLIC_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), 'public')

FILE_MOVIES = os.path.join(PUBLIC_DIR, 'autocomplete-fresh.json')
FILE_TV = os.path.join(PUBLIC_DIR, 'autocomplete-tv-fresh.json')
FILE_OUTPUT = os.path.join(PUBLIC_DIR, 'autocomplete.json')

def load_data(filepath):
    if not os.path.exists(filepath):
        print(f"Warning: File not found: {filepath}")
        return []
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if isinstance(data, list):
                return data
            elif isinstance(data, dict):
                return data.get('entries', [])
            return []
    except Exception as e:
        print(f"Error loading {filepath}: {e}")
        return []

def main():
    print(f"Loading data from {os.path.basename(FILE_MOVIES)} and {os.path.basename(FILE_TV)}...")
    
    movies = load_data(FILE_MOVIES)
    tv = load_data(FILE_TV)
    
    # Store unique items. Key is (type, lower_case_name).
    # Value is the actual item data.
    unique_items = {}

    def get_type_label(type_code, context):
        """
        Convert numeric type codes to named categories based on context.
        0 -> Movie (if movie context) or TV Show (if tv context)
        1 -> Person
        2 -> Genre
        """
        # Handle None explicitly
        if type_code is None:
             if context == "movie": return "Movie"
             if context == "tv": return "TV Show"
             return "Unknown"

        s = str(type_code)
        
        # Explicit types (1=Person, 2=Genre) ALWAYS override context
        if s == "1":
            return "Person"
        if s == "2":
            return "Genre"

        # Type 0 is context-dependent
        if s == "0":
            if context == "movie":
                return "Movie"
            elif context == "tv":
                return "TV Show"
        
        # If it's already a named string, return it formatted
        if not s.isdigit():
            return s.title()
            
        # Fallback
        if context == "movie": return "Movie"
        if context == "tv": return "TV Show"
        return "Unknown"

    def process_items(items, context):
        count = 0
        for item in items:
            raw_type = None
            name = None
            obj_id = None
            
            # Extract
            if isinstance(item, list) and len(item) >= 2:
                raw_type = item[0]
                name = item[1]
                if len(item) > 2:
                    obj_id = item[2]
            elif isinstance(item, dict):
                raw_type = item.get('type')
                name = item.get('name')
                obj_id = item.get('id') or item.get('movieId')
            elif isinstance(item, str):
                raw_type = "string"
                name = item

            if name:
                label = get_type_label(raw_type, context)
                
                # Dedupe key: (Label, Lowercase Name)
                # This ensures "Tom Hanks" (Person) from movies merges with "Tom Hanks" (Person) from TV
                key = (label, str(name).strip().lower())
                
                new_entry = {
                    "type": label,
                    "name": str(name).strip()
                }
                if obj_id is not None:
                    new_entry["id"] = obj_id
                
                existing = unique_items.get(key)
                if not existing:
                    unique_items[key] = new_entry
                else:
                    # Prefer entry with ID if existing lacks it
                    if "id" not in existing and "id" in new_entry:
                        unique_items[key] = new_entry
                    
            count += 1
        return count

    # Process files with explicit context
    c1 = process_items(movies, "movie")
    c2 = process_items(tv, "tv")
    
    print(f"Processed {c1} items from movies file and {c2} from tv file.")

    combined = list(unique_items.values())

    # Sort alphabetically by name
    def get_sort_key(item):
        return item.get('name', '').lower()

    combined.sort(key=get_sort_key)

    print(f"Total unique entries: {len(combined)}")

    os.makedirs(os.path.dirname(FILE_OUTPUT), exist_ok=True)

    with open(FILE_OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(combined, f, indent=2)

    print(f"Successfully wrote to {FILE_OUTPUT}")

if __name__ == "__main__":
    main()
