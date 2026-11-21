import { DataAPIClient } from "@datastax/astra-db-ts";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config({ override: true });

const OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

const ASTRA_ENDPOINT = process.env.ASTRA_DB_API_ENDPOINT;
const ASTRA_TOKEN = process.env.ASTRA_DB_APPLICATION_TOKEN;
const BOARDGAME_KEYSPACE = process.env.ASTRA_BOARDGAME_KEYSPACE || "boardgames";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = ASTRA_TOKEN ? new DataAPIClient(ASTRA_TOKEN) : null;
const db = client && ASTRA_ENDPOINT ? client.db(ASTRA_ENDPOINT) : null;
const boardgameDb = client && ASTRA_ENDPOINT ? client.db(ASTRA_ENDPOINT, { keyspace: BOARDGAME_KEYSPACE }) : null;

const DEFAULT_HEADERS = {
  "Content-Type": "application/json"
};

const CANDIDATE_LIMIT_PER_DATASET = Number(process.env.CHAT_CANDIDATE_LIMIT_PER_DATASET || 50);
const FINAL_SOURCE_LIMIT = Number(process.env.CHAT_FINAL_SOURCE_LIMIT || 14);
const RERANK_TOP_K = Number(process.env.CHAT_RERANK_TOP_K || 120);

// In-memory cache to avoid re-embedding the same records repeatedly.
const semanticEmbeddingCache = new Map();

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function tokenize(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function overlapRatio(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;

  let overlap = 0;
  for (const t of ta) {
    if (tb.has(t)) overlap += 1;
  }
  return overlap / Math.max(ta.size, tb.size);
}

function parseQuestionIntent(question) {
  const q = normalizeText(question);
  const out = {
    character: "",
    franchise: ""
  };

  const playedMatch = q.match(/\bwho\s+played\s+(?:the\s+)?([A-Za-z0-9 '&:-]+?)\s+in\s+(?:a|an|the)?\s*([A-Za-z0-9 '&:-]+?)\s+(?:movie|film|show|series)\b/i);
  if (playedMatch) {
    out.character = normalizeText(playedMatch[1]);
    out.franchise = normalizeText(playedMatch[2]);
    return out;
  }

  const inMatch = q.match(/\bin\s+(?:a|an|the)?\s*([A-Za-z0-9 '&:-]+?)\s+(?:movie|film|show|series)\b/i);
  if (inMatch && inMatch[1]) {
    out.franchise = normalizeText(inMatch[1]);
  }

  return out;
}

function inferTypePreference(question) {
  const q = normalizeText(question).toLowerCase();
  const has = (re) => re.test(q);

  const boardgameScore = [
    /\bboard\s*games?\b/,
    /\bboardgames?\b/,
    /\btabletop\b/,
    /\bbgg\b/,
    /\bboardgamerank\b/,
    /\bdesigners?\b/,
    /\bmechanics?\b/,
    /\bpublishers?\b/
  ].reduce((acc, re) => acc + (has(re) ? 1 : 0), 0);

  const movieScore = [
    /\bmovies?\b/,
    /\bfilms?\b/,
    /\bactors?\b/,
    /\bdirectors?\b/,
    /\bwriters?\b/
  ].reduce((acc, re) => acc + (has(re) ? 1 : 0), 0);

  const tvScore = [
    /\btv\b/,
    /\bseries\b/,
    /\bshow\b/,
    /\bepisode\b/
  ].reduce((acc, re) => acc + (has(re) ? 1 : 0), 0);

  const total = boardgameScore + movieScore + tvScore;
  if (total === 0) {
    return { movie: 0, tv: 0, boardgame: 0 };
  }

  return {
    movie: movieScore / total,
    tv: tvScore / total,
    boardgame: boardgameScore / total
  };
}

function truncate(value, maxLen = 480) {
  const text = normalizeText(value);
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function extractContentType(doc, fallback) {
  return doc.content_type || fallback;
}

function asSource(type, doc, intent = null) {
  const title = normalizeText(doc.title || doc.name || doc.name0 || "Untitled");
  const id = String(doc.id || doc._id || doc.bggid || "");

  if (type === "boardgame") {
    const categories = normalizeListValues(doc.categories || doc.boardgamecategory).slice(0, 5).join(", ");
    const mechanics = normalizeListValues(doc.mechanics || doc.boardgamemechanic).slice(0, 4).join(", ");
    const summary = [
      (doc.yearpublished || doc.year) ? `Year: ${doc.yearpublished || doc.year}` : "",
      doc.boardgamerank ? `Rank: ${doc.boardgamerank}` : "",
      categories ? `Categories: ${categories}` : "",
      mechanics ? `Mechanics: ${mechanics}` : "",
      truncate(doc.description || doc.$vectorize || "", 380)
    ].filter(Boolean).join(" | ");

    const intentMatch = intent?.franchise
      ? overlapRatio(`${title} ${normalizeText(doc.description || doc.$vectorize || "")}`, intent.franchise)
      : 0;

    return {
      type,
      id,
      title,
      summary,
      score: Number(doc.$similarity || 0),
      intentMatch
    };
  }

  const castDetails = Array.isArray(doc.cast_details) ? doc.cast_details : [];
  const prioritizedCast = (() => {
    if (!intent?.character) return castDetails;
    const matched = castDetails.filter((c) => overlapRatio(c?.character || "", intent.character) >= 0.5);
    const unmatched = castDetails.filter((c) => overlapRatio(c?.character || "", intent.character) < 0.5);
    return [...matched, ...unmatched];
  })();

  const castSnippet = prioritizedCast
    .slice(0, 10)
    .map((c) => {
      const actor = normalizeText(c?.name || "");
      const role = normalizeText(c?.character || "");
      if (!actor && !role) return "";
      if (!role) return actor;
      if (!actor) return role;
      return `${actor} as ${role}`;
    })
    .filter(Boolean)
    .join("; ");

  const summary = [
    doc.release_date ? `Release: ${doc.release_date}` : "",
    doc.first_air_date ? `First Air: ${doc.first_air_date}` : "",
    doc.vote_average != null ? `Rating: ${doc.vote_average}` : "",
    castSnippet ? `Cast: ${truncate(castSnippet, 220)}` : "",
    truncate(doc.overview || doc.description || doc.plot || "", 380)
  ].filter(Boolean).join(" | ");

  const franchiseText = [
    title,
    normalizeText(doc.overview || doc.description || doc.plot || ""),
    normalizeListValues(doc.keywords).join(", "),
    normalizeListValues(doc.genres).join(", ")
  ].join(" ");

  const characterMatch = intent?.character
    ? Math.max(
      ...castDetails.map((c) => overlapRatio(c?.character || "", intent.character)),
      0
    )
    : 0;
  const franchiseMatch = intent?.franchise ? overlapRatio(franchiseText, intent.franchise) : 0;
  const intentMatch = (0.6 * characterMatch) + (0.4 * franchiseMatch);

  return {
    type,
    id,
    title,
    summary,
    score: Number(doc.$similarity || 0),
    intentMatch
  };
}

function sourceKey(source) {
  return `${source.type}:${source.id}:${source.title.toLowerCase()}`;
}

function normalizeListValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return normalizeText(item);
        if (item && typeof item === "object") {
          return normalizeText(item.name || item.title || item.english_name || item.character || "");
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

function buildSemanticProfile(type, doc) {
  const title = normalizeText(doc.title || doc.original_title || doc.name || doc.name0 || "");
  const overview = normalizeText(doc.overview || doc.description || doc.plot || doc.$vectorize || "");
  const genres = normalizeListValues(doc.genres).join(", ");
  const keywords = normalizeListValues(doc.keywords).join(", ");
  const directors = normalizeListValues(doc.directors).join(", ");
  const writers = normalizeListValues(doc.writers).join(", ");
  const producers = normalizeListValues(doc.producers).join(", ");

  const castDetails = Array.isArray(doc.cast_details) ? doc.cast_details : [];
  const castSnippet = castDetails
    .slice(0, 24)
    .map((c) => {
      const actor = normalizeText(c?.name || "");
      const role = normalizeText(c?.character || "");
      if (actor && role) return `${actor} as ${role}`;
      return actor || role;
    })
    .filter(Boolean)
    .join("; ");

  if (type === "boardgame") {
    const categories = normalizeListValues(doc.categories || doc.boardgamecategory).join(", ");
    const mechanics = normalizeListValues(doc.mechanics || doc.boardgamemechanic).join(", ");
    const designers = normalizeListValues(doc.designers).join(", ");
    const publishers = normalizeListValues(doc.publishers).join(", ");
    const artists = normalizeListValues(doc.artists).join(", ");
    return [
      `Type: boardgame`,
      title ? `Title: ${title}` : "",
      doc.yearpublished ? `Year: ${doc.yearpublished}` : "",
      doc.boardgamerank ? `Rank: ${doc.boardgamerank}` : "",
      categories ? `Categories: ${categories}` : "",
      mechanics ? `Mechanics: ${mechanics}` : "",
      designers ? `Designers: ${designers}` : "",
      publishers ? `Publishers: ${publishers}` : "",
      artists ? `Artists: ${artists}` : "",
      overview ? `Description: ${overview}` : ""
    ].filter(Boolean).join(" | ");
  }

  return [
    `Type: ${type === "tv" ? "tv" : "movie"}`,
    title ? `Title: ${title}` : "",
    doc.release_date ? `Release: ${doc.release_date}` : "",
    doc.first_air_date ? `First Air: ${doc.first_air_date}` : "",
    genres ? `Genres: ${genres}` : "",
    keywords ? `Keywords: ${keywords}` : "",
    directors ? `Directors: ${directors}` : "",
    writers ? `Writers: ${writers}` : "",
    producers ? `Producers: ${producers}` : "",
    castSnippet ? `Cast: ${castSnippet}` : "",
    overview ? `Description: ${overview}` : ""
  ].filter(Boolean).join(" | ");
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function rerankSourcesBySemanticVector(candidates, queryEmbedding, constraintEmbeddings = []) {
  const grouped = {
    movie: [],
    tv: [],
    boardgame: []
  };

  for (const c of candidates) {
    const type = c.type === "tv" || c.type === "boardgame" ? c.type : "movie";
    grouped[type].push(c);
  }

  const perType = Math.max(20, Math.floor(RERANK_TOP_K / 3));
  const seeded = [
    ...grouped.movie.sort((a, b) => Number(b.initialScore || 0) - Number(a.initialScore || 0)).slice(0, perType),
    ...grouped.tv.sort((a, b) => Number(b.initialScore || 0) - Number(a.initialScore || 0)).slice(0, perType),
    ...grouped.boardgame.sort((a, b) => Number(b.initialScore || 0) - Number(a.initialScore || 0)).slice(0, perType)
  ];

  const seenSeed = new Set(seeded.map((s) => sourceKey(s)));
  const remaining = candidates
    .filter((c) => !seenSeed.has(sourceKey(c)))
    .sort((a, b) => Number(b.initialScore || 0) - Number(a.initialScore || 0));

  const topCandidates = [...seeded, ...remaining].slice(0, RERANK_TOP_K);

  const reranked = await Promise.all(
    topCandidates.map(async (item) => {
      const profileText = buildSemanticProfile(item.type, item.doc);
      const cacheKey = `${item.type}:${item.id}:${item.title}`;

      let docEmbedding = semanticEmbeddingCache.get(cacheKey);
      if (!docEmbedding) {
        docEmbedding = await getEmbedding(profileText);
        semanticEmbeddingCache.set(cacheKey, docEmbedding);
      }

      const semanticScore = cosineSimilarity(queryEmbedding, docEmbedding);

      let constraintScore = 0;
      if (Array.isArray(constraintEmbeddings) && constraintEmbeddings.length > 0) {
        const sims = constraintEmbeddings
          .map((emb) => cosineSimilarity(emb, docEmbedding))
          .filter((n) => Number.isFinite(n));
        if (sims.length > 0) {
          // Require semantic agreement across all constraints.
          constraintScore = Math.min(...sims);
        }
      }

      const intentMatch = Number(item.intentMatch || 0);
      const typePreference = Number(item.typePreference || 0);
      const combinedScore = constraintEmbeddings.length > 0
        ? (0.40 * semanticScore) + (0.16 * Number(item.initialScore || 0)) + (0.20 * constraintScore) + (0.12 * intentMatch) + (0.12 * typePreference)
        : (0.56 * semanticScore) + (0.24 * Number(item.initialScore || 0)) + (0.10 * intentMatch) + (0.10 * typePreference);

      return {
        ...item,
        finalScore: combinedScore
      };
    })
  );

  return reranked.sort((a, b) => b.finalScore - a.finalScore);
}

function rankSourcesPureVector(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = sourceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= FINAL_SOURCE_LIMIT) break;
  }

  return out;
}

function extractVectorConstraints(question) {
  const q = normalizeText(question);
  const constraints = [];
  const intent = parseQuestionIntent(question);

  if (intent.character) constraints.push(`${intent.character} character`);
  if (intent.franchise) constraints.push(`${intent.franchise} franchise`);

  const playedMatch = q.match(/\bwho\s+played\s+(?:the\s+)?([A-Za-z0-9 '&:-]+?)\s+in\s+(?:a|an|the)?\s*([A-Za-z0-9 '&:-]+?)\s+(?:movie|film|show|series)\b/i);
  if (playedMatch) {
    const character = normalizeText(playedMatch[1]);
    const franchise = normalizeText(playedMatch[2]);
    if (character) constraints.push(`${character} character`);
    if (franchise) constraints.push(`${franchise} franchise`);
  }

  if (constraints.length === 0) {
    const inMatch = q.match(/\bin\s+(?:a|an|the)?\s*([A-Za-z0-9 '&:-]+?)\s+(?:movie|film|show|series)\b/i);
    if (inMatch && inMatch[1]) {
      constraints.push(`${normalizeText(inMatch[1])} franchise`);
    }
  }

  return Array.from(new Set(constraints.filter(Boolean)));
}

async function buildConstraintEmbeddings(question) {
  const constraints = extractVectorConstraints(question);
  if (!constraints.length) return [];

  const out = [];
  for (const c of constraints) {
    // eslint-disable-next-line no-await-in-loop
    const emb = await getEmbedding(c);
    if (Array.isArray(emb) && emb.length > 0) out.push(emb);
  }
  return out;
}

async function getEmbedding(input) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_EMBED_MODEL,
      input
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Failed to create embedding");
  }

  return data?.data?.[0]?.embedding || null;
}

async function vectorFind(collection, vector, limit) {
  return collection.find(
    {},
    {
      sort: { $vector: vector },
      includeSimilarity: true,
      limit,
      projection: { $vector: 0 }
    }
  ).toArray();
}

function buildVectorQueryVariants(question) {
  const q = normalizeText(question);
  const variants = [
    q,
    `${q} cast actor character credits role performance`,
    `${q} director writer producer genre keywords plot description synopsis`
  ];

  // Generic entity/franchise focus (e.g. "in a Batman movie").
  const franchiseMatch = q.match(/\bin\s+(?:a|an|the)?\s*([A-Za-z0-9 '&:-]+?)\s+(?:movie|film|show|series)\b/i);
  if (franchiseMatch && franchiseMatch[1]) {
    const franchise = normalizeText(franchiseMatch[1]);
    if (franchise) {
      variants.push(`${franchise} movie cast characters director writer producer keywords description`);
    }
  }

  return Array.from(new Set(variants.filter(Boolean)));
}

async function searchAllDatasets(question, queryEmbedding, constraintEmbeddings = [], perDatasetLimit = CANDIDATE_LIMIT_PER_DATASET) {
  if (!db || !boardgameDb) {
    throw new Error("Astra DB is not configured");
  }

  const intent = parseQuestionIntent(question);
  const typePreference = inferTypePreference(question);

  const datasets = [
    { type: "movie", collection: db.collection("movies2026") },
    { type: "tv", collection: db.collection("tvshows2026") },
    { type: "boardgame", collection: boardgameDb.collection("bgg_board_games") }
  ];

  const variantTexts = buildVectorQueryVariants(question);
  const variantEmbeddings = [queryEmbedding];
  for (let i = 1; i < variantTexts.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const emb = await getEmbedding(variantTexts[i]);
    if (Array.isArray(emb) && emb.length) variantEmbeddings.push(emb);
  }

  const datasetResults = await Promise.all(
    datasets.map(async ({ type, collection }) => {
      const perVariantLimit = Math.max(12, perDatasetLimit);
      const merged = [];
      for (const emb of variantEmbeddings) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await vectorFind(collection, emb, perVariantLimit);
        merged.push(...rows);
      }
      return merged.map((doc) => ({ type, doc }));
    })
  );

  const flat = datasetResults.flat();
  const candidates = flat.map(({ type, doc }) => {
    const resolvedType = extractContentType(doc, type);
    const source = asSource(resolvedType, doc, intent);
    return {
      ...source,
      type: resolvedType,
      doc,
      initialScore: Number(doc.$similarity || source.score || 0),
      intentMatch: Number(source.intentMatch || 0),
      typePreference: Number(typePreference[resolvedType] || 0)
    };
  });

  const reranked = await rerankSourcesBySemanticVector(candidates, queryEmbedding, constraintEmbeddings);
  return rankSourcesPureVector(
    reranked.map(({ doc, initialScore, finalScore, ...rest }) => ({
      ...rest,
      score: Number.isFinite(finalScore) ? finalScore : Number(rest.score || 0)
    }))
  );
}

async function extractEntities(question, history) {
  const messages = [
    {
      role: "system",
      content: [
        "Extract entities from the user's latest question, using the conversation to resolve follow-ups and pronouns.",
        'Return JSON only: {"titles":[{"title":"exact movie or TV title","character":"character name or empty"}],"people":["full person names explicitly mentioned"]}.',
        "Only include titles and people the question or conversation clearly refers to. Use empty arrays when none."
      ].join(" ")
    },
    ...history,
    { role: "user", content: question }
  ];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_CHAT_MODEL,
        messages,
        temperature: 0,
        max_tokens: 200,
        response_format: { type: "json_object" }
      })
    });
    const data = await response.json();
    const parsed = safeJsonParse(data?.choices?.[0]?.message?.content || "{}") || {};
    return {
      titles: Array.isArray(parsed.titles) ? parsed.titles.filter((t) => t && t.title).slice(0, 3) : [],
      people: Array.isArray(parsed.people) ? parsed.people.map(normalizeText).filter(Boolean).slice(0, 3) : []
    };
  } catch {
    return { titles: [], people: [] };
  }
}

async function findByPerson(collection, person, limit) {
  const options = { limit, projection: { $vector: 0 } };
  try {
    const sorted = await collection.find({ cast: person }, { ...options, sort: { popularity: -1 } }).toArray();
    if (sorted.length) return sorted;
  } catch {
    // Fall through to an unsorted lookup.
  }
  return collection.find({ cast: person }, options).toArray();
}

// Exact (non-vector) lookups for titles and people named in the question.
async function searchStructured(question, history) {
  const { titles, people } = await extractEntities(question, history);
  if (!titles.length && !people.length) return { sources: [], facts: [] };

  const movies = db.collection("movies2026");
  const tv = db.collection("tvshows2026");
  const sources = [];
  const facts = [];
  const peopleToFind = new Set(people);

  for (const { title, character } of titles) {
    const lower = normalizeText(title).toLowerCase();
    // eslint-disable-next-line no-await-in-loop
    const [movieHits, tvHits] = await Promise.all([
      movies.find({ title_lower: lower }, { limit: 3, projection: { $vector: 0 } }).toArray(),
      tv.find({ name_lower: lower }, { limit: 3, projection: { $vector: 0 } }).toArray()
    ]);
    const hits = [...movieHits.map((doc) => ({ type: "movie", doc })), ...tvHits.map((doc) => ({ type: "tv", doc }))];
    for (const { type, doc } of hits) {
      sources.push({ ...asSource(type, doc, { character: normalizeText(character), franchise: "" }), type });
      if (character) {
        const match = (doc.cast_details || []).find((c) => overlapRatio(c?.character || "", character) >= 0.5);
        if (match?.name) {
          facts.push(`${match.name} played ${match.character} in ${doc.title || doc.name}.`);
          peopleToFind.add(match.name);
        }
      }
    }
  }

  for (const person of peopleToFind) {
    // eslint-disable-next-line no-await-in-loop
    const [movieHits, tvHits] = await Promise.all([findByPerson(movies, person, 30), findByPerson(tv, person, 15)]);
    const credits = [
      ...movieHits.map((doc) => ({ type: "movie", doc })),
      ...tvHits.map((doc) => ({ type: "tv", doc }))
    ];
    if (credits.length) {
      const list = credits.map(({ type, doc }) => {
        const year = String(doc.release_date || doc.first_air_date || "").slice(0, 4);
        const role = (doc.cast_details || []).find((c) => c?.name === person)?.character;
        return `${doc.title || doc.name}${year ? ` (${year})` : ""}${role ? ` as ${role}` : ""} [${type}]`;
      });
      facts.push(`Credits for ${person} in the database: ${list.join("; ")}.`);
    }
    credits.slice(0, 12).forEach(({ type, doc }) => sources.push({ ...asSource(type, doc), type }));
  }

  return { sources, facts };
}

function buildContextText(sources, facts = []) {
  if (!sources.length && !facts.length) return "No matching records found.";
  const factBlock = facts.length ? `Verified facts:\n${facts.join("\n")}\n\nRelated records:\n` : "";
  return factBlock + sources.map((source, index) => {
    const label = `${index + 1}. [${source.type.toUpperCase()}] ${source.title}`;
    const meta = source.summary ? ` | ${source.summary}` : "";
    return `${label}${meta}`;
  }).join("\n");
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }))
    .slice(-8);
}

