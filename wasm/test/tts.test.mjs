// Reading aloud (blog/paper-tts.js): what is said, and in which pieces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentences, speakable } from '../blog/paper-tts.js';

test('a page is read sentence by sentence; "Fig. 3", "e.g." and short bits do not cut it', () => {
  const text = 'The Transformer follows this overall architecture, as shown in Fig. 1. It uses stacked self-attention, e.g. in the encoder. Table 2. Results are reported on WMT 2014.';
  assert.deepEqual(sentences(text).map((s) => s.text), [
    'The Transformer follows this overall architecture, as shown in Fig. 1.',
    'It uses stacked self-attention, e.g. in the encoder.',
    'Table 2. Results are reported on WMT 2014.',
  ]);
  // The offsets point into the page's text.
  for (const s of sentences(text)) assert.equal(text.slice(s.start, s.end).trim(), s.text);
});

test('what is said: words broken over lines joined, citations and links left out', () => {
  assert.equal(speakable('recurrent neural net- works [12, 13] and LSTMs [5] (see https://example.com/x)'), 'recurrent neural networks and LSTMs (see a link)');
  assert.equal(speakable('self- Attention'), 'self- Attention'); // (a capital after: not a broken word)
  assert.equal(speakable('Ashish Vaswani∗ Google Brain avaswani@google.com'), 'Ashish Vaswani Google Brain');
});
