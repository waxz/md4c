// Flash cards (js/cards.js): spaced repetition, cleaning, import and export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardKey, cleanCard, mergeCards, newCard, nextLabel, parseCards, review, spanLabel, toCsv } from '../js/cards.js';

const DAY = 864e5;
const T0 = Date.UTC(2026, 10, 7);

test('a new card is due now and spaced out by its answers', () => {
  const c = newCard({ term: 'sequence', ipa: [{ text: '/ˈsiːkwəns/', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/sequence-us.mp3', region: 'US' }] }, T0);
  assert.match(c.id, /^c-[a-z0-9]{6}$/);
  assert.equal(c.kind, 'word');
  assert.equal(c.due, T0);
  // Good, good, good: 1 day, 6 days, then times the ease.
  let x = review(c, 'good', T0);
  assert.equal(x.interval, 1);
  assert.equal(x.due, T0 + DAY);
  x = review(x, 'good', x.due);
  assert.equal(x.interval, 6);
  x = review(x, 'good', x.due);
  assert.equal(x.interval, 15); // 6 × 2.5
  // Easy raises the ease, hard lowers it.
  assert.equal(review(x, 'easy', x.due).ease, 2.65);
  assert.equal(review(x, 'hard', x.due).ease, 2.35);
  assert.equal(review(c, 'easy', T0).interval, 4);
  // Again: back in ten minutes, from the start, a lapse counted.
  const lapsed = review(x, 'again', x.due);
  assert.equal(lapsed.due - x.due, 10 * 60e3);
  assert.equal(lapsed.reps, 0);
  assert.equal(lapsed.lapses, 1);
  assert.equal(lapsed.ease, 2.3);
  // The ease stays within 1.3 and 3.
  let low = c;
  for (let i = 0; i < 20; i++) low = review(low, 'again', T0);
  assert.equal(low.ease, 1.3);
  assert.throws(() => review(c, 'maybe', T0), /Unknown grade/);
});

test('the grade buttons say when the card comes back', () => {
  const c = newCard({ term: 'x' }, T0);
  assert.deepEqual(['again', 'hard', 'good', 'easy'].map((g) => nextLabel(c, g, T0)), ['10 min', '1 d', '1 d', '4 d']);
  assert.equal(spanLabel(3 * 3600e3), '3 h');
  assert.equal(spanLabel(60 * DAY), '2 mo');
  assert.equal(spanLabel(400 * DAY), '1.1 y');
});

test('cards are cleaned: known fields, safe links, sensible sizes', () => {
  const c = cleanCard({
    term: '  attention  mechanism ', kind: 'phrase', lang: 'en', extra: 'dropped', ease: 9, reps: -3,
    ipa: [{ text: '/x/', audio: 'javascript:alert(1)' }], source: { title: 'Paper', href: 'javascript:alert(1)', page: '3' },
    translation: 'x'.repeat(5000),
  });
  assert.equal(c.term, 'attention mechanism');
  assert.equal(c.kind, 'phrase');
  assert.equal(c.extra, undefined);
  assert.equal(c.ease, 3);
  assert.equal(c.reps, 0);
  assert.equal(c.ipa[0].audio, '');
  assert.deepEqual(c.source, { title: 'Paper', href: '', page: 3 });
  assert.equal(c.translation.length, 1000);
  assert.equal(cleanCard({ term: '   ' }), null);
  assert.equal(cleanCard(null), null);
});

test('one card per word or phrase: import merges, the one reviewed more wins', () => {
  assert.equal(cardKey({ term: 'Sequence', lang: 'en' }), cardKey({ term: ' sequence ', lang: 'en' }));
  const mine = [review(newCard({ term: 'sequence' }, T0), 'good', T0)];
  const theirs = [newCard({ term: 'Sequence' }, T0), newCard({ term: 'encoder' }, T0)];
  const merged = mergeCards(mine, theirs);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((c) => c.term.toLowerCase() === 'sequence').reps, 1);
  // A file: a list, or { cards }; anything else in it is dropped.
  assert.equal(parseCards(JSON.stringify({ cards: theirs })).length, 2);
  assert.equal(parseCards(JSON.stringify([{ term: 'a' }, { nope: 1 }, { term: 'A' }])).length, 1);
  assert.throws(() => parseCards('not json'));
});

test('CSV for Anki: front, back, context, source; quotes doubled', () => {
  const c = newCard({
    term: 'say "hi"', meaning: 'greet', translation: '挨拶する', ipa: [{ text: '/haɪ/' }],
    context: 'We say "hi".', source: { title: 'A paper', href: 'https://blog.example.com/posts/a.html', page: 2 },
  }, T0);
  const csv = toCsv([c]).split('\n');
  assert.equal(csv[0], '"Front","Back","Context","Source"');
  assert.equal(csv[1], '"say ""hi""","/haɪ/ — greet — 挨拶する","We say ""hi"".","A paper, p. 2 https://blog.example.com/posts/a.html"');
});
