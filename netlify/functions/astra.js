import { DataAPIClient } from "@datastax/astra-db-ts";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const COLLECTION_NAME = "movies2026";
const EMBEDDING_MODEL = "text-embedding-3-small";  // 1536 dimensions
const EMBEDDING_DIMENSIONS = 1536;

// In-memory cache for autocomplete (not used in current implementation)

console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY);
console.log(process.env.OPENAI_API_KEY)

async function generateEmbedding(text) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text
    })
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    console.error("[Embedding] OpenAI API error:", JSON.stringify(data));
    throw new Error(`OpenAI API error: ${data.error?.message || response.status}`);
  }
  
  if (!data.data || !data.data[0]) {
    console.error("[Embedding] Unexpected response:", JSON.stringify(data));
    throw new Error("No embedding returned from OpenAI");
  }
  
  return data.data[0].embedding;
}

export async function handler(event) {
  const qs = event.queryStringParameters || {};
  const action = qs.action;

  // Astra DB configuration
  const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
  const db = client.db(process.env.ASTRA_DB_API_ENDPOINT);
  const moviesCollection = db.collection(COLLECTION_NAME);

  try {
    switch (action) {
      case "search": {
        // Vector similarity search for movies, or specific provider search
        const query = qs.query || "";
        const limit = parseInt(qs.limit) || 20;

        if (!query || query.length < 2) {
          return {
            statusCode: 200,
            body: JSON.stringify({ results: [] }),
            headers: { "Content-Type": "application/json" }
          };
        }

        // Known streaming providers - if query matches one, search specifically in watch_providers
        const knownProviders = [
          "Netflix", "Amazon Prime Video", "Disney+", "Hulu", "HBO Max", "Apple TV+", 
          "Paramount+", "Peacock", "Crunchyroll", "YouTube", "Tubi", "Pluto TV",
          "Amazon Prime", "Prime Video", "HBO", "Max", "Apple TV", "Paramount"
        ];
        
        const normalizedQuery = query.toLowerCase().trim();
        const isProviderSearch = knownProviders.some(provider => 
          provider.toLowerCase().includes(normalizedQuery) || normalizedQuery.includes(provider.toLowerCase())
        );

        let results;
        if (isProviderSearch) {
          // Search specifically for movies available on this provider
          console.log(`[Search] Provider search for: ${query}`);
          
          // Find the exact provider name that matches
          const matchingProvider = knownProviders.find(provider => 
            provider.toLowerCase().includes(normalizedQuery) || normalizedQuery.includes(provider.toLowerCase())
          );
          
          if (matchingProvider) {
            // Try to match the provider name in the database (case-insensitive)
            const providerFilter = {
              $or: [
                { "watch_providers.US.stream": { $in: [matchingProvider] } },
                { "watch_providers.US.stream": { $in: [matchingProvider.toLowerCase()] } },
                { "watch_providers.US.stream": { $in: [matchingProvider.toUpperCase()] } }
              ]
            };
            
            console.log(`[Search] Provider filter:`, JSON.stringify(providerFilter));
            const searchStart = Date.now();
            results = await moviesCollection.find(providerFilter, { limit }).toArray();
            console.log(`[Search] Provider query took ${Date.now() - searchStart}ms, returned ${results.length} results`);
            
            if (results.length === 0) {
              // Fallback: try searching for any movie that has watch_providers and log what we find
              console.log(`[Search] No results for provider ${matchingProvider}, checking what providers exist...`);
              const sampleMovies = await moviesCollection.find({ "watch_providers": { $exists: true } }, { limit: 5 }).toArray();
              if (sampleMovies.length > 0) {
                console.log(`[Search] Sample watch_providers:`, JSON.stringify(sampleMovies[0].watch_providers));
              }
            }
          } else {
            results = [];
          }
        } else {
          // Generate embedding for the search query
          const queryEmbedding = await generateEmbedding(query);

          // Search using vector similarity
          const searchQuery = { sort: { $vector: queryEmbedding }, limit, includeSimilarity: true };
          console.log(`[Search] Vector search for: ${query}`);
          const searchStart = Date.now();
          results = await moviesCollection.find({}, searchQuery).toArray();
          console.log(`[Search] Vector query took ${Date.now() - searchStart}ms, returned ${results.length} results`);
        }
        

        // Map _id to id for frontend compatibility
        const mappedResults = results.map(movie => ({
          ...movie,
          id: movie._id
        }));

        return {
          statusCode: 200,
          body: JSON.stringify({ results: mappedResults }),
          headers: { "Content-Type": "application/json" }
        };
      }

      case "discover": {
        // For now, just return all movies sorted by popularity
        const limit = parseInt(qs.limit) || 20;

        console.log(`[Discover] Query:`, JSON.stringify({ filter: {}, options: { limit, includeSimilarity: false } }));
        const discoverStart = Date.now();
        const cursor = await moviesCollection.find({}, { 
          limit,
          includeSimilarity: false
        }).toArray();
        console.log(`[Discover] Astra query took ${Date.now() - discoverStart}ms, returned ${cursor.length} results`);

        // Map _id to id for frontend compatibility
        const mappedResults = cursor.map(movie => ({
          ...movie,
          id: movie._id
        }));

        return {
          statusCode: 200,
          body: JSON.stringify({ results: mappedResults }),
          headers: { "Content-Type": "application/json" }
        };
      }

      case "get": {
        // Get a specific movie by ID
        const movieId = qs.id;
        if (!movieId) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing movie ID" }),
            headers: { "Content-Type": "application/json" }
          };
        }

        console.log(`[Get] Query:`, JSON.stringify({ filter: { _id: movieId } }));
        const getStart = Date.now();
        const movie = await moviesCollection.findOne({ _id: movieId });
        console.log(`[Get] Astra query took ${Date.now() - getStart}ms`);

        return {
          statusCode: 200,
          body: JSON.stringify(movie),
          headers: { "Content-Type": "application/json" }
        };
      }

      case "suggestions": {
        // Get autocomplete suggestions for people, genres, keywords
        const query = qs.query || "";
        const type = qs.type; // 'person', 'genre', 'ked'

        let results = [];

        if (!type || type === "person") {
          // Case-sensitive search on 'cast.name' (Astra DB: no $regex)
          const people = await moviesCollection.find(
            { "cast": { $eq: query } },
            { limit: 6, projection: { "cast": 1 } }
          );
          const uniquePeople = new Set();
          people.data.forEach(movie => {
            movie.cast?.forEach(person => {
              if (person.name === query) {
                uniquePeople.add(JSON.stringify({ type: "person", id: person.id, name: person.name }));
              }
            });
          });
          results.push(...Array.from(uniquePeople).map(p => JSON.parse(p)).slice(0, 6));
        }

        if (!type || type === "genre") {
          // Case-sensitive search on 'genres.name' (Astra DB: no $regex)
          const genres = await moviesCollection.find(
            { "genres": { $eq: query } },
            { limit: 6, projection: { "genres": 1 } }
          );
          const uniqueGenres = new Set();
          genres.data.forEach(movie => {
            movie.genres?.forEach(genre => {
              if (genre.name === query) {
                uniqueGenres.add(JSON.stringify({ type: "genre", id: genre.id, name: genre.name }));
              }
            });
          });
          results.push(...Array.from(uniqueGenres).map(g => JSON.parse(g)).slice(0, 6));
        }

        if (!type || type === "keyword") {
          // Case-sensitive search on 'keywords.name' (Astra DB: no $regex)
          const keywords = await moviesCollection.find(
            { "keywords.name": { $eq: query } },
            { limit: 6, projection: { "keywords": 1 } }
          );
          const uniqueKeywords = new Set();
          keywords.data.forEach(movie => {
            movie.keywords?.forEach(keyword => {
              if (keyword.name === query) {
                uniqueKeywords.add(JSON.stringify({ type: "keyword", id: keyword.id, name: keyword.name }));
              }
            });
          });
          results.push(...Array.from(uniqueKeywords).map(k => JSON.parse(k)).slice(0, 6));
        }

        return {
          statusCode: 200,
          body: JSON.stringify({ results }),
          headers: { "Content-Type": "application/json" }
        };
      }

      case "popular": {
        // Get popular movies - simplified for Astra DB compatibility
        const limit = 20;

        // For now, just return first 20 movies without pagination
        // Astra DB has different pagination requirements
        console.log(`[Popular] Query:`, JSON.stringify({ filter: {}, options: { limit } }));
        const popularStart = Date.now();
        const results = await moviesCollection.find(
          {},
          {
            limit
          }
        ).toArray();
        console.log(`[Popular] Astra query took ${Date.now() - popularStart}ms, returned ${results.length} results`);

        console.log(`Found ${results.length} movies`);

        // Map _id to id for frontend compatibility
        const mappedResults = results.map(movie => ({
          ...movie,
          id: movie._id
        }));

        return {
          statusCode: 200,
          body: JSON.stringify({
            results: mappedResults,
            total_pages: 1, // Simplified pagination
            page: 1,
            total_results: results.length
          }),
          headers: { "Content-Type": "application/json" }
        };
      }

      case "genre": {
        // Filter movies by genre
        const genre = qs.genre;
        const limit = 20;

        if (!genre) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing genre parameter" }),
            headers: { "Content-Type": "application/json" }
          };
        }

        // Use normalized searchName for genre search
        // Case-sensitive search on 'genres.name'
        const genreQuery = { "genres": { $in: [genre]} };
        console.log(`[Genre] Query:`, JSON.stringify({ filter: genreQuery, options: { limit } }));
        const genreStart = Date.now();
        const results = await moviesCollection.find(
          genreQuery,
          {
            limit
          }
        ).toArray();
        console.log(`[Genre] Astra query took ${Date.now() - genreStart}ms, returned ${results.length} results`);

        // Map _id to id for frontend compatibility
        const mappedResults = results.map(movie => ({
          ...movie,
          id: movie._id
        }));

        // For now, return results without total count (Astra DB countDocuments requires upperBound)
        return {
          statusCode: 200,
          body: JSON.stringify({
            results: mappedResults,
            total_pages: 1, // Simplified pagination
            page: 1,
            total_results: results.length
          }),
          headers: { "Content-Type": "application/json" }
        };
      }

      case "person": {
        // Filter movies by cast member name
        const name = qs.name;
        const limit = 20;

        if (!name) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing name parameter" }),
            headers: { "Content-Type": "application/json" }
          };
        }

        console.log(`[Person] Searching for cast member: "${name}"`);
        const personStart = Date.now();
        
        // Find movies where cast.name matches exactly
        const filter = { "cast": { $in: [name] } };
        console.log(`[Person] Filter: ${JSON.stringify(filter)}`);
        const results = await moviesCollection.find(
          filter,
          { limit }
        ).toArray();
        console.log(`[Person] Astra query took ${Date.now() - personStart}ms, returned ${results.length} results`);
        

        // Map _id to id for frontend compatibility
        const mappedResults = results.map(movie => ({
          ...movie,
          id: movie._id
        }));

        return {
          statusCode: 200,
          body: JSON.stringify({
            results: mappedResults,
            total_pages: 1,
            page: 1,
            total_results: results.length
          }),
          headers: { "Content-Type": "application/json" }
        };
      }

      case "details": {
        // Get movie details by ID (alias for "get")
        const movieId = qs.id;
        if (!movieId) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing movie ID" }),
            headers: { "Content-Type": "application/json" }
          };
        }

        console.log(`[Details] Query:`, JSON.stringify({ filter: { _id: movieId } }));
        const detailsStart = Date.now();
        const movie = await moviesCollection.findOne({ _id: movieId });
        console.log(`[Details] Astra query took ${Date.now() - detailsStart}ms`);

        if (!movie) {
          return {
            statusCode: 404,
            body: JSON.stringify({ error: "Movie not found" }),
            headers: { "Content-Type": "application/json" }
          };
        }

        return {
          statusCode: 200,
          body: JSON.stringify(movie),
          headers: { "Content-Type": "application/json" }
        };
      }

      case "autocomplete": {
        const query = qs.query || "";
        if (!query || query.length < 2) {
          return {
            statusCode: 200,
            body: JSON.stringify({ results: [] }),
            headers: { "Content-Type": "application/json" }
          };
        }

        const qLower = query.toLowerCase();
        
        try {
            const startTime = Date.now();
            console.log(`[Autocomplete] Starting search for: "${query}"`);
            
            // Load autocomplete data from public/autocomplete.json
            const autocompleteFilePath = path.join(__dirname, '..', 'public', 'autocomplete.json');
            const autocompleteData = JSON.parse(fs.readFileSync(autocompleteFilePath, 'utf8'));
            
            console.log(`[Autocomplete] Loaded ${autocompleteData.length} items from file`);
            
            // Filter items that start with the query
            const items = autocompleteData.filter(item => 
              item.name && item.name.toLowerCase().startsWith(qLower)
            ).slice(0, 100); // Limit to 100
            
            console.log(`[Autocomplete] Filtered to ${items.length} matches`);
            
            const results = [];
            const seen = new Set();
            
            for (const doc of items) {
              // Dedupe by type + name (not movieId) to avoid duplicates like "Tom Hanks" x10
              const key = `${doc.type}:${doc.name}`;
              if (seen.has(key)) continue;
              seen.add(key);

              // Prepare base result object
              let result = {};
              if (doc.type === 'movie') {
                result = {
                  type: 'movie',
                  id: doc.movieId,
                  title: doc.name,
                  searchName: doc.title.lower()
                };
              } else if (doc.type === 'person') {
                result = {
                  type: 'person',
                  id: doc.movieId,
                  name: doc.name,
                  searchName: doc.name.lower()
                };
              } else if (doc.type === 'genre') {
                result = {
                  type: 'genre',
                  id: doc.movieId,
                  name: doc.name,
                  searchName: doc.name.lower()
                };
              }
              // Add icon if present in doc
              if (doc.icon) {
                result.icon = doc.icon;
              }
              results.push(result);
            }
            
            console.log(`[Autocomplete] Found ${results.length} matches in ${Date.now() - startTime}ms`);
            
            // Sort: Starts with query first
            results.sort((a, b) => {
                const nameA = (a.title || a.name).toLowerCase();
                const nameB = (b.title || b.name).toLowerCase();
                
                const aStarts = nameA.startsWith(qLower);
                const bStarts = nameB.startsWith(qLower);
                
                if (aStarts && !bStarts) return -1;
                if (!aStarts && bStarts) return 1;
                
                return nameA.localeCompare(nameB);
            });

            console.log(`[Autocomplete] Complete: ${results.length} matches in ${Date.now() - startTime}ms`);

            return {
              statusCode: 200,
              body: JSON.stringify({ results }),
              headers: { "Content-Type": "application/json" }
            };

        } catch (error) {
            console.error("Autocomplete error:", JSON.stringify(error, null, 2));
            return {
                statusCode: 500,
                body: JSON.stringify({ error: "Search failed", message: error.message }),
                headers: { "Content-Type": "application/json" }
            };
        }
      }

      case "similar": {
        // Find similar movies using vector search
        const movieId = qs.id;
        const limit = parseInt(qs.limit) || 6;

        if (!movieId) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: "Missing movie ID" }),
            headers: { "Content-Type": "application/json" }
          };
        }

        // Get the source movie to generate embedding from its overview
        const sourceMovie = await moviesCollection.findOne({ _id: movieId });

        if (!sourceMovie) {
          return {
            statusCode: 404,
            body: JSON.stringify({ error: "Movie not found" }),
            headers: { "Content-Type": "application/json" }
          };
        }

        // Generate embedding from the movie's overview
        const queryEmbedding = await generateEmbedding(sourceMovie.overview || sourceMovie.title);

        // Find similar movies using vector search
        const similarMovies = await moviesCollection.find(
          {},
          {
            sort: { $vector: queryEmbedding },
            limit: limit + 1, // +1 to exclude the source movie
            includeSimilarity: true
          }
        ).toArray();

        // Filter out the source movie itself
        const results = similarMovies.filter(movie => movie._id !== movieId).slice(0, limit);

        // Map _id to id for frontend compatibility
        const mappedResults = results.map(movie => ({
          ...movie,
          id: movie._id
        }));

        return {
          statusCode: 200,
          body: JSON.stringify({ results: mappedResults }),
          headers: { "Content-Type": "application/json" }
        };
      }

      case "debug": {
        // Debug endpoint to check cast data structure
        console.log("[Debug] Checking movie cast data...");
        const sample = await moviesCollection.findOne({});
        
        if (!sample) {
          return {
            statusCode: 200,
            body: JSON.stringify({ message: "No movies in collection" }),
            headers: { "Content-Type": "application/json" }
          };
        }
        
        // Also try to find a movie with cast
        const withCast = await moviesCollection.findOne({ cast: { $exists: true } });
        
        return {
          statusCode: 200,
          body: JSON.stringify({ 
            sampleTitle: sample.title,
            sampleId: sample._id,
            hasCast: !!sample.cast,
            castType: typeof sample.cast,
            castLength: Array.isArray(sample.cast) ? sample.cast.length : 0,
            firstCastMember: Array.isArray(sample.cast) && sample.cast.length > 0 ? sample.cast[0] : null,
            withCastTitle: withCast?.title,
            withCastFirstMember: withCast?.cast?.[0]
          }, null, 2),
          headers: { "Content-Type": "application/json" }
        };
      }

      default:
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "Invalid action. Use: search, popular, genre, details, autocomplete, discover, get, suggestions, or similar" }),
          headers: { "Content-Type": "application/json" }
        };
    }
  } catch (err) {
    console.error("Astra DB error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err?.message || String(err) }),
      headers: { "Content-Type": "application/json" }
    };
  }
}
