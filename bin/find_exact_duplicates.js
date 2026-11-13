import { DataAPIClient } from "@datastax/astra-db-ts";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";

dotenv.config({ override: true });

const endpoint = process.env.ASTRA_DB_API_ENDPOINT;
const token = process.env.ASTRA_DB_APPLICATION_TOKEN;
const boardgameKeyspace = process.env.ASTRA_BOARDGAME_KEYSPACE || "boardgames";

if (!endpoint || !token) {
  console.error("Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN in environment.");
  process.exit(1);
}

const client = new DataAPIClient(token);

const TARGETS = [
  { keyspace: undefined, collection: "movies2026", label: "default.movies2026" },
  { keyspace: undefined, collection: "tvshows2026", label: "default.tvshows2026" },
  { keyspace: boardgameKeyspace, collection: "bgg_board_games", label: `${boardgameKeyspace}.bgg_board_games` }
];

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

function canonicalString(doc) {
  return JSON.stringify(stableCanonicalize(doc));
}

async function scanCollection({ keyspace, collection, label }) {
  const db = keyspace ? client.db(endpoint, { keyspace }) : client.db(endpoint);
  const coll = db.collection(collection);

  const hashToGroup = new Map();
  let scanned = 0;

  for await (const doc of coll.find({})) {
    scanned += 1;
    if (scanned % 1000 === 0) {
      process.stdout.write(`\r[${label}] scanned ${scanned}`);
    }

    const canon = canonicalString(doc);
    const hash = crypto.createHash("sha256").update(canon).digest("hex");

    if (!hashToGroup.has(hash)) {
      hashToGroup.set(hash, {
        canonical: canon,
        ids: [String(doc._id)],
        sample: doc
      });
    } else {
      const group = hashToGroup.get(hash);
      // Collision-safe check
      if (group.canonical === canon) {
        group.ids.push(String(doc._id));
      } else {
        const collisionKey = `${hash}:collision:${group.ids.length}`;
        hashToGroup.set(collisionKey, {
          canonical: canon,
          ids: [String(doc._id)],
          sample: doc
        });
      }
    }
  }

  process.stdout.write(`\r[${label}] scanned ${scanned}\n`);

  const duplicateGroups = [];
  for (const [, group] of hashToGroup) {
    if (group.ids.length > 1) {
      duplicateGroups.push({
        count: group.ids.length,
        ids: group.ids,
        sample_id: String(group.sample?._id),
        tmdb_id: group.sample?.id ?? null,
        bggid: group.sample?.bggid ?? null,
        title: group.sample?.title || group.sample?.name || group.sample?.name0 || null
      });
    }
  }

  duplicateGroups.sort((a, b) => b.count - a.count || String(a.title || "").localeCompare(String(b.title || "")));

  return {
    label,
    keyspace: keyspace || "default",
    collection,
    scanned,
    duplicate_group_count: duplicateGroups.length,
    duplicate_document_count: duplicateGroups.reduce((sum, g) => sum + (g.count - 1), 0),
    duplicate_groups: duplicateGroups
  };
}

async function main() {
  const started = new Date().toISOString();
  console.log(`Starting exact duplicate scan at ${started}`);

  const results = [];
  for (const target of TARGETS) {
    // eslint-disable-next-line no-await-in-loop
    const res = await scanCollection(target);
    results.push(res);
  }

  const report = {
    generated_at: new Date().toISOString(),
    criteria: "Documents are duplicates if every field/value matches exactly after removing only _id",
    collections: results
  };

  const outPath = path.join(process.cwd(), "duplicate-report.exact.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("\n=== Summary ===");
  for (const c of results) {
    console.log(
      `${c.label}: scanned=${c.scanned}, duplicate_groups=${c.duplicate_group_count}, duplicate_documents=${c.duplicate_document_count}`
    );
  }

  console.log(`\nReport written: ${outPath}`);

  console.log("\n=== Duplicate groups (all) ===");
  for (const c of results) {
    console.log(`\n[${c.label}]`);
    if (c.duplicate_groups.length === 0) {
      console.log("  none");
      continue;
    }

    c.duplicate_groups.forEach((g, idx) => {
      console.log(`  ${idx + 1}. title=${g.title || "(no title)"} count=${g.count}`);
      if (g.tmdb_id !== null) console.log(`     tmdb_id=${g.tmdb_id}`);
      if (g.bggid !== null) console.log(`     bggid=${g.bggid}`);
      console.log(`     ids=${g.ids.join(", ")}`);
    });
  }
}

main().catch((err) => {
  console.error("Duplicate scan failed:", err);
  process.exit(1);
});
