import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { DataAPIClient } from "@datastax/astra-db-ts";

dotenv.config({ override: true });

const ASTRA_ENDPOINT = process.env.ASTRA_DB_API_ENDPOINT;
const ASTRA_TOKEN = process.env.ASTRA_DB_APPLICATION_TOKEN;
const BOARDGAME_KEYSPACE = process.env.ASTRA_BOARDGAME_KEYSPACE || "boardgames";

const ROOT = process.cwd();
const OUTPUT_PATH = path.join(ROOT, "public", "autocomplete-new.json");

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return normalizeText(item);
        if (item && typeof item === "object") {
          return normalizeText(item.name || item.title || item.english_name || "");
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((s) => normalizeText(s)).filter(Boolean);
  }
  return [];
}

function addEntry(store, entry) {
  const name = normalizeText(entry?.name);
  const type = normalizeText(entry?.type).toLowerCase();
  if (!name || !type) return;

  const id = entry?.id != null ? String(entry.id) : "";
  const key = `${type}:${id}:${name.toLowerCase()}`;
  if (store.has(key)) return;

  const out = { name, type };
  if (id) out.id = id;
  store.set(key, out);
}

async function collectMovieOrTvAutocomplete(collection, type, store) {
  let scanned = 0;
  for await (const doc of collection.find({}, { projection: { $vector: 0 } })) {
    scanned += 1;

    const title = normalizeText(doc.title || doc.name || doc.original_title || doc.original_name || "");
    const id = doc.id || doc._id;
    if (title && id) {
      addEntry(store, { type, name: title, id: String(id) });
    }

    const cast = Array.isArray(doc.cast_details) ? doc.cast_details : [];
    for (const person of cast) {
      const personName = normalizeText(person?.name || "");
      if (personName) addEntry(store, { type: "person", name: personName });
    }

    for (const genre of normalizeList(doc.genres)) {
      addEntry(store, { type: "genre", name: genre });
    }

    if (scanned % 10000 === 0) {
      console.log(`[${type}] scanned ${scanned} docs...`);
    }
  }

  console.log(`[${type}] finished, scanned ${scanned} docs.`);
}

async function collectBoardgameAutocomplete(collection, store) {
  let scanned = 0;
  for await (const doc of collection.find({}, { projection: { $vector: 0 } })) {
    scanned += 1;

    const title = normalizeText(doc.name || doc.name0 || doc.title || "");
    const id = doc.bggid || doc.id || doc._id;
    if (title && id) {
      addEntry(store, { type: "boardgame", name: title, id: String(id) });
    }

    if (scanned % 10000 === 0) {
      console.log(`[boardgame] scanned ${scanned} docs...`);
    }
  }

  console.log(`[boardgame] finished, scanned ${scanned} docs.`);
}

async function main() {
  if (!ASTRA_ENDPOINT || !ASTRA_TOKEN) {
    throw new Error("Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN");
  }

  const client = new DataAPIClient(ASTRA_TOKEN);
  const db = client.db(ASTRA_ENDPOINT);
  const boardgameDb = client.db(ASTRA_ENDPOINT, { keyspace: BOARDGAME_KEYSPACE });

  const movies = db.collection("movies2026");
  const tv = db.collection("tvshows2026");
  const boardgames = boardgameDb.collection("bgg_board_games");

  const store = new Map();

  console.log("Generating autocomplete-new.json from Astra collections...");
  await collectMovieOrTvAutocomplete(movies, "movie", store);
  await collectMovieOrTvAutocomplete(tv, "tv", store);
  await collectBoardgameAutocomplete(boardgames, store);

  const entries = Array.from(store.values());
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.name.localeCompare(b.name);
  });

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(entries));

  const byType = entries.reduce((acc, row) => {
    acc[row.type] = (acc[row.type] || 0) + 1;
    return acc;
  }, {});

  console.log(`Wrote ${entries.length} entries to ${OUTPUT_PATH}`);
  console.log("Breakdown:", byType);
}

main().catch((err) => {
  console.error("Failed to generate autocomplete-new.json", err);
  process.exit(1);
});
