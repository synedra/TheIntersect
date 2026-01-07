import { DataAPIClient } from "@datastax/astra-db-ts";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import zlib from "zlib";
import { pipeline } from "stream/promises";

dotenv.config({ override: true });

const COLLECTION_NAME = "tv_and_movies";
const AUTOCOMPLETE_DEST = "public/autocomplete-new.json";

// Adjust these filenames if your zip files are named differently
const DB_GZ_FILE = "public/database_upload.json.gz"; 
const AC_GZ_FILE = "public/autocomplete_upload.json.gz";

// Adjust these if the JSONs inside the zips have different names
const DB_JSON_FILE = "public/database_upload.json";
const AC_JSON_FILE = "public/autocomplete_upload.json";

async function runSetup() {
  console.log("🚀 Starting setup...");

  const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
  const db = client.db(process.env.ASTRA_DB_API_ENDPOINT);

  // 1. Unzip Files
  console.log("📦 Unzipping files...");
  
  if (fs.existsSync(DB_GZ_FILE)) {
      console.log(`   - Decompressing ${DB_GZ_FILE}...`);
      await pipeline(
          fs.createReadStream(DB_GZ_FILE),
          zlib.createGunzip(),
          fs.createWriteStream(DB_JSON_FILE)
      );
      console.log(`   - Extracted ${DB_JSON_FILE}`);
  } else if (!fs.existsSync(DB_JSON_FILE)) {
      console.error(`❌ Error: ${DB_GZ_FILE} not found and ${DB_JSON_FILE} is missing.`);
      process.exit(1);
  }

  if (fs.existsSync(AC_GZ_FILE)) {
      console.log(`   - Decompressing ${AC_GZ_FILE}...`);
      await pipeline(
          fs.createReadStream(AC_GZ_FILE),
          zlib.createGunzip(),
          fs.createWriteStream(AC_JSON_FILE)
      );
      console.log(`   - Extracted ${AC_JSON_FILE}`);
  } else if (!fs.existsSync(AC_JSON_FILE)) {
       console.log(`⚠️  Warning: ${AC_GZ_FILE} not found. Skipping autocomplete move if JSON is missing.`);
  }

  // 2. Move Autocomplete JSON
  if (fs.existsSync(AC_JSON_FILE)) {
      const acJsonPath = AC_JSON_FILE;
      console.log("🚚 Processing autocomplete file...");
      
      try {
          const rawAc = fs.readFileSync(acJsonPath, 'utf8');
          let acData = JSON.parse(rawAc);
          let finalAutocomplete = [];

          // Unwrap and Normalize
          if (Array.isArray(acData)) {
              finalAutocomplete = acData;
          } else {
              // Check for standard wrappers
              if (acData.entries && Array.isArray(acData.entries)) {
                  finalAutocomplete = acData.entries;
              } else if (acData.data && Array.isArray(acData.data)) {
                  finalAutocomplete = acData.data;
              } else if (acData.results && Array.isArray(acData.results)) {
                  finalAutocomplete = acData.results;
              } else {
                  // Check for Dictionary format (e.g. { "movies": [...], "people": [...] })
                  // We iterate keys and inject 'type'
                  console.log("   - Detected dictionary format, flattening...");
                  
                  for (const [key, items] of Object.entries(acData)) {
                      if (!Array.isArray(items)) continue;

                      let type = "movie"; // Default
                      const lowerKey = key.toLowerCase();
                      
                      if (lowerKey.includes("tv") || lowerKey.includes("show")) type = "tv";
                      else if (lowerKey.includes("person") || lowerKey.includes("people") || lowerKey.includes("cast")) type = "person";
                      else if (lowerKey.includes("genre")) type = "genre";
                      else if (lowerKey.includes("keyword")) type = "keyword";
                      else if (lowerKey.includes("movie")) type = "movie";
                      
                      const typedItems = items.map(item => {
                          // Handle string items (just names)
                          if (typeof item === 'string') return { name: item, type };
                          // Handle object items: ensure type is set
                          return { ...item, type: item.type || type };
                      });
                      
                      finalAutocomplete.push(...typedItems);
                      console.log(`     - Merged ${items.length} items from '${key}' as '${type}'`);
                  }
              }
          }
          
          if (finalAutocomplete.length > 0) {
              // Deduplicate results
              const uniqueItems = [];
              const seen = new Set();

              for (const item of finalAutocomplete) {
                  // Create a unique key using Type + (ID or Name)
                  // This handles cases where the same movie appears multiple times
                  const identifier = item.id || item.name;
                  const key = `${item.type}:${identifier}`;
                  
                  if (!seen.has(key)) {
                      seen.add(key);
                      uniqueItems.push(item);
                  }
              }

              fs.writeFileSync(AUTOCOMPLETE_DEST, JSON.stringify(uniqueItems));
              console.log(`   - Saved cleaned array of ${uniqueItems.length} items to ${AUTOCOMPLETE_DEST} (Removed ${finalAutocomplete.length - uniqueItems.length} duplicates)`);
          } else {
              console.warn("   ⚠️ Warning: Could not find valid array in autocomplete data. Saving as-is.");
              fs.renameSync(AC_JSON_FILE, AUTOCOMPLETE_DEST);
          }
          
          // Clean up the temp extracted file if we didn't rename it
          if (acJsonPath !== AUTOCOMPLETE_DEST) {
              fs.unlinkSync(acJsonPath);
              console.log(`   - Removed temporary file ${acJsonPath}`);
          }

      } catch (e) {
          console.error("   ❌ Error processing autocomplete JSON:", e);
      }
  }

  // 3. Create Collection
  console.log(`✨ Creating collection '${COLLECTION_NAME}'...`);
  try {
    // Create collection with vector support (adjust dimension/metric if needed)
    await db.createCollection(COLLECTION_NAME, { 
        vector: { 
            dimension: 1536, 
            metric: "cosine" 
        } 
    });
    console.log("   - Collection created.");
  } catch (e) {
    if (e.message.includes("already exists")) {
        console.log("   - Collection already exists.");
    } else {
        console.error("   ❌ Error creating collection:", e);
        process.exit(1);
    }
  }

  // 4. Upload Data
  console.log("📤 Uploading data to Astra DB (this may take a moment)...");
  
  if (!fs.existsSync(DB_JSON_FILE)) {
      console.error(`❌ Error: ${DB_JSON_FILE} not found.`);
      process.exit(1);
  }

  const rawData = fs.readFileSync(DB_JSON_FILE, 'utf8');
  let data = JSON.parse(rawData); 
  
  if (!Array.isArray(data)) {
      // Handle various wrapper formats
      if (data.results && Array.isArray(data.results)) {
          console.log("   - Found 'results' array wrapper, using inner data.");
          data = data.results;
      } else if (data.data && Array.isArray(data.data)) {
          console.log("   - Found 'data' array wrapper, using inner data.");
          data = data.data;
      } else if (data.movies2026 || data.tvshows2026) {
          // Handle case where file contains specific collection keys
          console.log("   - Found separated collections (movies2026/tvshows2026), merging...");
          const movies = Array.isArray(data.movies2026) ? data.movies2026 : [];
          const tv = Array.isArray(data.tvshows2026) ? data.tvshows2026 : [];
          
          // Identify content types if missing
          movies.forEach(m => { if (!m.content_type) m.content_type = 'movie'; });
          tv.forEach(t => { if (!t.content_type) t.content_type = 'tv'; });

          data = [...movies, ...tv];
          console.log(`     Merged ${movies.length} movies and ${tv.length} TV shows.`);
      } else {
          console.error("❌ Error: database_upload.json structure not recognized. Expected array or object with 'results', 'data', 'movies2026', or 'tvshows2026'.");
          process.exit(1);
      }
  }

  // Deduplicate data before upload based on _id
  if (data.length > 0) {
      console.log(`   - Deduplicating ${data.length} documents...`);
      const uniqueDocs = new Map();
      let duplicatesFound = 0;

      for (const doc of data) {
          if (doc._id) {
              if (uniqueDocs.has(doc._id)) {
                  duplicatesFound++;
              } else {
                  uniqueDocs.set(doc._id, doc);
              }
          } else {
              // If no _id, we can't reliably dedup without content hashing, likely safe to add or let Astra handle key gen
              // For safety in this specific context, we'll treat them as unique unless user specifies otherwise
              // But effectively, if we want to query by ID later, they should have one.
              // We'll push them to a temp array or just map them by a generated key if needed.
              // Assuming most have _id from previous exports.
              uniqueDocs.set(Math.random(), doc); 
          }
      }
      
      data = Array.from(uniqueDocs.values());
      console.log(`     Removed ${duplicatesFound} duplicates. Final count to upload: ${data.length}`);
  }

  const collection = db.collection(COLLECTION_NAME);
  
  // Chunking upload to avoid limits
  const CHUNK_SIZE = 50;
  let successCount = 0;
  
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
      const chunk = data.slice(i, i + CHUNK_SIZE);
      try {
          // Ensure _id matching if provided, otherwise Astra generates one
          await collection.insertMany(chunk, { ordered: false });
          successCount += chunk.length;
          process.stdout.write(`\r   - Uploaded ${successCount}/${data.length} documents...`);
      } catch (e) {
          console.error(`\n   ❌ Error uploading chunk at index ${i}:`, e.message);
      }
  }

  console.log(`\n✅ Setup complete! Verified ${successCount} documents uploaded.`);
}

runSetup().catch(console.error);
