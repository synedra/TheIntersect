# Daily Data Refresh

## Source-of-truth update scripts

- Movies + TV incremental updates: [bin/update_astra_movies.py](bin/update_astra_movies.py)
  - Uses TMDB `/{media_type}/changes` API by date.
  - Writes checkpoints in Astra `maintenance_metadata`:
    - `status_movie.last_date`
    - `status_tv.last_date`

- Movies bulk by date (backfill): [bin/populate_astra_by_date.py](bin/populate_astra_by_date.py)
- TV bulk by date (backfill): [bin/populate_astra_tv_by_date.py](bin/populate_astra_tv_by_date.py)

- Boardgames:
  - This repo currently has boardgame maintenance/search scripts, but no built-in daily ingestion script equivalent to TMDB incremental sync.
  - Optional boardgame updater can be injected through `BOARDGAME_UPDATE_COMMAND`.

- Autocomplete metadata refresh: [bin/build_autocomplete_metadata_buckets.js](bin/build_autocomplete_metadata_buckets.js)

## How to check latest update state

Run:

- `npm run data:freshness`

This reads `maintenance_metadata` docs:

- `status_movie`
- `status_tv`
- `status_boardgame`
- `status_daily_refresh`

## Daily task (GitHub Actions)

Workflow: [.github/workflows/daily-data-refresh.yml](.github/workflows/daily-data-refresh.yml)

Schedule:

- Daily at `06:15 UTC`

Runs:

1. `bin/update_astra_movies.py` (movies + TV incremental)
2. optional boardgame command from `BOARDGAME_UPDATE_COMMAND`
3. `bin/build_autocomplete_metadata_buckets.js`
4. writes refresh status/checkpoints

## Required repository secrets

- `ASTRA_DB_API_ENDPOINT`
- `ASTRA_DB_APPLICATION_TOKEN`
- `ASTRA_DB_KEYSPACE`
- `ASTRA_BOARDGAME_KEYSPACE` (if used)
- `OPENAI_API_KEY`
- `TMDB_READ_TOKEN`
- `BOARDGAME_UPDATE_COMMAND` (optional)
