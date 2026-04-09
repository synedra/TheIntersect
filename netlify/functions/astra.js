import { DataAPIClient } from "@datastax/astra-db-ts";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ override: true });

const EMBEDDING_MODEL = "text-embedding-3-small"; 

// Instantiate client globally to reuse connection across invocations
const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
const db = client.db(process.env.ASTRA_DB_API_ENDPOINT);

// In-memory cache for autocomplete data
let cachedAutocompleteData = null;
// In-memory cache for discover results
let discoverCache = {};
// In-memory cache for genre searches
let genreCache = {};

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

function getCollection(collInfo) {
  if (collInfo.keyspace) {
    const keyspaceEnvVar = collInfo.keyspace === 'boardgames' 
      ? process.env.ASTRA_BOARDGAME_KEYSPACE 
      : collInfo.keyspace;
    
    const dbInstance = client.db(process.env.ASTRA_DB_API_ENDPOINT, { 
      keyspace: keyspaceEnvVar
    });
    console.log(`[getCollection] Using keyspace: ${keyspaceEnvVar} for collection: ${collInfo.name}`);
    return dbInstance.collection(collInfo.name);
  }
  return db.collection(collInfo.name);
}

async function queryCollections(db, collections, finalFilter, searchQuery, limit) {
  const promises = collections.map(async (collInfo) => {
    try {
      const collection = getCollection(collInfo);

      console.log(`[Astra Call] Collection: ${collInfo.name} ${collInfo.keyspace ? `(keyspace: ${collInfo.keyspace})` : ''}`);
      console.log(`Filter:`, JSON.stringify(finalFilter));
      console.log(`Options:`, JSON.stringify(searchQuery || { limit }));

      const options = { ...(searchQuery || { limit }), projection: { $vector: 0 } };

      let results;
      if (searchQuery) {
        if (Object.keys(finalFilter).length > 0) {
          console.log("Using filter with vector search");
          results = await collection.find(finalFilter, options).toArray();
        } else {
          console.log("Using vector search without filter");
          results = await collection.find({}, options).toArray();
        }
      } else {
        results = await collection.find(finalFilter, options).toArray();
      }
      
      console.log(`[Astra Call] Retrieved ${results.length} results from ${collInfo.name}`);
      
      return results.map(r => {
        r.content_type = collInfo.type;
        return r;
      });
    } catch (e) {
      console.error(`Error querying ${collInfo.name}:`, e);
      console.error(`Error details:`, e.message, e.stack);
      return [];
    }
  });

  const resultsArrays = await Promise.all(promises);
  return resultsArrays.flat();
}

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const action = qs.action;
  
  // Read settings from query parameters
  const showSimilar  = qs.show_similar = "true";
  
  // Client and db are now global
  
  const contentTypesParam = qs.content_types || "movies";
  const contentTypes = contentTypesParam.split(',').map(t => t.trim());
  const collections = [];
  if (contentTypes.includes('movies')) collections.push({ name: 'movies2026', type: 'movie' });
  if (contentTypes.includes('tvshows')) collections.push({ name: 'tvshows2026', type: 'tv' });
  if (contentTypes.includes('boardgames')) collections.push({ name: 'bgg_board_games', type: 'boardgame', keyspace: 'boardgames' });
  if (collections.length === 0) collections.push({ name: 'movies2026', type: 'movie' });
  
  const moviesCollection = db.collection('movies2026');

  try {
    switch (action) {
      case "search": {
        let query = qs.query ? decodeURIComponent(qs.query) : "";
        
        // Helper for splitting list params
        const getList = (param) => param ? decodeURIComponent(param).split(',').map(s => s.trim()).filter(Boolean) : [];

        // Hoist variable declarations for cache checking
        const movieIds = getList(qs.movie_id);
        const bggIds = getList(qs.bgg_id).map(id => `bgg_${id}`);
        const personList = getList(qs.person);
        const genreList = getList(qs.genre);
        const keywordList = getList(qs.keywords);
        const languages = getList(qs.language);
        const providers = getList(qs.providers);
        const paymentTypes = getList(qs.payment_types || "stream");
        const limit = parseInt(qs.limit) || 20;

        // NEW: Type filter (movie, person, genre)
        const typeFilter = qs.type_filter; // Expected values: "movie", "person", "genre"

        // Check if we're searching board games
        const isBoardGameSearch = contentTypes.includes('boardgames') && contentTypes.length === 1;

        // Check for "bare genre search" cache hit
        // Conditions: No text query, no specific movie/person/keyword/language/provider filters, but Genres ARE selected.
        const isBareGenre = genreList.length > 0 && 
                            (!query || query.length < 2) && 
                            movieIds.length === 0 && 
                            personList.length === 0 && 
                            keywordList.length === 0 && 
                            languages.length === 0 && 
                            providers.length === 0;

        let genreCacheKey = null;
        if (isBareGenre) {
            genreCacheKey = `genre:${genreList.sort().join('|')}:${contentTypes.sort().join('|')}:${paymentTypes.sort().join('|')}:${limit}`;
            const now = Date.now();
            if (genreCache[genreCacheKey] && (now - genreCache[genreCacheKey].timestamp < 3600000)) { // 1 hour TTL
                console.log(`[Cache] Serving genre search from cache: ${genreCacheKey}`);
                return { statusCode: 200, body: JSON.stringify({ results: genreCache[genreCacheKey].data }) };
            }
        }

        // PRIORITY #1: Exact Movie/Show/Boardgame ID Match (from Autocomplete)
        // User request: "If a movie or boardgame is selected, it should be the only result."
        // (movieIds and bggIds already parsed above)
        if (movieIds.length > 0 || bggIds.length > 0) {
             const results = [];
             for(const c of collections) {
                 try {
                     let query;
                     if (c.type === 'boardgame' && bggIds.length > 0) {
                       query = { _id: { $in: bggIds } };
                     } else if (c.type === 'movie' && movieIds.length > 0) {
                       query = { _id: { $in: movieIds } };
                     } else {
                       continue;
                     }
                     const docs = await getCollection(c).find(query).toArray();
                     docs.forEach(d => { d.content_type = c.type; results.push(d); });
                 } catch(e){}
             }
             
             // If we found them
             if (results.length > 0) {
                 // Check if showSimilar setting is enabled
                 if (showSimilar && results[0].$vector) {
                     console.log("[Search] showSimilar enabled, finding similar items to selected item");
                     
                     // Get the vector from the first matched movie
                     let sourceVector = results[0].$vector;
                     
                     // Normalize vector format
                     if (!Array.isArray(sourceVector)) {
                         if (sourceVector._vector && Array.isArray(sourceVector._vector)) {
                             sourceVector = sourceVector._vector;
                         } else if (sourceVector.data && Array.isArray(sourceVector.data)) {
                             sourceVector = sourceVector.data;
                         }
                     }
                     
                     if (Array.isArray(sourceVector)) {
                         // Perform vector similarity search across collections
                         let similarResults = [];
                         for (const collInfo of collections) {
                             try {
                                 const collection = db.collection(collInfo.name);
                                 const items = await collection.find(
                                     {},
                                     { sort: { $vector: sourceVector }, limit: limit, includeSimilarity: true, projection: { $vector: 0 } }
                                 ).toArray();
                                 
                                 items.forEach(item => {
                                     item.content_type = collInfo.type;
                                     similarResults.push(item);
                                 });
                             } catch(e) {
                                 console.error(`Error querying ${collInfo.name} for similar:`, e);
                             }
                         }
                         
                         // Sort by similarity and return top results
                         similarResults.sort((a, b) => (b.$similarity || 0) - (a.$similarity || 0));
                         return { statusCode: 200, body: JSON.stringify({ 
                             results: similarResults.slice(0, limit).map(r => ({...r, id: r._id})) 
                         }) };
                     }
                 }
                 
                 // Default behavior: return only the exact match
                 return { statusCode: 200, body: JSON.stringify({ results: results.map(r => ({...r, id: r._id})) }) }; 
             }
        }
        
        const filterConditions = [];

        // Board game specific filtering
        if (isBoardGameSearch) {
            // For board games, genres map to categories
            genreList.forEach(cat => {
                // Search across all category fields
                const categoryConditions = [];
                for (let i = 0; i < 10; i++) {
                    categoryConditions.push({ [`category${i}`]: cat });
                }
                if (categoryConditions.length > 0) {
                    filterConditions.push({ $or: categoryConditions });
                }
            });
            
            // Keywords map to mechanics for board games
            keywordList.forEach(mech => {
                const mechanicConditions = [];
                for (let i = 0; i < 10; i++) {
                    mechanicConditions.push({ [`mechanic${i}`]: mech });
                }
                if (mechanicConditions.length > 0) {
                    filterConditions.push({ $or: mechanicConditions });
                }
            });
        } else {
            // Movie/TV filtering (existing logic)
            personList.forEach(p => filterConditions.push({ cast: p }));
            genreList.forEach(g => filterConditions.push({ genres: g }));
            keywordList.forEach(k => filterConditions.push({ "keywords.name": k }));
            
            if (personList.length === 1 || genreList.length === 1 || keywordList.length === 1) {
                 filterConditions.push({ vote_average: { $gt: 7 } });
            }
            
            if (languages.length > 0) filterConditions.push({ original_language: { $in: languages } });

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
                 if (paymentTypes.includes('stream')) paymentClauses.push({ "watch_providers.US.stream": { $exists: true } });
                 if (paymentTypes.includes('rent')) paymentClauses.push({ "watch_providers.US.rent": { $exists: true } });
                 if (paymentTypes.includes('buy')) paymentClauses.push({ "watch_providers.US.buy": { $exists: true } });
                 if (paymentClauses.length > 0) filterConditions.push({ $or: paymentClauses });
            }
        }

        const finalFilter = filterConditions.length > 0 ? { $and: filterConditions } : {};
        
        let searchResults;

        if (query && query.length >= 2) {
             
             // PRIORITY #2: Exact Title Match (Text Search)
             // User request: "Don't do a similar search if you have an exact match."
             let exactMatches = [];
             for(const c of collections) {
                 try {
                     const coll = getCollection(c);
                     let field;
                     if (c.type === 'boardgame') {
                         // Board games use name0 (and it's not lowercased in the DB)
                         field = 'name0';
                     } else if (c.type === 'movie') {
                         field = 'title_lower';
                     } else {
                         field = 'name_lower';
                     }
                     
                     const searchQuery = c.type === 'boardgame' ? query : query.toLowerCase();
                     const exacts = await coll.find({ ...finalFilter, [field]: searchQuery }, { limit: 20 }).toArray();
                     exacts.forEach(e => { e.content_type = c.type; exactMatches.push(e); });
                 } catch(e){
                     console.error(`Error in exact match for ${c.name}:`, e);
                 }
             }
             
             // If we have exact title matches
             if (exactMatches.length > 0) {
                 // Check if showSimilar is enabled
                 if (showSimilar && exactMatches[0].$vector) {
                     console.log("[Search] showSimilar enabled for exact title match, expanding to similar results");
                     
                     // Get vector from first exact match
                     let sourceVector = exactMatches[0].$vector;
                     
                     // Normalize vector format
                     if (!Array.isArray(sourceVector)) {
                         if (sourceVector._vector && Array.isArray(sourceVector._vector)) {
                             sourceVector = sourceVector._vector;
                         } else if (sourceVector.data && Array.isArray(sourceVector.data)) {
                             sourceVector = sourceVector.data;
                         }
                     }
                     
                     if (Array.isArray(sourceVector)) {
                         // Continue to vector search instead of returning exact match only
                         const queryEmbedding = sourceVector;
                         const vectorResults = await queryCollections(db, collections, finalFilter, { sort: { $vector: queryEmbedding }, limit, includeSimilarity: true }, limit);
                         
                         const merged = [...vectorResults.map(r => ({...r, sortScore: r.$similarity || 0}))];
                         const unique = [];
                         const seen = new Set();
                         merged.sort((a,b) => b.sortScore - a.sortScore);
                         for(const r of merged) {
                             if(!seen.has(r._id)) { seen.add(r._id); unique.push({...r, id: r._id}); }
                         }
                         searchResults = unique.slice(0, limit);
                         
                         return { statusCode: 200, body: JSON.stringify({ results: searchResults }) };
                     }
                 }
                 
                 // Default: return ONLY exact matches
                 return { statusCode: 200, body: JSON.stringify({ results: exactMatches.map(r => ({...r, id: r._id})) }) };
             }

             const queryEmbedding = await generateEmbedding(query);
             const vectorResults = await queryCollections(db, collections, finalFilter, { sort: { $vector: queryEmbedding }, limit, includeSimilarity: true }, limit);
             console.log("Did a vector search with embedding for query:", query);

             const merged = [...vectorResults.map(r => ({...r, sortScore: r.$similarity || 0}))];
             const unique = [];
             const seen = new Set();
             merged.sort((a,b) => b.sortScore - a.sortScore);
             for(const r of merged) {
                 if(!seen.has(r._id)) { seen.add(r._id); unique.push({...r, id: r._id}); }
             }
             searchResults = unique.slice(0, limit);
        } else {
             // Logic for FILTERED searches (e.g. Genre="Action", Provider="Netflix")
             
             let effectiveFilter = finalFilter;
             let searchOptions = { limit };

             // Only apply optimizations if we actually have filters
             if (Object.keys(finalFilter).length > 0) {
                 // 1. Always sort filtered results by popularity
                 searchOptions.sort = { popularity: -1 };
             }
             
             searchResults = await queryCollections(db, collections, effectiveFilter, searchOptions, limit);
             
             // Sort appropriately
             if (isBoardGameSearch) {
                 searchResults.sort((a, b) => (b.average || 0) - (a.average || 0));
             } else {
                 searchResults.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
             }
             
             // Trim to limit after sorting
             searchResults = searchResults.slice(0, limit);
        }
        
        const resultsResponse = searchResults.map(r => ({...r, id: r._id}));

        // Cache if this was a bare genre search
        if (genreCacheKey) {
             genreCache[genreCacheKey] = {
                 timestamp: Date.now(),
                 data: resultsResponse
             };
             console.log(`[Cache] Updated genre cache for key: ${genreCacheKey}`);
        }

        return { statusCode: 200, body: JSON.stringify({ results: resultsResponse }) };
      }

      case "details": {
         const itemId = qs.id;
         const itemType = qs.type; // 'boardgame', 'movie', or 'tv'
         if(!itemId) return { statusCode: 400, body: JSON.stringify({ error: "Missing item ID" }) };
         
         const lookupCollections = [
           { name: 'movies2026', type: 'movie' }, 
           { name: 'tvshows2026', type: 'tv' },
           { name: 'bgg_board_games', type: 'boardgame', keyspace: 'boardgames' }
         ];
         
         // If type is specified, look in that collection first
         if (itemType === 'boardgame') {
             try {
                const collection = getCollection({ name: 'bgg_board_games', type: 'boardgame', keyspace: 'boardgames' });
                // Board games use bggid - try both number and string formats
                const numericId = parseInt(itemId, 10);
                console.log(`[Details] Looking up boardgame with bggid: ${numericId} (type: ${typeof numericId})`);
                
                let item = await collection.findOne({ bggid: numericId });
                if (!item) {
                    // Try as string
                    console.log(`[Details] Not found as number, trying as string: "${itemId}"`);
                    item = await collection.findOne({ bggid: itemId.toString() });
                }
                if (!item) {
                    // Try with _id
                    console.log(`[Details] Not found by bggid, trying _id: "${itemId}"`);
                    item = await collection.findOne({ _id: itemId.toString() });
                }
                
                if(item) {
                    console.log(`[Details] Found boardgame:`, item.name0 || item.name);
                    item.content_type = 'boardgame';
                    return { statusCode: 200, body: JSON.stringify({ results: [ { ...item, id: item.bggid || item._id } ] }) };
                }
                console.log(`[Details] Board game not found for id: ${itemId}`);
             } catch (e) {
                 console.warn(`Error finding boardgame ${itemId}:`, e);
             }
             return { statusCode: 404, body: JSON.stringify({ error: "Board game not found" }) };
         }
         
         for(const c of lookupCollections) {
             try {
                const collection = getCollection(c);
                const item = await collection.findOne({ _id: itemId });
                if(item) {
                    item.content_type = c.type;
                    // Always return as { results: [item] } for frontend consistency
                    return { statusCode: 200, body: JSON.stringify({ results: [ { ...item, id: item._id } ] }) };
                }
             } catch (e) {
                 console.warn(`Error finding item ${itemId} in ${c.name}:`, e);
             }
         }
         return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
      }

      case "discover": {
        const discoverStartTime = Date.now();
        const limit = parseInt(qs.limit) || 20;

        const cacheKey = `discover:${contentTypes.sort().join(',')}:${limit}`;
        const now = Date.now();
        const TTL = 60 * 1000; // 1 minute cache for testing
        if (discoverCache[cacheKey] && (now - discoverCache[cacheKey].timestamp < TTL)) {
            console.log(`[Cache] Serving discover results from cache for key: ${cacheKey}`);
            return { statusCode: 200, body: JSON.stringify(discoverCache[cacheKey].data) };
        }

        const minPopularity = collections.length > 1 ? 100 : 75;

        // Date constraint: Last 10 years for movies/TV (YYYY-MM-DD format)
        const tenYearsAgo = new Date();
        tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
        const minDate = tenYearsAgo.toISOString().split('T')[0]; // "YYYY-MM-DD"

        // Year constraint for board games
        const minYear = tenYearsAgo.getFullYear();

        const allResults = [];

        console.log(`[Discover] Starting query for ${collections.length} collections:`, collections.map(c => c.name));
        console.log(`[Discover] Parameters - limit: ${limit}, minPopularity: ${minPopularity}, minDate: ${minDate}, minYear: ${minYear}`);

        for (const collInfo of collections) {
          const startTime = Date.now();
          try {
            const collection = getCollection(collInfo);
            let results;

            console.log(`[Discover] Starting ${collInfo.name} (type: ${collInfo.type}) at ${new Date().toISOString()}`);

            if (collInfo.type === 'boardgame') {
              // For board games: use average (not rating) and filter to avoid timeout
              // Query without sort to avoid exceeding sortable document limit, then sort in memory
              const boardgameFilter = {
                average: { $gt: 7 },
                usersrated: { $gte: 1000 },
                year: { $gte: minYear }  // Last 10 years
              };
              console.log(`[Discover] ${collInfo.name} - Query:`, boardgameFilter, `limit: ${limit * 4} (no sort - will sort in memory)`);
              results = await collection.find(boardgameFilter, { limit: limit * 4 }).toArray();
              console.log(`[Discover] ${collInfo.name} - Query completed in ${Date.now() - startTime}ms, returned ${results.length} results`);

              // Ensure each result has bggid as id
              results = results.map(r => ({ ...r, id: r.bggid || r._id }));

              // Sort in memory by usersrated descending (most popular first)
              results.sort((a, b) => (b.usersrated || 0) - (a.usersrated || 0));
            } else if (collInfo.type === 'tv') {
              // TV shows: Query without sort to avoid timeout (no index on popularity), then sort in memory
              const tvFilter = {
                popularity: { $gte: minPopularity },
                first_air_date: { $gte: minDate }  // Last 10 years
              };
              console.log(`[Discover] ${collInfo.name} - Query:`, tvFilter, `limit: ${limit * 4} (no sort - will sort in memory)`);
              const queryStartTime = Date.now();
              results = await collection.find(tvFilter, { limit: limit * 4 }).toArray();
              const queryDuration = Date.now() - queryStartTime;
              console.log(`[Discover] ${collInfo.name} - Query completed in ${queryDuration}ms, returned ${results.length} results`);

              // Sort in memory by popularity descending
              results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

              if (queryDuration > 5000) {
                console.warn(`[Discover] ${collInfo.name} - SLOW QUERY WARNING: took ${queryDuration}ms`);
              }
            } else {
              // Movies: Use sort in query (has proper index on popularity)
              const movieFilter = {
                popularity: { $gte: minPopularity },
                release_date: { $gte: minDate }  // Last 10 years
              };
              console.log(`[Discover] ${collInfo.name} - Query:`, movieFilter, `sort: { popularity: -1 }, limit: ${limit * 2}`);
              const queryStartTime = Date.now();
              results = await collection.find(movieFilter, { sort: { popularity: -1 }, limit: limit * 2 }).toArray();
              const queryDuration = Date.now() - queryStartTime;
              console.log(`[Discover] ${collInfo.name} - Query completed in ${queryDuration}ms, returned ${results.length} results`);

              if (queryDuration > 5000) {
                console.warn(`[Discover] ${collInfo.name} - SLOW QUERY WARNING: took ${queryDuration}ms`);
              }
            }
            
            results.forEach(item => {
              item.content_type = collInfo.type;
              allResults.push(item);
            });

            const totalTime = Date.now() - startTime;
            console.log(`[Discover] ${collInfo.name} - Total processing time: ${totalTime}ms`);
          } catch (e) {
            const totalTime = Date.now() - startTime;
            console.error(`[Discover] ${collInfo.name} - ERROR after ${totalTime}ms:`, e);
            console.error(`[Discover] ${collInfo.name} - Error message:`, e.message);
            console.error(`[Discover] ${collInfo.name} - Error stack:`, e.stack);
          }
        }

        console.log(`[Discover] All collections queried. Total results before sorting: ${allResults.length}`);
        
        // Sort all results by their respective rating metric (descending)
        allResults.sort((a, b) => {
          const aScore = a.popularity || a.average || 0;
          const bScore = b.popularity || b.average || 0;
          return bScore - aScore;
        });
        
        const responseData = { results: allResults.slice(0, limit).map(r => ({...r, id: r.bggid || r._id})) };

        discoverCache[cacheKey] = {
            timestamp: now,
            data: responseData
        };

        const totalDiscoverTime = Date.now() - discoverStartTime;
        console.log(`[Discover] COMPLETE - Total time: ${totalDiscoverTime}ms, Returned ${responseData.results.length} results`);
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

      case "similar_boardgames": {
        const gameId = qs.id;
        const limit = parseInt(qs.limit) || 6;
        if (!gameId) return { statusCode: 400, body: JSON.stringify({ error: "Missing game ID" }) };

        console.log(`[Similar Boardgames] Searching for similar games to: ${gameId}`);

        const boardgameCollection = { name: 'bgg_board_games', type: 'boardgame', keyspace: 'boardgames' };
        
        try {
          const collection = getCollection(boardgameCollection);
          
          // Try to find the source game by bggid first (like details does), then _id
          const numericId = parseInt(gameId, 10);
          let sourceGame = await collection.findOne({ bggid: numericId }, { projection: { $vector: 1, bggid: 1 } });
          if (!sourceGame) {
            sourceGame = await collection.findOne({ bggid: gameId.toString() }, { projection: { $vector: 1, bggid: 1 } });
          }
          if (!sourceGame) {
            sourceGame = await collection.findOne({ _id: gameId }, { projection: { $vector: 1, bggid: 1 } });
          }
          
          if (!sourceGame || !sourceGame.$vector) {
            console.log("[Similar Boardgames] No vector found, falling back to category match");
            
            // Also try multiple lookup methods for the full game
            let fullGame = await collection.findOne({ bggid: numericId });
            if (!fullGame) fullGame = await collection.findOne({ bggid: gameId.toString() });
            if (!fullGame) fullGame = await collection.findOne({ _id: gameId });
            
            if (!fullGame) {
              return { statusCode: 200, body: JSON.stringify({ results: [] }) };
            }
            
            const categories = [];
            for (let i = 0; i < 10; i++) {
              if (fullGame[`category${i}`]) categories.push(fullGame[`category${i}`]);
            }
            
            if (categories.length === 0) {
              return { statusCode: 200, body: JSON.stringify({ results: [] }) };
            }
            
            const orConditions = categories.map(cat => ({
              [`category0`]: cat
            }));
            
            const similarGames = await collection.find(
              { $or: orConditions },
              { limit: limit + 5 }
            ).toArray();
            
            // Sort in memory by average rating
            similarGames.sort((a, b) => (b.average || 0) - (a.average || 0));
            
            // Exclude source game by bggid
            const sourceBggid = fullGame.bggid;
            const filtered = similarGames.filter(g => g.bggid !== sourceBggid && g._id !== gameId).slice(0, limit);
            return { statusCode: 200, body: JSON.stringify({ 
              results: filtered.map(g => ({ ...g, id: g.bggid || g._id, content_type: 'boardgame' })) 
            }) };
          }
          
          let sourceVector = sourceGame.$vector;
          if (!Array.isArray(sourceVector)) {
            if (sourceVector._vector && Array.isArray(sourceVector._vector)) {
              sourceVector = sourceVector._vector;
            } else if (sourceVector.data && Array.isArray(sourceVector.data)) {
              sourceVector = sourceVector.data;
            }
          }
          
          console.log(`[Similar Boardgames] Using vector search`);
          const similarGames = await collection.find(
            {},
            { sort: { $vector: sourceVector }, limit: limit + 5, includeSimilarity: true }
          ).toArray();
          
          // Exclude source game by bggid
          const sourceBggid = sourceGame.bggid;
          const filtered = similarGames.filter(g => g.bggid !== sourceBggid && g._id !== gameId).slice(0, limit);
          filtered.sort((a, b) => (b.$similarity || 0) - (a.$similarity || 0));
          
          return { statusCode: 200, body: JSON.stringify({ 
            results: filtered.map(g => ({ ...g, id: g.bggid || g._id, content_type: 'boardgame' })) 
          }) };
          
        } catch (e) {
          console.error(`[Similar Boardgames] Error:`, e);
          return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
        }
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid action" }) };
    }
  } catch (err) {
    console.error("Astra DB error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err?.message || String(err) }) };
  }
}
