# Astra DB Integration

This version uses DataStax Astra DB (a vector database) instead of directly calling the TMDB API.

## Files Created

- **netlify/functions/astra.js** - Netlify function that queries Astra DB
- **main_astra.js** - Frontend JavaScript for Astra DB version
- **index_astra.html** - HTML page for Astra DB version

## Setup

1. **Create an Astra DB database** at https://astra.datastax.com/
2. **Create a collection** named `movie_data` in the `movies` keyspace
3. **Get your credentials**:
   - Database ID
   - Region
   - Application Token

4. **Update `.env` file** with your Astra credentials:
   ```
   ASTRA_DB_ID=your_database_id
   ASTRA_DB_REGION=your_region
   ASTRA_DB_APPLICATION_TOKEN=your_token
   ASTRA_DB_KEYSPACE=movies
   ```

5. **Load movie data** into Astra DB with this structure:
   ```json
   {
     "tmdb_id": 550,
     "title": "Fight Club",
     "overview": "...",
     "poster_path": "/...",
     "release_date": "1999-10-15",
     "runtime": 139,
     "vote_average": 8.4,
     "popularity": 45.3,
     "genres": [
       {"id": 18, "name": "Drama"}
     ],
     "cast": [
       {"id": 287, "name": "Brad Pitt"}
     ],
     "keywords": [
       {"id": 825, "name": "support group"}
     ]
   }
   ```

## API Endpoints

The `astra.js` function supports these actions:

- **search** - Full-text search across titles, overviews, genres, cast, keywords
- **discover** - Filter by genres, cast, keywords (AND logic)
- **get** - Get a specific movie by TMDB ID
- **suggestions** - Autocomplete for people, genres, keywords

## Usage

Access the Astra version at: http://localhost:8888/index_astra.html

The original TMDB version remains at: http://localhost:8888/
