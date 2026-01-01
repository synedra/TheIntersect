# Movie Key App (Vite + React) — TMDB-powered intersecting search

This repo recreates the "search keys" + results + details workflow:
- Ordered search keys ("chips") on the left
- Results grid on the right
- Details panel with blue links (genres/cast) that **add a key** and **re-run** search
- Always-AND intersection via TMDB `/discover`
- "Where to watch" via TMDB watch providers endpoint

## Prereqs
- Node.js 18+ recommended
- A TMDB API Read Access Token (v4). This app uses the v4 **Read Access Token**.

## Setup

### 1) Server (proxy)
```bash
cd server
cp .env.example .env
# edit .env to add TMDB_READ_TOKEN
npm install
npm run dev
```

Server runs at http://localhost:5174

### 2) Client
```bash
cd ../client
npm install
npm run dev
```

Client runs at http://localhost:5173

✅ The client uses Vite's dev proxy: requests to `/api/*` are forwarded to the server on `:5174`.
So you don't need any client .env file for local dev.

## If you see "Could not connect to the server"
That means the client is running but the proxy server is not. Make sure the server is started and is listening on :5174.
# TheIntersect
