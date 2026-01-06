import { DataAPIClient } from "@datastax/astra-db-ts";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ override: true });

const EMBEDDING_MODEL = "text-embedding-3-small"; 

// In-memory cache for autocomplete data
let cachedAutocompleteData = null;
// In-memory cache for discover results
let discoverCache = {};

function getAutocompleteData() {
  if (cachedAutocompleteData) return cachedAutocompleteData;
  
  const cwd = process.cwd();
  const possiblePaths = [
    path.join(cwd, 'public', 'autocomplete.json'),
    path.join(cwd, 'autocomplete.json'),
    './public/autocomplete.json'
  ];
  
  let fileBuffer = null;
  for (const filePath of possiblePaths) {
    try {
      if (fs.existsSync(filePath)) {
        fileBuffer = fs.readFileSync(filePath);
        break;
      }
    } catch (e) {}
  }
  
  if (!fileBuffer) {
    cachedAutocompleteData = [];
    return [];
  }
  
  try {
      cachedAutocompleteData = JSON.parse(fileBuffer.toString('utf8'));
  } catch (e) {
      cachedAutocompleteData = [];
  }
  return cachedAutocompleteData;
}

async function generateEmbedding(text) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text })
  });
  
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "OpenAI error");
  return data.data[0].embedding;
}

