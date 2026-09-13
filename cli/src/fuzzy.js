'use strict';

// Fuzzy command matching for the "/" palette (and anything else that needs it).
//
// The real Claude Code palette ranks matches by relevance rather than plain
// prefix: an exact match beats a prefix, a prefix beats a substring, and a
// substring beats characters scattered through the name. Ties fall back to
// the source (registry) order so the palette stays stable for empty queries.
//
// Scoring tiers (deliberately spaced so no position/length detail in a lower
// tier can overtake a higher tier):
//   exact match   1000
//   prefix match   900
//   substring      700 − position          (earlier substring wins)
//   scattered      50 + bonuses            (consecutive runs, name-start hits)
//
// Ported verbatim from aegiscodex-dev/src/fuzzy.js (ESM → CommonJS). The tier
// numbers are a contract: cli-fuzzy.test.mjs asserts the ordering they encode.

function fuzzyScore(query, name) {
  const q = String(query).toLowerCase();
  const n = String(name).toLowerCase();
  if (!q) return { matched: true, score: 0 };
  if (n === q) return { matched: true, score: 1000 };
  if (n.startsWith(q)) return { matched: true, score: 900 };
  const at = n.indexOf(q);
  if (at !== -1) return { matched: true, score: 700 - at };

  // Scattered subsequence: every query char must appear in order.
  let score = 50;
  let prev = -2;
  let last = -1;
  for (const ch of q) {
    const k = n.indexOf(ch, last + 1);
    if (k === -1) return { matched: false, score: 0 };
    if (k === prev + 1) score += 15; // consecutive run — strong signal
    else score += 5;
    if (k === 0) score += 10; // starts at the name — weak signal
    prev = k;
    last = k;
  }
  return { matched: true, score };
}

/**
 * The indices (in the original `name`) of the characters that matched
 * `query`, mirroring fuzzyScore's tiers — exact = every index, prefix =
 * leading run, substring = that run, scattered = the scattered picks.
 * Returns [] for an empty query and null when nothing matches.
 * Drives the palette's bold-matched-chars rendering.
 */
function fuzzyMatchPositions(query, name) {
  const q = String(query).toLowerCase();
  const n = String(name).toLowerCase();
  if (!q) return [];
  if (n === q) return Array.from({ length: q.length }, (_, i) => i);
  if (n.startsWith(q)) return Array.from({ length: q.length }, (_, i) => i);
  const at = n.indexOf(q);
  if (at !== -1) return Array.from({ length: q.length }, (_, i) => at + i);
  const pos = [];
  let last = -1;
  for (const ch of q) {
    const k = n.indexOf(ch, last + 1);
    if (k === -1) return null;
    pos.push(k);
    last = k;
  }
  return pos;
}

/**
 * Rank `items` by how well `nameOf(item)` matches `query`.
 * Empty query returns the items unchanged (preserves registry/palette order).
 * Non-matches are dropped; matches sort by score desc, then source order.
 */
function fuzzyRank(query, items, nameOf) {
  const q = String(query || '');
  if (!q) return items;
  return items
    .map((item, idx) => ({ item, idx, m: fuzzyScore(q, nameOf(item)) }))
    .filter((x) => x.m.matched)
    .sort((a, b) => b.m.score - a.m.score || a.idx - b.idx)
    .map((x) => x.item);
}

/**
 * Alias-aware ranking. The reference palette searches the command name and its
 * aliases (name weight 3, aliases weight 2.5 — Fuse.js in the reference; here
 * the best fuzzy score across both wins). An item matches when the query scores
 * against at least one of its names; ties keep source order so the palette
 * stays stable.
 */
function fuzzyRankWithAliases(query, items, nameOf, aliasesOf) {
  const q = String(query || '');
  if (!q) return items;
  return items
    .map((item, idx) => {
      const names = [nameOf(item), ...((aliasesOf && aliasesOf(item)) || [])];
      let best = null;
      for (const n of names) {
        const m = fuzzyScore(q, n);
        if (m.matched && (!best || m.score > best.score)) best = m;
      }
      return { item, idx, m: best };
    })
    .filter((x) => x.m)
    .sort((a, b) => b.m.score - a.m.score || a.idx - b.idx)
    .map((x) => x.item);
}

module.exports = {
  fuzzyScore,
  fuzzyMatchPositions,
  fuzzyRank,
  fuzzyRankWithAliases,
};
