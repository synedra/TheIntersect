import { DataAPIClient } from "@datastax/astra-db-ts";
import dotenv from "dotenv";

dotenv.config({ override: true });

async function runSearch() {
  const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
  const db = client.db(process.env.ASTRA_DB_API_ENDPOINT);
  
  const collections = [
      { name: 'movies2026', type: 'movie' },
      { name: 'tvshows2026', type: 'tv' }
  ];

  // --- CONFIGURATION FOR TEST ---
  const genre = "Horror";
  const providers = []; 
  const paymentTypes = ["stream"];
  const limit = 20;
  // ------------------------------

  console.log(`Testing search for Genre: ${genre}, Providers: ${providers.join(', ')}`);

  const filterConditions = [];
  if (genre) filterConditions.push({ genres: genre });
  
  if (providers.length > 0) {
       const providerClauses = providers.map(provider => {
           let variants = [provider];
           if (provider === "Disney+") variants.push("Disney Plus");
           if (provider === "Paramount+") variants.push("Paramount Plus", "Paramount Plus Essential", "Paramount Plus Premium");
           if (provider === "Apple TV+") variants.push("Apple TV", "Apple TV Plus");
           if (provider === "Amazon Prime Video") variants.push("Amazon Prime Video with Ads");
           if (provider === "Peacock") variants.push("Peacock Premium", "Peacock Premium Plus");
           if (provider === "YouTube") variants.push("YouTube Premium", "YouTube TV");
           if (provider === "Tubi") variants.push("Tubi TV");
           
           const clauses = [];
           if (paymentTypes.includes('stream')) clauses.push({ "watch_providers.US.stream": { $in: variants } });
           if (paymentTypes.includes('rent')) clauses.push({ "watch_providers.US.rent": { $in: variants } });
           if (paymentTypes.includes('buy')) clauses.push({ "watch_providers.US.buy": { $in: variants } });
           if (clauses.length === 0) clauses.push({ "watch_providers.US.stream": { $in: variants } });
           
           return { $or: clauses };
      });
      filterConditions.push({ $or: providerClauses });
  } else {
       const paymentClauses = [];
       // Optimized: Check for field existence instead of array index (.0) to prevent deep scan timeouts
       if (paymentTypes.includes('stream')) paymentClauses.push({ "watch_providers.US.stream": { $exists: true } });
       if (paymentTypes.includes('rent')) paymentClauses.push({ "watch_providers.US.rent": { $exists: true } });
       if (paymentTypes.includes('buy')) paymentClauses.push({ "watch_providers.US.buy": { $exists: true } });
       if (paymentClauses.length > 0) filterConditions.push({ $or: paymentClauses });
  }

  // Logic from astra.js: If single filter, apply vote_average > 7
  if (genre) {
      filterConditions.push({ vote_average: { $gt: 7 } }); 
  }

  const finalFilter = filterConditions.length > 0 ? { $and: filterConditions } : {};
  const searchOptions = { 
      limit, 
      sort: { popularity: -1 } 
  };

  console.log("Filter:", JSON.stringify(finalFilter, null, 2));
  console.log("Options:", JSON.stringify(searchOptions, null, 2));

  // Run in parallel to catch timeouts faster and be more efficient
  const promises = collections.map(async (collInfo) => {
    try {
      console.log(`Querying ${collInfo.name}...`);
      const collection = db.collection(collInfo.name);
      
      const start = Date.now();
      const results = await collection.find(finalFilter, searchOptions).toArray();
      const duration = Date.now() - start;
      
      console.log(`Finished ${collInfo.name} in ${duration}ms. Found ${results.length} results.`);
      
      return results.map(r => {
        r.content_type = collInfo.type;
        return r;
      });
    } catch (e) {
      console.error(`Error querying ${collInfo.name}:`, e);
      return [];
    }
  });

  const resultsArrays = await Promise.all(promises);
  const allResults = resultsArrays.flat();

  // Sort combined results by popularity
  allResults.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

  console.log(`\nTotal results: ${allResults.length}`);
  console.log("Top 20 Results:");
  allResults.slice(0, 20).forEach((r, i) => {
      console.log(`${i+1}. [${r.vote_average}] ${r.title || r.name} (Pop: ${r.popularity})`);
  });
}

runSearch().catch(console.error);
