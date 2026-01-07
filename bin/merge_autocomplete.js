const fs = require('fs');
const path = require('path');

// Configuration
const FILE_MOVIES = 'autocomplete-fresh.json';
const FILE_TV = 'autocomplete-tv-fresh.json'; // Assumed .json instead of .com
const FILE_OUTPUT = 'public/autocomplete.json';

const pathMovies = path.join(__dirname, '..', FILE_MOVIES);
const pathTV = path.join(__dirname, '..', FILE_TV);
const pathOutput = path.join(__dirname, '..', FILE_OUTPUT);

function loadFile(filePath) {
    if (!fs.existsSync(filePath)) {
        console.warn(`Warning: File not found: ${filePath}`);
        return [];
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        // Handle if file wraps data in an object propery like "entries" or return array directly
        return Array.isArray(data) ? data : (data.entries || []);
    } catch (e) {
        console.error(`Error reading ${filePath}:`, e.message);
        return [];
    }
}

function process() {
    console.log(`Reading from ${FILE_MOVIES} and ${FILE_TV}...`);
    
    const movies = loadFile(pathMovies);
    const tv = loadFile(pathTV);
    
    console.log(`Loaded ${movies.length} movie entries and ${tv.length} TV entries.`);

    // Use a Map to deduplicate based on a unique key
    // Key format: "name|id|type" ensures we don't duplicate identical entries
    // If IDs collide between Movies and TV (which is possible with TMDB integer IDs), 
    // we might want to keep them if we can distinguish them. 
    // However, if the requirement is strict deduplication of content:
    const uniqueEntries = new Map();

    const addEntries = (list) => {
        list.forEach(entry => {
            let key;
            if (Array.isArray(entry)) {
                // Format: [type, name, id]
                // simple dedupe on name + id
                key = `${entry[1]}|${entry[2]}`;
            } else {
                // Object format
                key = `${entry.name}|${entry.id || entry.movieId}`;
            }

            if (!uniqueEntries.has(key)) {
                uniqueEntries.set(key, entry);
            }
        });
    };

    addEntries(movies);
    addEntries(tv);

    const merged = Array.from(uniqueEntries.values());
    
    // Sort alphabetically by name
    merged.sort((a, b) => {
        const nameA = Array.isArray(a) ? a[1] : a.name;
        const nameB = Array.isArray(b) ? b[1] : b.name;
        return nameA.localeCompare(nameB);
    });

    console.log(`Total unique entries: ${merged.length}`);
    
    // Ensure public dir exists
    const publicDir = path.dirname(pathOutput);
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }

    fs.writeFileSync(pathOutput, JSON.stringify(merged)); // Compact JSON
    console.log(`Successfully merged to ${pathOutput}`);
}

process();
