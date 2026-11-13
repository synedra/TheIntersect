import dotenv from "dotenv";
import { DataAPIClient } from "@datastax/astra-db-ts";
import fs from "fs";
import path from "path";

dotenv.config({ override: true });

const ASTRA_ENDPOINT = process.env.ASTRA_DB_API_ENDPOINT;
const ASTRA_TOKEN = process.env.ASTRA_DB_APPLICATION_TOKEN;

const MIN_PREFIX = 2;
const MAX_PREFIX = 8;
const MAX_ITEMS_PER_BUCKET = 80;
const BUCKET_SOFT_LIMIT = MAX_ITEMS_PER_BUCKET * 3;

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSearchName(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function scoreMedia(doc) {
  const popularity = toNum(doc.popularity, 0);
  const typeBase = doc.type === "person" ? 8 : (doc.type === "genre" ? 5 : 10);
  return typeBase + popularity;
}

function scoreBoardgame(doc) {
  const rank = toNum(doc.rank ?? doc.boardgamerank, 999999);
  const usersRated = toNum(doc.usersrated, 0);
  const rating = toNum(doc.rating ?? doc.average, 0);
  const rankBonus = rank > 0 ? (100000 / rank) : 0;
  return rankBonus + (rating * 10) + Math.log10(Math.max(1, usersRated));
}

function addToBucket(bucketMap, scope, prefix, item) {
  const key = `${scope}:${prefix}`;
  let bucket = bucketMap.get(key);
  if (!bucket) {
    bucket = new Map();
    bucketMap.set(key, bucket);
  }

  const itemKey = `${item.type}:${String(item.id || "").toLowerCase()}:${item.name.toLowerCase()}`;
  const existing = bucket.get(itemKey);
  if (!existing || Number(item.score || 0) > Number(existing.score || 0)) {
    bucket.set(itemKey, item);

    if (bucket.size > BUCKET_SOFT_LIMIT) {
      let worstKey = null;
      let worstScore = Number.POSITIVE_INFINITY;
      for (const [k, v] of bucket.entries()) {
        const s = Number(v?.score || 0);
        if (s < worstScore) {
          worstScore = s;
          worstKey = k;
        }
      }
      if (worstKey) bucket.delete(worstKey);
    }
  }
}

function addEntryPrefixes(bucketMap, scopes, entry) {
  const searchName = normalizeSearchName(entry.name);
  if (searchName.length < MIN_PREFIX) return;

  const max = Math.min(MAX_PREFIX, searchName.length);
  for (let i = MIN_PREFIX; i <= max; i += 1) {
    const prefix = searchName.slice(0, i);
    for (const scope of scopes) {
      addToBucket(bucketMap, scope, prefix, entry);
    }
  }
}

function loadJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

function pickExistingPath(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function collectMediaFromFile(mediaEntries, bucketMap) {
  let scanned = 0;
  for (const raw of mediaEntries) {
    scanned += 1;
    const name = normalizeText(raw?.name || raw?.title || "");
    const id = String(raw?.id || raw?.movieId || "");
    const type = normalizeText(raw?.type || "movie").toLowerCase() || "movie";
    if (!name) continue;
    if (type !== "movie" && type !== "tv") continue;

    const entry = {
      type,
      id,
      name,
      score: scoreMedia(raw),
      popularity: toNum(raw?.popularity, 0)
    };

    const mediaScopes = type === 'tv'
      ? ["tvshows", "media", "all"]
      : ["movies", "media", "all"];

    addEntryPrefixes(bucketMap, mediaScopes, entry);

    if (scanned % 100000 === 0) {
      console.log(`[media-file] scanned ${scanned} entries...`);
    }
  }
  console.log(`[media-file] scanned total ${scanned}`);
}

function collectBoardgamesFromFile(boardgameEntries, bucketMap) {
  let scanned = 0;
  for (const raw of boardgameEntries) {
    scanned += 1;
    const name = normalizeText(raw?.name || raw?.title || raw?.name0 || "");
    const id = String(raw?.id || raw?.bggid || raw?._id || "");
    if (!name || !id) continue;

    const rank = toNum(raw?.rank ?? raw?.boardgamerank, 999999);
    const entry = {
      type: "boardgame",
      id,
      name,
      score: scoreBoardgame(raw),
      boardgamerank: Number.isFinite(rank) ? rank : undefined,
      popularity: toNum(raw?.popularity, 0)
    };

    addEntryPrefixes(bucketMap, ["boardgames", "all"], entry);

    if (scanned % 100000 === 0) {
      console.log(`[boardgames-file] scanned ${scanned} entries...`);
    }
  }
  console.log(`[boardgames-file] scanned total ${scanned}`);
}

async function writeBuckets(metadataCollection, bucketMap) {
  const updates = [];

  for (const [key, bucket] of bucketMap.entries()) {
    const [scope, prefix] = key.split(":");
    const items = Array.from(bucket.values())
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, MAX_ITEMS_PER_BUCKET)
      .map((item) => ({
        type: item.type,
        id: item.id,
        name: item.name,
        score: item.score,
        popularity: item.popularity,
        boardgamerank: item.boardgamerank
      }));

    updates.push({
      filter: { _id: `autocomplete_bucket:${scope}:${prefix}` },
      update: {
        $set: {
          kind: "autocomplete_bucket",
          scope,
          prefix,
          items,
          updatedAt: new Date().toISOString()
        }
      }
    });
  }

  console.log(`Prepared ${updates.length} bucket upserts`);

  // Execute in chunks to avoid oversized requests.
  const chunkSize = 250;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(chunk.map((u) => metadataCollection.updateOne(u.filter, u.update, { upsert: true })));
    console.log(`Upserted ${Math.min(i + chunkSize, updates.length)} / ${updates.length}`);
  }
}

