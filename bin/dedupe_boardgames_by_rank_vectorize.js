import { DataAPIClient } from "@datastax/astra-db-ts";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config({ override: true });

const endpoint = process.env.ASTRA_DB_API_ENDPOINT;
const token = process.env.ASTRA_DB_APPLICATION_TOKEN;
const keyspace = process.env.ASTRA_BOARDGAME_KEYSPACE || "boardgames";
const collectionName = "bgg_board_games";

if (!endpoint || !token) {
  console.error("Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN.");
  process.exit(1);
}

function getArgValue(flagName, fallback = null) {
  const idx = process.argv.indexOf(flagName);
  if (idx === -1) return fallback;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}

const quickFlag = process.argv.includes("--quick") || String(process.env.QUICK_RUN || "false").toLowerCase() === "true";
const dryRunFlag = process.argv.includes("--dry-run") || String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const applyFlag = process.argv.includes("--apply") || String(process.env.APPLY || "false").toLowerCase() === "true";

const quickRanks = Number(getArgValue("--quick-ranks", process.env.QUICK_RANKS || 50)) || 50;
const fallbackMaxRank = Number(getArgValue("--max-rank", process.env.MAX_RANK || 25000)) || 25000;
const fallbackEmptyStreakStop = Number(getArgValue("--empty-streak-stop", process.env.EMPTY_STREAK_STOP || 2500)) || 2500;

const mode = quickFlag ? "quick" : (applyFlag && !dryRunFlag ? "apply" : "dry-run");

function stableCanonicalize(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  if (typeof value === "object") {
    const out = {};
    Object.keys(value)
      .filter((k) => k !== "_id")
      .sort()
      .forEach((k) => {
        out[k] = stableCanonicalize(value[k]);
      });
    return out;
  }
  return value;
}

