import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from 'url';

// Fix for __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths - assume running from project root
const ROOT_DIR = process.cwd();
const DB_JSON_PATH = path.join(ROOT_DIR, "public", "database_upload.json");
const DB_GZ_PATH = path.join(ROOT_DIR, "public", "database_upload.json.gz");
const OUTPUT_PATH = path.join(ROOT_DIR, "public", "autocomplete_upload.json");

function loadDatabase() {
  console.log("📥 Loading database file...");
  let rawData;

  // Try JSON first, then GZ
  if (fs.existsSync(DB_JSON_PATH)) {
    rawData = fs.readFileSync(DB_JSON_PATH, 'utf8');
  } else if (fs.existsSync(DB_GZ_PATH)) {
    console.log("   - Decompressing GZ...");
    const buf = fs.readFileSync(DB_GZ_PATH);
    rawData = zlib.gunzipSync(buf).toString('utf8');
  } else {
    throw new Error(`Could not find ${DB_JSON_PATH} or ${DB_GZ_PATH}`);
  }

  const data = JSON.parse(rawData);

  // Normalize structure to a single array of items
  let allItems = [];
  if (Array.isArray(data)) {
    allItems = data;
  } else if (data.movies2026 || data.tvshows2026) {
    const m = data.movies2026 || [];
    const t = data.tvshows2026 || [];
    // Inject content_type if missing to help processor
    m.forEach(i => i.content_type = 'movie');
    t.forEach(i => i.content_type = 'tv');
    allItems = [...m, ...t];
  } else if (data.results && Array.isArray(data.results)) {
    allItems = data.results;
  } else if (data.data && Array.isArray(data.data)) {
    allItems = data.data;
  } else {
    throw new Error("Unknown JSON structure");
  }

  return allItems;
}

function processAutocomplete() {
  try {
    const items = loadDatabase();
    console.log(`   - Loaded ${items.length} source documents.`);

    const suggestions = new Map();
    let counts = { movie: 0, tv: 0, person: 0, genre: 0 };

    items.forEach(doc => {
      // Determine type strictly
      // If content_type is set, use it. Else guess based on title/name presence?
      // Default to movie if ambiguous but has title.
      let type = doc.content_type;
      if (!type) {
        if (doc.title) type = 'movie';
        else if (doc.name) type = 'tv'; // Weak guess, but standard for TMDB
      }

      // 1. ADD MOVIE / TV SHOW
      if (type === 'movie' || type === 'tv') {
        // Movies/TV use 'title'
        const titleText = doc.title || doc.name; 
        // FIX: Prefer 'id' (TMDB ID) over '_id' (Astra ID) to correctly dedup semantic duplicates
        const docId = doc.id || doc._id;
        
        if (titleText && docId) {
          const key = `${type}:${docId}`;
          if (!suggestions.has(key)) {
            suggestions.set(key, {
              type: type,
              title: titleText, // Specific requirement
              name: titleText,  // Adding name as fallback/searchable field for older logic
              id: docId,
              icon: doc.poster_path ? `https://image.tmdb.org/t/p/w92${doc.poster_path}` : null
            });
            counts[type]++;
          }
        }
      }

      // 2. EXTRACT CAST (Person matches use 'name')
      // Supports various TMDB shapes (cast array, credits.cast, cast_details)
      let cast = [];
      if (Array.isArray(doc.cast_details)) cast = doc.cast_details;
      else if (doc.credits && Array.isArray(doc.credits.cast)) cast = doc.credits.cast;
      else if (Array.isArray(doc.cast)) cast = doc.cast;

      cast.forEach(p => {
        const pName = typeof p === 'object' ? p.name : p;
        const pId = typeof p === 'object' ? p.id : pName; // Fallback ID is name
        
        if (pName) {
          const key = `person:${pName.toLowerCase()}`;
          // Only add top-level actors or if unique
          if (!suggestions.has(key)) {
            suggestions.set(key, {
              type: "person",
              name: pName,
              id: pId
            });
            counts.person++;
          }
        }
      });

      // 3. EXTRACT GENRES (Genre matches use 'name')
      if (Array.isArray(doc.genres)) {
        doc.genres.forEach(g => {
          const gName = typeof g === 'object' ? g.name : g;
          const gId = typeof g === 'object' ? g.id : gName;
          
          if (gName) {
            const key = `genre:${gName.toLowerCase()}`;
            if (!suggestions.has(key)) {
              suggestions.set(key, {
                type: "genre",
                name: gName,
                id: gId
              });
              counts.genre++;
            }
          }
        });
      }
    });

    const output = Array.from(suggestions.values());
    console.log("📊 Stats:");
    console.log(`   Movies: ${counts.movie}`);
    console.log(`   TV:     ${counts.tv}`);
    console.log(`   People: ${counts.person}`);
    console.log(`   Genres: ${counts.genre}`);
    
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(`✅ Generated ${output.length} suggestions at ${OUTPUT_PATH}`);

  } catch (err) {
    console.error("Error generating autocomplete:", err);
  }
}

processAutocomplete();
