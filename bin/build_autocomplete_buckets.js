import dotenv from "dotenv";
import { DataAPIClient } from "@datastax/astra-db-ts";

dotenv.config({ override: true });

const ASTRA_ENDPOINT = process.env.ASTRA_DB_API_ENDPOINT;
const ASTRA_TOKEN = process.env.ASTRA_DB_APPLICATION_TOKEN;
const BOARDGAME_KEYSPACE = process.env.ASTRA_BOARDGAME_KEYSPACE || "boardgames";

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

function toScore(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildDoc({ type, scope, id, name, score, source, boardgamerank, popularity }) {
  const searchName = normalizeSearchName(name);
  if (!searchName || searchName.length < 2) return null;

  const safeId = id != null ? String(id) : "";
  const docId = `${scope}:${type}:${safeId || "_"}:${searchName}`;
  return {
    _id: docId,
    scope,
    type,
    id: safeId || undefined,
    name,
    searchName,
    score,
    source,
    ...(Number.isFinite(Number(popularity)) ? { popularity: Number(popularity) } : {}),
    ...(boardgamerank ? { boardgamerank } : {}),
    updatedAt: new Date().toISOString()
  };
}

async function flushBatch(collection, batch) {
  if (!batch.length) return;
  await collection.insertMany(batch, { ordered: false });
  batch.length = 0;
}

async function collectMediaEntries(collection, mediaType, entriesCollection, state) {
  const { batch, seenPersons, seenGenres } = state;
  let scanned = 0;
  for await (const doc of collection.find({}, { projection: { $vector: 0 } })) {
    scanned += 1;

    const title = normalizeText(doc.title || doc.name || doc.original_title || doc.original_name || "");
    const id = doc.id || doc._id;
    if (title && id) {
      const popularity = toScore(doc.popularity, 0);
      const voteCount = toScore(doc.vote_count, 0);
      const score = popularity + Math.log10(Math.max(1, voteCount));

      const mediaDoc = buildDoc({ type: mediaType, scope: "media", id: String(id), name: title, score, source: mediaType, popularity });
      if (mediaDoc) {
        batch.push(mediaDoc);
      }
      const globalDoc = buildDoc({ type: mediaType, scope: "all", id: String(id), name: title, score, source: mediaType, popularity });
      if (globalDoc) {
        batch.push(globalDoc);
      }
    }

    const cast = Array.isArray(doc.cast_details) ? doc.cast_details : [];
    for (const person of cast) {
      const personName = normalizeText(person?.name || "");
      if (!personName) continue;

      const personKey = personName.toLowerCase();
      if (seenPersons.has(personKey)) continue;
      seenPersons.add(personKey);

      const personScore = 10 + toScore(person?.popularity, 0);
      const personDoc = buildDoc({ type: "person", scope: "media", id: String(person?.id || ""), name: personName, score: personScore, source: mediaType });
      if (personDoc) batch.push(personDoc);
      const globalPersonDoc = buildDoc({ type: "person", scope: "all", id: String(person?.id || ""), name: personName, score: personScore, source: mediaType });
      if (globalPersonDoc) batch.push(globalPersonDoc);
    }

    const genres = Array.isArray(doc.genres) ? doc.genres : [];
    for (const g of genres) {
      const genre = normalizeText(typeof g === "string" ? g : g?.name);
      if (!genre) continue;

      const genreKey = genre.toLowerCase();
      if (seenGenres.has(genreKey)) continue;
      seenGenres.add(genreKey);

      const genreDoc = buildDoc({ type: "genre", scope: "media", id: "", name: genre, score: 8, source: mediaType });
      if (genreDoc) batch.push(genreDoc);
      const globalGenreDoc = buildDoc({ type: "genre", scope: "all", id: "", name: genre, score: 8, source: mediaType });
      if (globalGenreDoc) batch.push(globalGenreDoc);
    }

    if (batch.length >= 1500) {
      // eslint-disable-next-line no-await-in-loop
      await flushBatch(entriesCollection, batch);
    }

    if (scanned % 20000 === 0) {
      console.log(`[${mediaType}] scanned ${scanned} docs...`);
    }
  }

  console.log(`[${mediaType}] done; scanned ${scanned} docs.`);
}

async function collectBoardgameEntries(collection, entriesCollection, state) {
  const { batch } = state;
  let scanned = 0;
  for await (const doc of collection.find({}, { projection: { $vector: 0 } })) {
    scanned += 1;

    const title = normalizeText(doc.name || doc.name0 || doc.title || "");
    const id = doc.bggid || doc.id || doc._id;
    if (title && id) {
      const rankRaw = toScore(doc.boardgamerank, 999999);
      const usersRated = toScore(doc.usersrated, 0);
      const avg = toScore(doc.average, 0);
      const rankBonus = rankRaw > 0 ? (100000 / rankRaw) : 0;
      const score = rankBonus + (avg * 10) + Math.log10(Math.max(1, usersRated));

      const docBoardgames = buildDoc({
        type: "boardgame",
        scope: "boardgames",
        id: String(id),
        name: title,
        score,
        source: "boardgame",
        boardgamerank: Number.isFinite(rankRaw) ? rankRaw : undefined
      });
      if (docBoardgames) batch.push(docBoardgames);

      const docAll = buildDoc({
        type: "boardgame",
        scope: "all",
        id: String(id),
        name: title,
        score,
        source: "boardgame",
        boardgamerank: Number.isFinite(rankRaw) ? rankRaw : undefined
      });
      if (docAll) batch.push(docAll);
    }

    if (batch.length >= 1500) {
      // eslint-disable-next-line no-await-in-loop
      await flushBatch(entriesCollection, batch);
    }

    if (scanned % 20000 === 0) {
      console.log(`[boardgame] scanned ${scanned} docs...`);
    }
  }

  console.log(`[boardgame] done; scanned ${scanned} docs.`);
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
  const autocompleteEntries = db.collection("autocomplete_entries");

  console.log("Resetting autocomplete_entries collection...");
  try {
    await autocompleteEntries.deleteMany({});
  } catch (e) {
    console.warn("deleteMany failed; continuing with insert-only run:", e?.message || e);
  }

  const state = {
    batch: [],
    seenPersons: new Set(),
    seenGenres: new Set()
  };

  console.log("Collecting autocomplete entries from Astra...");
  await collectMediaEntries(movies, "movie", autocompleteEntries, state);
  await collectMediaEntries(tv, "tv", autocompleteEntries, state);
  await collectBoardgameEntries(boardgames, autocompleteEntries, state);
  await flushBatch(autocompleteEntries, state.batch);

  console.log("Done. Autocomplete entries rebuilt in collection 'autocomplete_entries'.");
}

main().catch((error) => {
  console.error("Failed to build autocomplete buckets:", error);
  process.exit(1);
});
