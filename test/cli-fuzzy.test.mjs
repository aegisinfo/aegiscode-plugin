#!/usr/bin/env node
/**
 * The "/" palette's relevance ranking, ported from aegiscodex-dev.
 *
 * What it pins: the scoring tiers (exact > prefix > substring > scattered) and
 * their exact numbers, the matched-character indices the palette bolds, and
 * that an empty query keeps registry order — the property that makes the menu
 * stable before the user types.
 *
 * House style: ESM test file, CommonJS module pulled in with createRequire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { fuzzyScore, fuzzyMatchPositions, fuzzyRank, fuzzyRankWithAliases } = require(
  join(__dirname, '..', 'cli', 'src', 'fuzzy.js')
);

test('exact match scores the top tier (1000)', () => {
  assert.deepEqual(fuzzyScore('clear', 'clear'), { matched: true, score: 1000 });
});

test('prefix match scores 900', () => {
  assert.deepEqual(fuzzyScore('cle', 'clear'), { matched: true, score: 900 });
});

test('substring scores 700 minus the match position', () => {
  // 'lea' starts at index 1 in 'clear' → 700 − 1.
  assert.deepEqual(fuzzyScore('lea', 'clear'), { matched: true, score: 699 });
  // A later substring scores strictly lower (earlier position wins).
  assert.deepEqual(fuzzyScore('ear', 'clear'), { matched: true, score: 698 });
});

test('scattered subsequence scores 50 plus run/name-start bonuses', () => {
  // c@0 (start +10), l@1 (consecutive +15), r@4 (gap +5) → 50 + 5 + 10 + 15 + 5.
  assert.deepEqual(fuzzyScore('clr', 'clear'), { matched: true, score: 85 });
});

test('a character that never appears is a non-match', () => {
  assert.deepEqual(fuzzyScore('xyz', 'clear'), { matched: false, score: 0 });
});

test('empty query matches everything at score 0', () => {
  assert.deepEqual(fuzzyScore('', 'clear'), { matched: true, score: 0 });
});

test('the tiers are strictly ordered: exact > prefix > substring > scattered', () => {
  const exact = fuzzyScore('clear', 'clear').score;
  const prefix = fuzzyScore('cle', 'clear').score;
  const substring = fuzzyScore('lea', 'clear').score;
  const scattered = fuzzyScore('clr', 'clear').score;
  assert.ok(exact > prefix, `${exact} > ${prefix}`);
  assert.ok(prefix > substring, `${prefix} > ${substring}`);
  assert.ok(substring > scattered, `${substring} > ${scattered}`);
});

test('ranking orders by score, then source order (all three prefixes tie)', () => {
  // 'co' prefixes cost/compact/config (all 900, so source order holds) and is
  // dropped from 'clear' (no 'co' substring, no scattered 'o').
  const items = ['cost', 'compact', 'config', 'clear'];
  const nameOf = (x) => x;
  assert.deepEqual(fuzzyRank('co', items, nameOf), ['cost', 'compact', 'config']);
});

test('fuzzyMatchPositions mirrors the tiers', () => {
  assert.deepEqual(fuzzyMatchPositions('clear', 'clear'), [0, 1, 2, 3, 4]); // exact: every index
  assert.deepEqual(fuzzyMatchPositions('cle', 'clear'), [0, 1, 2]); // prefix: leading run
  assert.deepEqual(fuzzyMatchPositions('lea', 'clear'), [1, 2, 3]); // substring: that run
  assert.deepEqual(fuzzyMatchPositions('clr', 'clear'), [0, 1, 4]); // scattered picks
});

test('fuzzyMatchPositions edge cases', () => {
  assert.deepEqual(fuzzyMatchPositions('', 'clear'), []); // empty query → no indices
  assert.equal(fuzzyMatchPositions('zzz', 'clear'), null); // no match → null
});

test('empty query returns the registry order unchanged', () => {
  const items = [{ name: 'clear' }, { name: 'help' }, { name: 'model' }];
  const nameOf = (x) => x.name;
  const ranked = fuzzyRank('', items, nameOf);
  assert.equal(ranked, items, 'the same array is returned, order preserved');
  assert.deepEqual(ranked.map(nameOf), ['clear', 'help', 'model']);
});

test('fuzzyRank drops non-matches and keeps ties in source order', () => {
  const items = ['clear', 'compact', 'zzz'];
  const nameOf = (x) => x;
  const ranked = fuzzyRank('c', items, nameOf);
  assert.ok(!ranked.includes('zzz'), 'a non-match is dropped');
  assert.deepEqual(ranked, ['clear', 'compact'], 'source order preserved on a tie');
});

test('fuzzyRankWithAliases matches through an alias', () => {
  const items = [
    { name: 'clear' },
    { name: 'new' }, // matches only via the 'reset' alias
  ];
  const nameOf = (x) => x.name;
  const aliasesOf = (x) => (x.name === 'new' ? ['reset'] : []);
  const ranked = fuzzyRankWithAliases('reset', items, nameOf, aliasesOf);
  assert.deepEqual(ranked.map(nameOf), ['new']);
});