function docFingerprint(doc) {
  const canonical = JSON.stringify(stableCanonicalize(doc));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function asTitle(doc) {
  return doc?.name || doc?.name0 || "(untitled)";
}

function isTruthyVectorize(v) {
  return String(v ?? "").trim().length > 0;
}

function printUsage() {
  console.log("\nUsage:");
  console.log("  node bin/dedupe_boardgames_by_rank_vectorize.js --quick [--quick-ranks 5]");
  console.log("  node bin/dedupe_boardgames_by_rank_vectorize.js --dry-run");
  console.log("  node bin/dedupe_boardgames_by_rank_vectorize.js --apply");
  console.log("\nNotes:");
  console.log("  - Duplicates are removed only when:");
  console.log("    1) boardgamerank matches exactly");
  console.log("    2) $vectorize matches exactly");
  console.log("    3) full document content is identical except _id");
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  const client = new DataAPIClient(token);
  const db = client.db(endpoint, { keyspace });
  const collection = db.collection(collectionName);

  console.log(`Starting boardgame dedupe by boardgamerank + $vectorize + exact-content (${keyspace}.${collectionName})`);
  console.log(`Mode: ${mode.toUpperCase()}`);

  // Determine max rank with a single sorted query (fast path).
  let maxRank = 0;
  try {
    const topRankDocs = await collection
      .find(
        { boardgamerank: { $exists: true } },
        { projection: { boardgamerank: 1 }, sort: { boardgamerank: -1 }, limit: 1 }
      )
      .toArray();
    maxRank = Math.floor(Number(topRankDocs?.[0]?.boardgamerank) || 0);
  } catch {
    maxRank = 0;
  }

  const hasMaxRank = Number.isFinite(maxRank) && maxRank > 0;
  const requestedStopRank = quickFlag ? quickRanks : fallbackMaxRank;

  console.log(
    hasMaxRank
      ? `Detected max boardgamerank=${maxRank}.`
      : `Could not determine max boardgamerank quickly; using fallback upper bound ${fallbackMaxRank}.`
  );
  if (quickFlag) {
    console.log(`Quick run enabled: checking ranks 1..${quickRanks} only.`);
  }

  let scannedRanks = 0;
  let scannedDocs = 0;
  let duplicateVectorizeGroups = 0;
  let exactDuplicateGroups = 0;
  let duplicatesWouldDelete = 0;
  let duplicatesDeleted = 0;

  let emptyStreak = 0;
  const stopRank = hasMaxRank ? Math.min(maxRank, requestedStopRank) : requestedStopRank;

  for (let rank = 1; rank <= stopRank; rank += 1) {
    scannedRanks += 1;

    // Exact rank match per your requested method.
    // Include both numeric and string in case of mixed ingestion.
    const docs = await collection
      .find(
        {
          $or: [{ boardgamerank: rank }, { boardgamerank: String(rank) }]
        },
        {
          projection: {
            _id: 1,
            bggid: 1,
            name: 1,
            name0: 1,
            boardgamerank: 1,
            $vectorize: 1
          },
          limit: 500
        }
      )
      .toArray();

    if (docs.length === 0) {
      emptyStreak += 1;
      if (!hasMaxRank && !quickFlag && emptyStreak >= fallbackEmptyStreakStop) {
        console.log(`Stopping early after ${emptyStreak} consecutive empty ranks at rank=${rank}.`);
        break;
      }
      continue;
    }

    emptyStreak = 0;

    scannedDocs += docs.length;

    const byVectorize = new Map();
    for (const doc of docs) {
      const key = String(doc["$vectorize"] ?? "").trim();
      if (!isTruthyVectorize(key)) continue;
      if (!byVectorize.has(key)) byVectorize.set(key, []);
      byVectorize.get(key).push(doc);
    }

    for (const [vectorizeValue, group] of byVectorize.entries()) {
      if (group.length < 2) continue;
      duplicateVectorizeGroups += 1;

      // Only delete if docs are fully identical except _id.
      const byFingerprint = new Map();
      for (const doc of group) {
        const fp = docFingerprint(doc);
        if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
        byFingerprint.get(fp).push(doc);
      }

      for (const [fingerprint, identicalDocs] of byFingerprint.entries()) {
        if (identicalDocs.length < 2) continue;

        exactDuplicateGroups += 1;

        // Keep the first by _id sort, delete the rest.
        identicalDocs.sort((a, b) => String(a._id).localeCompare(String(b._id)));
        const keeper = identicalDocs[0];
        const losers = identicalDocs.slice(1);
        duplicatesWouldDelete += losers.length;

        const title = asTitle(keeper);
        console.log(`\n[Exact Duplicate Group] rank=${rank} title=${title}`);
        console.log(`$vectorize=${vectorizeValue.slice(0, 120)}${vectorizeValue.length > 120 ? "..." : ""}`);
        console.log(`fingerprint=${fingerprint.slice(0, 16)}…`);
        console.log("Entries:");
        identicalDocs.forEach((entry, idx) => {
          console.log(`  ${idx + 1}. title=${asTitle(entry)} _id=${entry._id} bggid=${entry.bggid ?? "n/a"}`);
        });
        console.log(`KEEP: _id=${keeper._id} bggid=${keeper.bggid ?? "n/a"}`);

        for (const loser of losers) {
          console.log(`${mode === "apply" ? "DEL" : "WOULD DEL"}: _id=${loser._id} bggid=${loser.bggid ?? "n/a"}`);
          if (mode === "apply") {
            // eslint-disable-next-line no-await-in-loop
            await collection.deleteOne({ _id: loser._id });
            duplicatesDeleted += 1;
          }
        }
      }
    }

    if (!quickFlag && rank % 100 === 0) {
      const upper = hasMaxRank ? stopRank : requestedStopRank;
      console.log(`Progress: rank=${rank}/${upper}, vectorizeGroups=${duplicateVectorizeGroups}, exactDuplicateGroups=${exactDuplicateGroups}, ${mode === "apply" ? `deleted=${duplicatesDeleted}` : `wouldDelete=${duplicatesWouldDelete}`}`);
    }
  }

  console.log("\n=== Done ===");
  console.log(`Scanned ranks: ${scannedRanks}`);
  console.log(`Scanned docs : ${scannedDocs}`);
  console.log(`Vectorize duplicate groups (rank + $vectorize): ${duplicateVectorizeGroups}`);
  console.log(`Exact duplicate groups (identical except _id): ${exactDuplicateGroups}`);
  if (mode === "apply") {
    console.log(`Deleted: ${duplicatesDeleted}`);
  } else {
    console.log(`Would delete: ${duplicatesWouldDelete}`);
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
