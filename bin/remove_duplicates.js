import { DataAPIClient } from "@datastax/astra-db-ts";
import dotenv from "dotenv";

dotenv.config({ override: true });

// Change this to target the specific collection causing issues
const TARGET_COLLECTION = "movies2026"; 

async function removeDuplicates() {
  console.log(`🚀 Starting duplicate removal for collection: ${TARGET_COLLECTION}...`);
  
  if (!process.env.ASTRA_DB_APPLICATION_TOKEN) {
      console.error("Error: ASTRA_DB_APPLICATION_TOKEN not set.");
      return;
  }

  const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
  const db = client.db(process.env.ASTRA_DB_API_ENDPOINT);
  const collection = db.collection(TARGET_COLLECTION);

  try {
    console.log("📥 Scanning documents (this may take a moment)...");
    
    // Using cursor to iterate without loading everything into memory
    const cursor = collection.find({});
    
    const seen = new Set();
    const toDelete = [];
    let scanned = 0;

    for await (const doc of cursor) {
        scanned++;
        if (scanned % 1000 === 0) process.stdout.write(`\r   - Scanned ${scanned} docs...`);

        // Key based on TMDB ID
        // If doc.id is missing, use title as fallback for key
        const tmdbId = doc.id;
        const key = tmdbId ? `id:${tmdbId}` : `title:${doc.title}`;

        if (seen.has(key)) {
            // This is a duplicate!
            toDelete.push(doc._id);
        } else {
            seen.add(key);
        }
    }
    
    console.log(`\n\n📊 Scan Complete:`);
    console.log(`   - Scanned: ${scanned}`);
    console.log(`   - Unique:  ${seen.size}`);
    console.log(`   - Duplicates found: ${toDelete.length}`);

    if (toDelete.length > 0) {
        console.log(`\n🗑️  Deleting ${toDelete.length} duplicates...`);
        
        // Delete in batches of 20 for efficiency
        const BATCH_SIZE = 20;
        let deleted = 0;
        
        for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
            const batch = toDelete.slice(i, i + BATCH_SIZE);
            const promises = batch.map(id => collection.deleteOne({ _id: id }));
            await Promise.all(promises);
            deleted += batch.length;
            process.stdout.write(`\r   - Deleted ${deleted}/${toDelete.length}`);
        }
        console.log("\n✅ Cleanup finished!");
    } else {
        console.log("✅ Database is already clean.");
    }

  } catch (e) {
      console.error("\n❌ Error during cleanup:", e);
  }
}

removeDuplicates();
