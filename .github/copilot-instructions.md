# Copilot instructions for TheIntersect

## Big picture architecture
- This is a Netlify-first app: browser UI calls Netlify Functions; functions query Astra DB and external APIs.
- Frontend is mostly monolithic vanilla JS + HTML:
  - `index.html` contains UI structure + most styling.
  - `public/main.js` contains app state, filter chips, auth flow, and API calls.
- Backend service boundary is `netlify/functions/*`:
  - `astra.js` is the primary data/search API (`action` query param router).
  - `tmdb_auth.js` handles TMDB token/session/account flow.
  - `user_data.js` stores ratings/lists in a separate Astra DB (different env vars).
  - `chat.js` does multi-source retrieval + OpenAI answer generation.

## Data model and collection conventions
- Movies/TV collections: `movies2026`, `tvshows2026` in default Astra keyspace.
- Board games: `bgg_board_games` in keyspace `boardgames` (see `getCollection` logic in `astra.js`).
- Search responses usually normalize Astra `_id` to response `id` before returning.
- Vector fields are named `$vector`; most API responses exclude it via projection.

## Search behavior you must preserve
- `astra.js?action=search` has priority logic: exact selected IDs -> exact title/name -> vector/filtered retrieval.
- Filter chips are ANDed; list-like filters are deduped and normalized.
- Genre/discover queries use in-memory cache (TTL behavior is intentional).
- `action=autocomplete` uses layered fallbacks: `autocomplete_entries` -> `autocomplete_buckets` -> scan fallback.

## Developer workflows (actual project usage)
- Install/build:
  - `npm install`
  - `npm run build`
- Local dev:
  - `netlify dev` (primary; serves frontend + functions on port 8888)
  - `npm run dev` (Vite-only frontend, no serverless API behavior)
- Targeted diagnostics/scripts:
  - `npm run test:tmdb-auth`
  - `node bin/test_boardgame_search_filter.js`
  - `node bin/test_search.js`
  - `python3 -m py_compile bin/<script>.py` for Python script syntax checks

## Project-specific coding patterns
- Keep Netlify function handlers action-based (single endpoint, many `action` modes) rather than creating many tiny endpoints.
- Prefer extending existing parameter parsing/normalization helpers in `astra.js` instead of adding ad-hoc parsing.
- Preserve multi-content support through `content_types` (`movies,tvshows,boardgames`) when adding search features.
- Maintain boardgame keyspace separation and user-data DB separation (do not reuse movie DB credentials for user profiles).
- In frontend, wire new API behavior through existing fetch/update flows in `public/main.js` (avoid introducing new frameworks/state libs).

## Integration points and env notes
- Core integrations: Astra Data API (`@datastax/astra-db-ts`), OpenAI embeddings/chat, TMDB APIs, BoardGameGeek data pipeline.
- Data builders and one-off maintenance scripts live in `bin/` (Python + Node mixed).
- New book ingestion script exists at `bin/build_hardcover_books_astra.py`; it writes to `books2026` and resume metadata collection.
- `.env.example` is informative but not fully strict; verify env variable names in the function/script you are changing before assuming defaults.
