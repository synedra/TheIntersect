import { DataAPIClient } from "@datastax/astra-db-ts";
import fetch from "node-fetch";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const COLLECTION_NAME = "moviesnew";
const EMBEDDING_MODEL = "text-embedding-3-small";  // 1536 dimensions
const EMBEDDING_DIMENSIONS = 1536;

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
        // Vector similarity search for movies
        const query = qs.query || "";
        const limit = parseInt(qs.limit) || 20;

        if (!query || query.length < 2) {
          return {
            statusCode: 200,
            body: JSON.stringify({ results: [] }),
            headers: { "Content-Type": "application/json" }
          };
        }

        // Generate embedding for the search query
        const queryEmbedding = await generateEmbedding(query);

        // Search using vector similarity
        const results = await moviesCollection.find(
          {},
          {
            sort: { $vector: queryEmbedding },
            limit,
            includeSimilarity: true
          }
        ).toArray();

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

        const cursor = await moviesCollection.find({}, { 
          limit,
          includeSimilarity: false
        }).toArray();

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

        const movie = await moviesCollection.findOne({ _id: movieId });

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
          const people = await moviesCollection.find(
            { "cast.name": { $regex: query, $options: "i" } },
            { limit: 6, projection: { "cast": 1 } }
          );
          
          const uniquePeople = new Set();
          people.data.forEach(movie => {
            movie.cast?.forEach(person => {
              if (person.name.toLowerCase().includes(query.toLowerCase())) {
                uniquePeople.add(JSON.stringify({ type: "person", id: person.id, name: person.name }));
              }
            });
          });
          results.push(...Array.from(uniquePeople).map(p => JSON.parse(p)).slice(0, 6));
        }

        if (!type || type === "genre") {
          const genres = await moviesCollection.find(
            { "genres.name": { $regex: query, $options: "i" } },
            { limit: 6, projection: { "genres": 1 } }
          );
          
          const uniqueGenres = new Set();
          genres.data.forEach(movie => {
            movie.genres?.forEach(genre => {
              if (genre.name.toLowerCase().includes(query.toLowerCase())) {
                uniqueGenres.add(JSON.stringify({ type: "genre", id: genre.id, name: genre.name }));
              }
            });
          });
          results.push(...Array.from(uniqueGenres).map(g => JSON.parse(g)).slice(0, 6));
        }

        if (!type || type === "keyword") {
          const keywords = await moviesCollection.find(
            { "keywords.name": { $regex: query, $options: "i" } },
            { limit: 6, projection: { "keywords": 1 } }
          );
          
          const uniqueKeywords = new Set();
          keywords.data.forEach(movie => {
            movie.keywords?.forEach(keyword => {
              if (keyword.name.toLowerCase().includes(query.toLowerCase())) {
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
        const results = await moviesCollection.find(
          {},
          {
            limit
          }
        ).toArray();

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

        const results = await moviesCollection.find(
          { "genres.name": { $regex: genre, $options: "i" } },
          {
            limit
          }
        ).toArray();

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

        const movie = await moviesCollection.findOne({ _id: movieId });

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
        // Get movie autocomplete suggestions (alias for "suggestions" but for movies only)
        const query = qs.query || "";
        const limit = parseInt(qs.limit) || 5;

        if (!query || query.length < 2) {
          return {
            statusCode: 200,
            body: JSON.stringify({ results: [] }),
            headers: { "Content-Type": "application/json" }
          };
        }

        const results = await moviesCollection.find(
          {
            $or: [
              { title: { $regex: query, $options: "i" } },
              { "cast.name": { $regex: query, $options: "i" } }
            ]
          },
          {
            limit,
            projection: {
              _id: 1,
              title: 1,
              poster_path: 1,
              release_date: 1,
              vote_average: 1
            }
          }
        ).toArray();

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
