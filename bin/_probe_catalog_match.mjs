import fs from 'fs';
import path from 'path';

const STOP_WORDS = new Set([
  'the','a','an','of','for','to','in','on','and','or','is','are','with','by','from','about','show','shows','movie','movies','tv','game','games','board','there','any','what','which','who','where','when','how','can','you','tell','me','do','does'
]);

const normalizeText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const tokenize = (text) => normalizeText(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t)=>t.length>1 && !STOP_WORDS.has(t));
const titleLexicalScore = (queryTokens, title) => {
  const titleTokens = new Set(tokenize(title));
  let hits = 0;
  for (const t of queryTokens) if (titleTokens.has(t)) hits += 1;
  return queryTokens.length ? (hits / queryTokens.length) : 0;
};

const p = path.join(process.cwd(), 'public', 'autocomplete-boardgames.json');
const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
const question = 'Are there any board games about the lord of the rings?';
const queryTokens = tokenize(question);
console.log('tokens=', queryTokens);

const scored = rows.map((r) => ({
  id: String(r?.bggid ?? r?.id ?? ''),
  title: normalizeText(r?.name || ''),
  score: titleLexicalScore(queryTokens, r?.name || '')
})).filter((r)=>r.id && r.title && r.score >= 0.3)
  .sort((a,b)=>b.score-a.score)
  .slice(0,20);

console.log('count', scored.length);
console.log(scored.slice(0,10));
