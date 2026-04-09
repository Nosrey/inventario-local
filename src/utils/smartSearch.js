/**
 * smartSearch.js
 *
 * Reusable fuzzy search utilities for product searchers.
 * Goals:
 * - Accent / diacritic insensitive
 * - Punctuation and symbol tolerant
 * - Token-order and extra-word tolerant
 * - Prefix / substring / fuzzy (Levenshtein) matches
 * - Lightweight, pure-JS, no external deps
 *
 * Usage:
 *   import { smartSearch, createSearcher } from '../utils/smartSearch';
 *
 *   // simple one-off
 *   const results = smartSearch(items, 'base max glow', { keys: ['name','sku'] });
 *
 *   // reusable preprocessed searcher for many queries
 *   const searcher = createSearcher(items, { keys: ['name','sku'], nameKey: 'name' });
 *   const results2 = searcher.search('maxglow');
 */

// Normalize text: lowercase, remove diacritics, remove punctuation, collapse spaces
function normalizeText(str) {
  if (!str) return '';
  // to string
  let s = String(str).toLowerCase();
  // NFD + remove diacritics
  s = s.normalize && s.normalize('NFD') ? s.normalize('NFD') : s;
  s = s.replace(/\p{Diacritic}/gu, ''); // try unicode property if available
  // fallback range for combining diacritics
  s = s.replace(/[\u0300-\u036f]/g, '');
  // remove punctuation and symbols, keep letters/numbers/whitespace
  s = s.replace(/[\p{P}\p{S}]/gu, ' ');
  // remove multiple whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function tokenize(str) {
  const n = normalizeText(str);
  if (!n) return [];
  return n.split(' ').filter(Boolean);
}

// Simple iterative Levenshtein distance (works well for small tokens)
function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const prev = new Array(lb + 1);
  const cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    const ai = a.charAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ai === b.charAt(j - 1) ? 0 : 1;
      let v = prev[j] + 1; // deletion
      const ins = cur[j - 1] + 1; // insertion
      if (ins < v) v = ins;
      const sub = prev[j - 1] + cost; // substitution
      if (sub < v) v = sub;
      cur[j] = v;
    }
    for (let j = 0; j <= lb; j++) prev[j] = cur[j];
  }
  return cur[lb];
}

// compute fuzzy score between query tokens and item tokens
function scoreTokens(qTokens, itemTokens) {
  // qTokens: ['base','max','glow']
  // itemTokens: ['base','gel','max','glow']
  let total = 0;
  let matched = 0;

  for (const q of qTokens) {
    if (!q) continue;
    let best = { score: 0, kind: null };
    for (const t of itemTokens) {
      if (!t) continue;
      if (t === q) {
        best = { score: 100, kind: 'exact' }; break;
      }
      if (t.startsWith(q) || q.startsWith(t)) {
        // prefix match (good)
        const s = 70 + Math.max(0, 10 - Math.abs(t.length - q.length));
        if (s > best.score) best = { score: s, kind: 'prefix' };
      }
      if (t.includes(q) || q.includes(t)) {
        const s = 60 + Math.max(0, 8 - Math.abs(t.length - q.length));
        if (s > best.score) best = { score: s, kind: 'substr' };
      }
      // fuzzy via levenshtein: allow small edits relative to length
      const maxDist = Math.max(1, Math.floor(Math.min(t.length, q.length) * 0.34));
      const d = levenshtein(q, t);
      if (d <= maxDist) {
        const s = Math.max(30, 50 - d * 10);
        if (s > best.score) best = { score: s, kind: 'fuzzy' };
      }
    }
    if (best.score > 0) {
      total += best.score;
      matched += 1;
    } else {
      // slight penalty for unmatched token
      total -= 5;
    }
  }

  // normalize by number of query tokens
  const norm = qTokens.length > 0 ? total / qTokens.length : 0;
  // boost when many tokens matched
  const matchRatio = qTokens.length ? matched / qTokens.length : 0;
  const final = norm * (0.8 + 0.4 * matchRatio);
  return Math.max(final, -50); // clamp
}

/**
 * Preprocess an item into searchable fields
 * item: object
 * keys: array of keys to search (defaults to ['name'])
 */
