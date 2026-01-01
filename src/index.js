import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 5174);
const TMDB_READ_TOKEN = process.env.TMDB_READ_TOKEN || "";
const DEFAULT_REGION = process.env.DEFAULT_REGION || "US";
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 300);

if (!TMDB_READ_TOKEN) {
  console.warn("[server] Missing TMDB_READ_TOKEN. Copy .env.example to .env and set TMDB_READ_TOKEN (TMDB v4 read access token).");
}

const TMDB_BASE = "https://api.themoviedb.org/3";

const cache = new Map(); // key -> {expires:number, data:any}
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.expires) {
    cache.delete(key);
    return null;
  }
  return v.data;
}
function cacheSet(key, data, ttlSeconds = CACHE_TTL_SECONDS) {
  cache.set(key, { data, expires: Date.now() + ttlSeconds * 1000 });
}

async function tmdbGet(path, query) {
  if (!TMDB_READ_TOKEN) {
    const err = new Error("TMDB_READ_TOKEN is not set on the server (.env).");
    err.status = 500;
    throw err;
  }

  const url = new URL(TMDB_BASE + path);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      url.searchParams.set(k, String(v));
    });
  }

  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${TMDB_READ_TOKEN}`,
        "Content-Type": "application/json;charset=utf-8",
      },
    });
  } catch (e) {
    const err = new Error(`Network error calling TMDB: ${e?.message || e}`);
    err.status = 502;
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`TMDB ${res.status} ${res.statusText}: ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  cacheSet(cacheKey, data);
  return data;
}

// Health + config hints (never returns the token)
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/api/_debug/config", (req, res) =>
  res.json({
    ok: true,
    tmdbTokenPresent: Boolean(TMDB_READ_TOKEN),
    defaultRegion: DEFAULT_REGION,
    cacheTtlSeconds: CACHE_TTL_SECONDS,
  })
);

// Routes
app.get("/api/search/person", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const page = Number(req.query.page || 1);
    if (!q) return res.status(400).json({ error: "Missing q" });
    const data = await tmdbGet("/search/person", { query: q, page });
    res.json(data);
  } catch (e) { next(e); }
});

app.get("/api/genre/movie/list", async (req, res, next) => {
  try {
    const data = await tmdbGet("/genre/movie/list", {});
    res.json(data);
  } catch (e) { next(e); }
});

app.get("/api/discover/movie", async (req, res, next) => {
  try {
    const with_people = String(req.query.with_people || "");
    const with_genres = String(req.query.with_genres || "");
    const page = Number(req.query.page || 1);

    const data = await tmdbGet("/discover/movie", {
      page,
      with_people,
      with_genres,
      include_adult: false,
      sort_by: "popularity.desc",
      region: DEFAULT_REGION,
    });
    res.json(data);
  } catch (e) { next(e); }
});

app.get("/api/movie/:id/details", async (req, res, next) => {
  try {
    const id = req.params.id;
    const [details, credits] = await Promise.all([
      tmdbGet(`/movie/${id}`, {}),
      tmdbGet(`/movie/${id}/credits`, {}),
    ]);
    res.json({ details, credits });
  } catch (e) { next(e); }
});

app.get("/api/movie/:id/watch/providers", async (req, res, next) => {
  try {
    const id = req.params.id;
    const data = await tmdbGet(`/movie/${id}/watch/providers`, {});
    res.json(data);
  } catch (e) { next(e); }
});

// Error handler (logs to server console and returns JSON to client)
app.use((err, req, res, next) => {
  const status = Number(err?.status || 500);
  console.error("[server] error:", {
    status,
    path: req.path,
    message: err?.message,
  });
  res.status(status).json({
    error: err?.message || "Internal Server Error",
    status,
    path: req.path,
  });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