async function main() {
  if (!ASTRA_ENDPOINT || !ASTRA_TOKEN) {
    throw new Error("Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN");
  }

  const root = process.cwd();
  const mediaDatabaseUploadPath = pickExistingPath([
    path.join(root, "public", "database_upload.json")
  ]);
  const mediaPrimaryPath = pickExistingPath([
    path.join(root, "public", "autocomplete.json"),
    path.join(root, "public", "safe", "autocomplete-fresh.json")
  ]);
  const mediaSecondaryPath = pickExistingPath([
    path.join(root, "public", "autocomplete-tv-fresh.json")
  ]);
  const boardgamesPath = path.join(root, "public", "autocomplete-boardgames.json");

  if (!mediaDatabaseUploadPath && !mediaPrimaryPath && !mediaSecondaryPath) {
    throw new Error("Missing media autocomplete source files (expected public/autocomplete.json or public/safe/autocomplete-fresh.json and/or public/autocomplete-tv-fresh.json)");
  }
  if (!fs.existsSync(boardgamesPath)) {
    throw new Error(`Missing file: ${boardgamesPath}`);
  }

  const mediaEntries = [];
  if (mediaDatabaseUploadPath) {
    const data = loadJson(mediaDatabaseUploadPath);
    const rows = Array.isArray(data)
      ? data
      : [
          ...(Array.isArray(data?.entries) ? data.entries : []),
          ...(Array.isArray(data?.movies2026) ? data.movies2026 : []),
          ...(Array.isArray(data?.tvshows2026) ? data.tvshows2026 : [])
        ];
    for (const row of rows) mediaEntries.push(row);
  } else if (mediaPrimaryPath) {
    const data = loadJson(mediaPrimaryPath);
    const rows = Array.isArray(data) ? data : (data.entries || []);
    for (const row of rows) mediaEntries.push(row);
  }
  if (!mediaDatabaseUploadPath && mediaSecondaryPath) {
    const data = loadJson(mediaSecondaryPath);
    const rows = Array.isArray(data) ? data : (data.entries || []);
    for (const row of rows) mediaEntries.push(row);
  }
  const boardgameEntries = loadJson(boardgamesPath);

  const client = new DataAPIClient(ASTRA_TOKEN);
  const db = client.db(ASTRA_ENDPOINT);
  const metadata = db.collection("maintenance_metadata");

  const bucketMap = new Map();

  console.log("Building autocomplete prefix buckets from local autocomplete files...");
  collectMediaFromFile(mediaEntries, bucketMap);
  collectBoardgamesFromFile(Array.isArray(boardgameEntries) ? boardgameEntries : (boardgameEntries.entries || []), bucketMap);

  await writeBuckets(metadata, bucketMap);
  console.log("Done. Buckets stored in maintenance_metadata.");
}

main().catch((e) => {
  console.error("Failed building metadata autocomplete buckets:", e);
  process.exit(1);
});