function preprocessItem(item, keys = ['name']) {
  const pre = { original: item, fields: {}, combinedTokens: [] };
  for (const k of keys) {
    const raw = item[k] || '';
    const norm = normalizeText(raw);
    const tokens = tokenize(norm);
    pre.fields[k] = { raw, norm, tokens };
    pre.combinedTokens.push(...tokens);
  }
  // dedupe combined tokens
  pre.combinedTokens = Array.from(new Set(pre.combinedTokens));
  return pre;
}

/**
 * smartSearch(items, query, options)
 * options:
 *  - keys: array of fields to search (default ['name'])
 *  - nameKey: main display key for extra weighting (default 'name')
 *  - maxResults: number or null
 *  - minScore: minimum score to include (default 8)
 */
export function smartSearch(items = [], query = '', options = {}) {
  const keys = options.keys || ['name'];
  const nameKey = options.nameKey || 'name';
  const maxResults = options.maxResults || 50;
  const minScore = typeof options.minScore === 'number' ? options.minScore : 8;

  const qNorm = normalizeText(query);
  if (!qNorm) return [];
  const qTokens = tokenize(qNorm);

  const results = [];
  for (const it of items) {
    const pre = preprocessItem(it, keys);
    // score name higher
    const nameTokens = pre.fields[nameKey]?.tokens || pre.combinedTokens;
    const nameScore = scoreTokens(qTokens, nameTokens) * 1.6;
    // score other fields and combine
    let otherScore = 0;
    for (const k of keys) {
      if (k === nameKey) continue;
      const toks = pre.fields[k]?.tokens || [];
      otherScore += scoreTokens(qTokens, toks) * 0.9;
    }
    // substring catch-all on combined normalized string
    const combined = Object.values(pre.fields).map(f => f.norm).join(' ');
    let bonus = 0;
    if (combined.includes(qNorm)) bonus += 40; // full phrase contained
    // short-query exact substring boost
    if (qNorm.length <= 4 && combined.includes(qNorm)) bonus += 20;

    let score = nameScore + otherScore + bonus;

    // small length/coverage adjustment: prefer shorter distance between token counts
    const tokenCoverage = qTokens.length ? (qTokens.filter(q => pre.combinedTokens.includes(q)).length / qTokens.length) : 0;
    score = score * (0.9 + 0.4 * tokenCoverage);

    if (score >= minScore) results.push({ item: it, score, matchedTokens: pre.combinedTokens });
  }

  results.sort((a, b) => b.score - a.score);
  return maxResults ? results.slice(0, maxResults) : results;
}

/**
 * createSearcher(items, options) returns { search(query, opts) }
 * Preprocesses items once for reuse. Good for wiring into search components.
 */
export function createSearcher(items = [], options = {}) {
  const keys = options.keys || ['name'];
  const nameKey = options.nameKey || 'name';
  const preprocessed = items.map(it => {
    const p = preprocessItem(it, keys);
    return p;
  });

  function search(query, opts = {}) {
    const maxResults = opts.maxResults || options.maxResults || 50;
    const minScore = typeof opts.minScore === 'number' ? opts.minScore : (typeof options.minScore === 'number' ? options.minScore : 8);
    const qNorm = normalizeText(query);
    if (!qNorm) return [];
    const qTokens = tokenize(qNorm);

    const results = [];
    for (const pre of preprocessed) {
      const nameTokens = pre.fields[nameKey]?.tokens || pre.combinedTokens;
      const nameScore = scoreTokens(qTokens, nameTokens) * 1.6;
      let otherScore = 0;
      for (const k of keys) {
        if (k === nameKey) continue;
        otherScore += scoreTokens(qTokens, pre.fields[k]?.tokens || []) * 0.9;
      }
      const combined = Object.values(pre.fields).map(f => f.norm).join(' ');
      let bonus = 0;
      if (combined.includes(qNorm)) bonus += 40;
      if (qNorm.length <= 4 && combined.includes(qNorm)) bonus += 20;

      let score = nameScore + otherScore + bonus;
      const tokenCoverage = qTokens.length ? (qTokens.filter(q => pre.combinedTokens.includes(q)).length / qTokens.length) : 0;
      score = score * (0.9 + 0.4 * tokenCoverage);

      if (score >= minScore) results.push({ item: pre.original, score, matchedTokens: pre.combinedTokens });
    }
    results.sort((a, b) => b.score - a.score);
    return maxResults ? results.slice(0, maxResults) : results;
  }

  return { search };
}

export default smartSearch;