async function generateAnswer({ question, contextText, history }) {
  const systemPrompt = [
    "You are The Intersect assistant.",
    "Use only the provided context from the app datasets: movies, TV shows, and board games.",
    "If the answer is not in the context, say you don't know based on current data.",
    "Be concise and directly answer the user question.",
    "Write titles exactly as they appear in the context. Start with a one-sentence answer, then list other items as bullets, one per line, formatted \"- Title (year) as Role\". Never put multiple items on one line.",
    "If useful, mention whether info came from movie, TV, or board game records.",
    "When the context includes multiple dataset types for the same franchise, include a cross-dataset answer instead of focusing on one type only."
  ].join(" ");

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    {
      role: "user",
      content: `Context:\n${contextText}\n\nQuestion: ${question}`
    }
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 450
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || "Failed to generate response");
  }

  const answer = data?.choices?.[0]?.message?.content;
  return String(answer || "I don't know based on current data.").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  if (!OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({ error: "OPENAI_API_KEY is not configured" })
    };
  }

  if (!ASTRA_ENDPOINT || !ASTRA_TOKEN) {
    return {
      statusCode: 500,
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({ error: "Astra DB credentials are not configured" })
    };
  }

  const body = safeJsonParse(event.body || "{}") || {};
  const question = normalizeText(body.message || "");
  const history = sanitizeHistory(body.history);

  if (!question) {
    return {
      statusCode: 400,
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({ error: "Message is required" })
    };
  }

  try {
    const queryEmbedding = await getEmbedding(question);
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      throw new Error("Could not generate query embedding");
    }

    const constraintEmbeddings = await buildConstraintEmbeddings(question);
    const [vectorSources, structured] = await Promise.all([
      searchAllDatasets(question, queryEmbedding, constraintEmbeddings, CANDIDATE_LIMIT_PER_DATASET),
      searchStructured(question, history)
    ]);
    const seen = new Set();
    const sources = [...structured.sources, ...vectorSources].filter((s) => {
      const key = sourceKey(s);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, FINAL_SOURCE_LIMIT + 12);
    const contextText = buildContextText(sources, structured.facts);
    const answer = await generateAnswer({ question, contextText, history });

    return {
      statusCode: 200,
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({
        answer,
        sources: sources.map((s) => ({
          type: s.type,
          id: s.id,
          title: s.title,
          score: s.score
        }))
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({ error: error?.message || "Chat request failed" })
    };
  }
}
