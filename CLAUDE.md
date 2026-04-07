# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**The Intersect** — a vector-powered movie, TV show, and board game discovery app. Users can layer multiple filters (genre, cast, streaming provider, language) with AND logic, and perform semantic "vibe" searches using OpenAI vector embeddings stored in DataStax Astra DB. Live at https://theintersect.netlify.app

## Commands

```bash
npm install              # Install dependencies
npm run dev              # Vite dev server (localhost:5173, frontend only)
netlify dev              # Full local dev with serverless functions (localhost:8888)
npm run build            # Production build to /dist
netlify deploy --prod    # Deploy to Netlify production
node bin/setup_data.js   # Initialize Astra DB with pre-processed movie data
```

`netlify dev` is the primary development command — it runs both the Vite frontend and Netlify Functions backend together.

## Tech Stack

- **Frontend**: Vanilla JavaScript + Vite (no framework). Single-page app.
- **Backend**: Netlify Functions (Node.js, ES modules)
- **Database**: DataStax Astra DB (serverless vector database)
- **Embeddings**: OpenAI `text-embedding-3-small` (1536-dim vectors)
- **Data Source**: TMDB API (v4 Read Token) for movie/TV metadata
- **Chatbot**: Flowise embed for conversational search
- **Auth**: Auth0 SPA SDK + TMDB session authentication

## Architecture

### Frontend (2 key files)

- **`index.html`** (~1700 lines) — All HTML and CSS live here. Contains sidebar with search/filters, main content grid, modals (movie details, language selection, settings), and Flowise chatbot embed. Three content tabs: Movies | TV Shows | Board Games.
- **`public/main.js`** (~1634 lines) — All frontend logic: search/filter chip management, API calls to Netlify functions, modal controls, TMDB auth flow, autocomplete from `public/autocomplete.json`, mobile sidebar toggle.

### Backend (Netlify Functions)

- **`netlify/functions/astra.js`** (~913 lines) — **Primary API handler**. Routes all search/discovery operations through a single function with an `action` parameter. Supports content types: movies (`movies2026` collection), TV shows (`tvshows2026`), board games (`bgg_board_games` in separate keyspace). Implements in-memory caching for genre and discover queries (1-hour TTL).
- **`netlify/functions/tmdb_auth.js`** — TMDB authentication flow (request_token, create_session, get_account, logout). Handles watchlist and ratings.
- **`netlify/functions/api.js`** — Simple TMDB API proxy that injects the API key.

### Search Priority System (in astra.js)

Searches resolve in this order:
1. **Exact movie ID match** — User selected a specific autocomplete result
2. **Exact title match** — Searches `title_lower` / `name_lower` fields
3. **Semantic vector search** — OpenAI embedding similarity via Astra DB
4. **Filtered browsing** — Genre/cast/keyword/provider filters, sorted by popularity

### Data Pipeline (`scripts/` and `bin/`)

Python and JS scripts for populating Astra DB from TMDB, generating autocomplete indexes, crawling Board Game Geek data, and data cleanup. Not part of the runtime application.

### Database Collections (Astra DB)

- `movies2026` — Movie records with metadata + `$vector` embeddings
- `tvshows2026` — TV show records with metadata + `$vector` embeddings
- `bgg_board_games` — Board game records (separate keyspace) with categories, mechanics, ratings + `$vector` embeddings

## Environment Variables

Required in `.env` (see `.env.example`):
- `ASTRA_DB_API_ENDPOINT`, `ASTRA_DB_APPLICATION_TOKEN`, `ASTRA_DB_KEYSPACE` — Astra DB connection
- `OPENAI_API_KEY` — For generating search embeddings
- `TMDB_READ_TOKEN` — TMDB v4 API access
- `TMDB_API_KEY` — TMDB v3 API access

## Key Patterns

- The frontend calls backend functions via `/.netlify/functions/astra?action=<action>&...` query parameters
- All filter chips use AND logic — every active filter must match
- Board games use a separate Astra DB keyspace from movies/TV
- The `public/autocomplete.json` file powers search suggestions and is loaded once at startup
- Settings are persisted in `localStorage` (key: `appSettings`)