async function queryCollections(db, collections, finalFilter, searchQuery, limit) {
  const allResults = [];
  for (const collInfo of collections) {
    try {
      const collection = db.collection(collInfo.name);
      let results;
      if (searchQuery) {
        if (Object.keys(finalFilter).length > 0) {
          results = await collection.find(finalFilter, searchQuery).toArray();
        } else {
          results = await collection.find({}, searchQuery).toArray();
        }
      } else {
        results = await collection.find(finalFilter, { limit }).toArray();
      }
      results.forEach(r => {
        r.content_type = collInfo.type;
        allResults.push(r);
      });
    } catch (e) {
      console.error(`Error querying ${collInfo.name}:`, e);
    }
  }
  return allResults;
}

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const action = qs.action;
  
  const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
  const db = client.db(process.env.ASTRA_DB_API_ENDPOINT);
  
  const contentTypesParam = qs.content_types || "movies";
  const contentTypes = contentTypesParam.split(',').map(t => t.trim());
  const collections = [];
  if (contentTypes.includes('movies')) collections.push({ name: 'movies2026', type: 'movie' });
  if (contentTypes.includes('tvshows')) collections.push({ name: 'tvshows2026', type: 'tv' });
  if (collections.length === 0) collections.push({ name: 'movies2026', type: 'movie' });
  
  const moviesCollection = db.collection('movies2026');

  try {
    switch (action) {
      case "search": {
        let query = qs.query ? decodeURIComponent(qs.query) : "";
        
        // Helper for splitting list params
        const getList = (param) => param ? decodeURIComponent(param).split(',').map(s => s.trim()).filter(Boolean) : [];

        // PRIORITY #1: Exact Movie/Show ID Match (from Autocomplete)
        // User request: "If a movie is selected, it should be the only result... search is essentially just 'Stranger than Fiction'."
        const movieIds = getList(qs.movie_id);
        if (movieIds.length > 0) {
             const results = [];
             for(const c of collections) {
                 try {
                     const docs = await db.collection(c.name).find({ _id: { $in: movieIds } }).toArray();
                     docs.forEach(d => { d.content_type = c.type; results.push(d); });
                 } catch(e){}
             }
             // If we found them, return immediately, ignoring other filters/vectors
             if (results.length > 0) {
                 return { statusCode: 200, body: JSON.stringify({ results: results.map(r => ({...r, id: r._id})) }) }; 
             }
        }
        
        const filterConditions = [];

        // AND Logic for Search Box Filters
        getList(qs.person).forEach(p => filterConditions.push({ cast: p }));
        getList(qs.genre).forEach(g => filterConditions.push({ genres: g }));
        getList(qs.keywords).forEach(k => filterConditions.push({ keywords: k }));
        
        // OR Logic for Language
        const languages = getList(qs.language);
        if (languages.length > 0) filterConditions.push({ original_language: { $in: languages } });

        // OR Logic for Providers
        const providers = getList(qs.providers);
        const paymentTypes = getList(qs.payment_types || "stream");
        
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
             if (paymentTypes.includes('stream')) paymentClauses.push({ "watch_providers.US.stream.0": { $exists: true } });
             if (paymentTypes.includes('rent')) paymentClauses.push({ "watch_providers.US.rent.0": { $exists: true } });
             if (paymentTypes.includes('buy')) paymentClauses.push({ "watch_providers.US.buy.0": { $exists: true } });
             if (paymentClauses.length > 0) filterConditions.push({ $or: paymentClauses });
        }

        const limit = parseInt(qs.limit) || 20;
        const finalFilter = filterConditions.length > 0 ? { $and: filterConditions } : {};
        
        let searchResults;

        if (query && query.length >= 2) {
             
             // PRIORITY #2: Exact Title Match (Text Search)
             // User request: "Don't do a similar search if you have an exact match."
             let exactMatches = [];
             for(const c of collections) {
                 try {
                     const coll = db.collection(c.name);
                     const field = c.type === 'movie' ? 'title_lower' : 'name_lower';
                     // Note: We use the existing filters here (e.g. providers) because the user might just be searching by text + provider
                     const exacts = await coll.find({ ...finalFilter, [field]: query.toLowerCase() }, { limit: 5 }).toArray();
                     exacts.forEach(e => { e.content_type = c.type; exactMatches.push(e); });
                 } catch(e){}
             }
             
             // If we have exact title matches, return ONLY them
             if (exactMatches.length > 0) {
                 return { statusCode: 200, body: JSON.stringify({ results: exactMatches.map(r => ({...r, id: r._id})) }) };
             }

             const queryEmbedding = await generateEmbedding(query);
             const vectorResults = await queryCollections(db, collections, finalFilter, { sort: { $vector: queryEmbedding }, limit, includeSimilarity: true }, limit);
             
             // Exact title match attempt (Legacy / Fallback logic if distinct from above)
             // We can keep this merged logic just in case the "exactMatches" block above missed something due to filter edge cases,
             // but effectively exactMatches should have caught it.
             
             const merged = [...vectorResults.map(r => ({...r, sortScore: r.$similarity || 0}))];
             const unique = [];
             const seen = new Set();
             merged.sort((a,b) => b.sortScore - a.sortScore);
             for(const r of merged) {
                 if(!seen.has(r._id)) { seen.add(r._id); unique.push({...r, id: r._id}); }
             }
             searchResults = unique.slice(0, limit);
        } else {
             searchResults = await queryCollections(db, collections, finalFilter, null, limit);
             searchResults.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        }
        
        return { statusCode: 200, body: JSON.stringify({ results: searchResults.map(r => ({...r, id: r._id})) }) };
      }

      case "details": {
         const itemId = qs.id;
         if(!itemId) return { statusCode: 400, body: JSON.stringify({ error: "Missing item ID" }) };
         
         const lookupCollections = [{ name: 'movies2026', type: 'movie' }, { name: 'tvshows2026', type: 'tv' }];
         for(const c of lookupCollections) {
             try {
                const collection = db.collection(c.name);
                const item = await collection.findOne({ _id: itemId });
                if(item) {
                    item.content_type = c.type;
                    return { statusCode: 200, body: JSON.stringify(item) };
                }
             } catch (e) {
                 console.warn(`Error finding item ${itemId} in ${c.name}:`, e);
             }
         }
         return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
      }

      case "discover": {
        const limit = parseInt(qs.limit) || 20;

        // Check cache
        const cacheKey = `discover:${contentTypes.sort().join(',')}:${limit}`;
        const now = Date.now();
        const TTL = 3600 * 1000; // 1 hour
        if (discoverCache[cacheKey] && (now - discoverCache[cacheKey].timestamp < TTL)) {
            console.log(`[Cache] Serving discover results from cache for key: ${cacheKey}`);
            return { statusCode: 200, body: JSON.stringify(discoverCache[cacheKey].data) };
        }

        const minPopularity = collections.length > 1 ? 100 : 75;
        const allResults = [];
        for (const collInfo of collections) {
          try {
            const collection = db.collection(collInfo.name);
            const results = await collection.find({ popularity: { $gte: minPopularity } }, { sort: { popularity: -1 }, limit: limit * 2 }).toArray();
            results.forEach(item => { item.content_type = collInfo.type; allResults.push(item); });
          } catch (e) {}
        }
        allResults.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        
        const responseData = { results: allResults.slice(0, limit).map(r => ({...r, id: r._id})) };
        
        // Update cache
        discoverCache[cacheKey] = {
            timestamp: now,
            data: responseData
        };
        console.log(`[Cache] Updated discover cache for key: ${cacheKey}`);
        
        return { statusCode: 200, body: JSON.stringify(responseData) };
      }

      case "get": {
        const movieId = qs.id;
        if (!movieId) return { statusCode: 400, body: JSON.stringify({ error: "Missing movie ID" }) };
        const movie = await moviesCollection.findOne({ _id: movieId });
        return { statusCode: 200, body: JSON.stringify(movie) };
      }

      case "suggestions": {
        const query = qs.query || "";
        const type = qs.type; 
        let results = [];
        if (!type || type === "person") {
          const people = await moviesCollection.find({ "cast": { $eq: query } }, { limit: 6, projection: { "cast": 1 } });
          const uniquePeople = new Set();
          people.data.forEach(movie => { movie.cast?.forEach(person => { if (person.name === query) uniquePeople.add(JSON.stringify({ type: "person", id: person.id, name: person.name })); }); });
          results.push(...Array.from(uniquePeople).map(p => JSON.parse(p)).slice(0, 6));
        }
        if (!type || type === "genre") {
          const genres = await moviesCollection.find({ "genres": { $eq: query } }, { limit: 6, projection: { "genres": 1 } });
          const uniqueGenres = new Set();
          genres.data.forEach(movie => { movie.genres?.forEach(genre => { if (genre.name === query) uniqueGenres.add(JSON.stringify({ type: "genre", id: genre.id, name: genre.name })); }); });
          results.push(...Array.from(uniqueGenres).map(g => JSON.parse(g)).slice(0, 6));
        }
        if (!type || type === "keyword") {
          const keywords = await moviesCollection.find({ "keywords.name": { $eq: query } }, { limit: 6, projection: { "keywords": 1 } });
          const uniqueKeywords = new Set();
          keywords.data.forEach(movie => { movie.keywords?.forEach(keyword => { if (keyword.name === query) uniqueKeywords.add(JSON.stringify({ type: "keyword", id: keyword.id, name: keyword.name })); }); });
          results.push(...Array.from(uniqueKeywords).map(k => JSON.parse(k)).slice(0, 6));
        }
        return { statusCode: 200, body: JSON.stringify({ results }) };
      }

      case "popular": {
        const limit = 20;
        const allResults = [];
        for (const collInfo of collections) {
          try {
            const collection = db.collection(collInfo.name);
            const results = await collection.find({ popularity: { $gte: 75 } }, { sort: { popularity: -1 }, limit: limit * 2 }).toArray();
            results.forEach(item => { item.content_type = collInfo.type; allResults.push(item); });
          } catch (e) {}
        }
        allResults.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
        const results = allResults.slice(0, limit);
        const mappedResults = results.map(movie => ({ ...movie, id: movie._id }));
        return { statusCode: 200, body: JSON.stringify({ results: mappedResults, total_pages: 1, page: 1, total_results: results.length }) };
      }

      case "genre": {
        const genre = qs.genre;
        if (!genre) return { statusCode: 400, body: JSON.stringify({ error: "Missing genre" }) };
        const results = await moviesCollection.find({ "genres": { $in: [genre]} }, { limit: 20 }).toArray();
        const mappedResults = results.map(movie => ({ ...movie, id: movie._id }));
        return { statusCode: 200, body: JSON.stringify({ results: mappedResults }) };
      }

      case "person": {
        const name = qs.name;
        if (!name) return { statusCode: 400, body: JSON.stringify({ error: "Missing name" }) };
        const results = await moviesCollection.find({ "cast": { $in: [name] } }, { limit: 20 }).toArray();
        const mappedResults = results.map(movie => ({ ...movie, id: movie._id }));
        return { statusCode: 200, body: JSON.stringify({ results: mappedResults }) };
      }

      case "autocomplete": {
          const query = qs.query ? qs.query.toLowerCase() : "";
          if(query.length < 2) return { statusCode: 200, body: JSON.stringify({ results: [] }) };
          
          const data = getAutocompleteData();
          let matches = data.filter(d => d.name && d.name.toLowerCase().includes(query));

          // Sort smart: startsWith > short names > others
          matches.sort((a, b) => {
             const aName = a.name.toLowerCase();
             const bName = b.name.toLowerCase();
             const aStarts = aName.startsWith(query);
             const bStarts = bName.startsWith(query);

             if (aStarts && !bStarts) return -1;
             if (!aStarts && bStarts) return 1;
             return aName.length - bName.length;
          });

          matches = matches.slice(0, 50);
          
          const results = [];
          const seen = new Set();
          for(const m of matches) {
              const key = `${m.type}:${m.name}`;
              if(seen.has(key)) continue;
              seen.add(key);
              
              let result = {};
              if (m.type === 'movie') {
                result = { type: 'movie', id: m.movieId, title: m.name };
              } else if (m.type === 'person') {
                result = { type: 'person', id: m.movieId, name: m.name };
              } else if (m.type === 'genre') {
                result = { type: 'genre', id: m.movieId, name: m.name };
              }
              if (m.icon) result.icon = m.icon;
              results.push(result);
          }
          return { statusCode: 200, body: JSON.stringify({ results }) };
      }

      case "similar": {
        const itemId = qs.id;
        const limit = parseInt(qs.limit) || 6;
        if (!itemId) return { statusCode: 400, body: JSON.stringify({ error: "Missing item ID" }) };

        console.log(`[Similar] Searching for vector for item: ${itemId}`);

        const allCollections = [
          { name: 'movies2026', type: 'movie' },
          { name: 'tvshows2026', type: 'tv' }
        ];
        
        // 1. Find the source item and its vector
        let sourceVector = null;
        for (const collInfo of allCollections) {
            try {
                const collection = db.collection(collInfo.name);
                const result = await collection.findOne({ _id: itemId }, { projection: { $vector: 1 } });
                if (result) {
                     console.log(`[Similar] Found item in ${collInfo.name}. Vector present: ${!!result.$vector}`);
                     if (result.$vector) {
                        // Ensure vector is a plain array (handle driver specifics)
                        if (Array.isArray(result.$vector)) {
                            sourceVector = result.$vector;
                        } else if (result.$vector._vector && Array.isArray(result.$vector._vector)) {
                             sourceVector = result.$vector._vector;
                        } else if (result.$vector.data && Array.isArray(result.$vector.data)) {
                             // Fallback for some other driver versions
                             sourceVector = result.$vector.data;
                        } else {
                             // Last resort, try object.values or assume it is usable if not caught above,
                             // specific error showed {"_vector": ...} so the second clause should catch it.
                             sourceVector = result.$vector; 
                        }
                        break;
                     }
                }
            } catch (e) {
                console.error(`[Similar] Error checking collection ${collInfo.name}:`, e);
            }
        }

        if (!sourceVector) {
          console.log("[Similar] No source vector found. Falling back to Genre match.");
          
          let sourceGenres = null;
          // Find genres from source item
          for (const collInfo of allCollections) {
               try {
                   const result = await db.collection(collInfo.name).findOne({ _id: itemId });
                   if (result && result.genres) {
                       sourceGenres = result.genres; // Array of objects or strings
                       break;
                   }
               } catch(e) {}
          }
          
          if (!sourceGenres || sourceGenres.length === 0) {
              return { statusCode: 200, body: JSON.stringify({ results: [] }) };
          }
          
          // Normalize genres to strings
          const genreNames = sourceGenres.map(g => typeof g === 'object' ? g.name : g).filter(Boolean);
          if (genreNames.length === 0) return { statusCode: 200, body: JSON.stringify({ results: [] }) };

          // Query by genre
          let genreResults = [];
          for (const collInfo of allCollections) {
               try {
                   const movies = await db.collection(collInfo.name).find(
                       { "genres.name": { $in: genreNames } }, 
                       { limit: limit + 2, sort: { popularity: -1 } } 
                   ).toArray();
                   
                   movies.forEach(m => {
                       if (m._id !== itemId) {
                           m.content_type = collInfo.type;
                           genreResults.push(m);
                       }
                   });
               } catch(e) {}
          }
          
          // Sort by popularity as proxy for quality match
          genreResults.sort((a,b) => (b.popularity || 0) - (a.popularity || 0));
          const finalFallback = genreResults.slice(0, limit).map(item => ({ ...item, id: item._id }));
          return { statusCode: 200, body: JSON.stringify({ results: finalFallback }) };
        }

        // 2. Query BOTH collections
        let allSimilarResults = [];
        for (const collInfo of allCollections) {
            try {
                console.log(`[Similar] Querying ${collInfo.name} for similar items...`);
                const collection = db.collection(collInfo.name);
                const items = await collection.find(
                  {}, 
                  { sort: { $vector: sourceVector }, limit: limit + 5, includeSimilarity: true }
                ).toArray();

                console.log(`[Similar] Found ${items.length} items in ${collInfo.name}`);

                items.forEach(r => {
                    if (r._id !== itemId) {
                        r.content_type = collInfo.type;
                        allSimilarResults.push(r);
                    }
                });
            } catch (e) {
                console.error(`[Similar] Error querying ${collInfo.name}:`, e);
            }
        }


        allSimilarResults.sort((a, b) => (b.$similarity || 0) - (a.$similarity || 0));
        const finalResults = allSimilarResults.slice(0, limit).map(item => ({ ...item, id: item._id }));

        return { statusCode: 200, body: JSON.stringify({ results: finalResults }) };
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid action" }) };
    }
  } catch (err) {
    console.error("Astra DB error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err?.message || String(err) }) };
  }
}
