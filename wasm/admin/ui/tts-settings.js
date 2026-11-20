// Settings, "Text to speech": the OpenAI-style speech API that reads papers
// aloud in the admin (blog/paper-tts.js). Kept in Cloudflare KV; the key is
// write-only (the Worker never sends it back) and is used only by the
// Worker, which calls the service for the admin's pages.

import { api } from './client.js';
import { esc, reportError, toast } from './shared.js';

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

export async function mountTtsSettings(box) {
  box.className = 'settings tts-settings';
  box.innerHTML = '<h2>Text to speech</h2><p class="muted">Loading…</p>';
  let cfg;
  try {
    cfg = await api.ttsConfig();
  } catch (err) {
    box.innerHTML = `<h2>Text to speech</h2><p class="error">${esc(err.message)}</p>`;
    return;
  }
  const render = () => {
    box.innerHTML = `<h2>Text to speech</h2>
      <p class="hint">Papers are read aloud with this browser's voice (the PDF viewer's 🔊). Here, an OpenAI-style speech API
        (<code>POST …/audio/speech</code>: OpenAI, or a server of your own such as Kokoro or openedai-speech) reads them in
        the admin instead. Its key stays with the Worker, in Cloudflare; visitors of the blog always get their browser's voice.</p>
      ${cfg.from === 'deploy' ? '<p class="hint">Set in the deploy (TTS_BASE_URL, TTS_API_KEY): saving here overrides it.</p>' : ''}
      <div class="grid">
        <label class="field span-2"><span>API address (with its version)</span>
          <input name="baseUrl" type="url" autocapitalize="off" spellcheck="false" placeholder="https://api.openai.com/v1" value="${esc(cfg.from ? cfg.baseUrl : '')}"></label>
        <label class="field"><span>Model</span><input name="model" autocapitalize="off" spellcheck="false" placeholder="gpt-4o-mini-tts" value="${esc(cfg.from ? cfg.model : '')}"></label>
        <label class="field"><span>Voice</span><input name="voice" list="tts-voices" autocapitalize="off" spellcheck="false" placeholder="alloy" value="${esc(cfg.from ? cfg.voice : '')}">
          <datalist id="tts-voices">${VOICES.map((v) => `<option value="${v}">`).join('')}</datalist></label>
        <label class="field span-2"><span>API key${cfg.keySet ? ' (saved)' : ''}</span>
          <input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="${cfg.keySet ? 'Saved — leave empty to keep' : 'sk-… (none for a server of your own without one)'}"></label>
      </div>
      <div class="tts-actions">
        <button type="button" class="btn btn-primary" data-tts="save"${cfg.kv ? '' : ' disabled title="Needs the SETTINGS KV namespace"'}>Save</button>
        <button type="button" class="btn" data-tts="test"${cfg.configured ? '' : ' disabled'}>Test</button>
        ${cfg.keySet && cfg.from === 'kv' ? '<button type="button" class="btn btn-danger-text" data-tts="clear-key">Remove the key</button>' : ''}
        ${cfg.from === 'kv' ? '<button type="button" class="btn btn-danger-text" data-tts="off">Turn off</button>' : ''}
        <span class="muted tts-state">${cfg.configured ? `On: ${esc(cfg.model)}, ${esc(cfg.voice)}` : 'Off: the browser\'s voice is used'}</span>
      </div>
      ${cfg.kv ? '' : '<p class="hint">This deploy has no SETTINGS KV namespace: set <code>TTS_BASE_URL</code> and the secret <code>TTS_API_KEY</code> in the Worker instead.</p>'}`;
  };
  render();
  const value = (n) => box.querySelector(`[name="${n}"]`).value.trim();
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tts]');
    if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.tts === 'save') {
        cfg = await api.saveTts({ baseUrl: value('baseUrl') || 'https://api.openai.com/v1', model: value('model') || 'gpt-4o-mini-tts', voice: value('voice') || 'alloy', apiKey: value('apiKey') });
        toast('Text to speech saved.', 'success');
      } else if (b.dataset.tts === 'clear-key') {
        cfg = await api.saveTts({ baseUrl: cfg.baseUrl, model: cfg.model, voice: cfg.voice, clearKey: true });
        toast('The key is removed.', 'success');
      } else if (b.dataset.tts === 'off') {
        cfg = await api.saveTts({ baseUrl: '' });
        toast('Text to speech is off: the browser\'s voice is used.', 'success');
      } else if (b.dataset.tts === 'test') {
        const blob = await api.speech({ input: 'Attention is all you need. This is how papers will sound when read aloud.' });
        const audio = new Audio(URL.createObjectURL(blob));
        await audio.play();
        toast('Playing a sample.', 'info');
      }
      render();
    } catch (err) {
      reportError(err, 'That did not work');
      b.disabled = false;
    }
  });
}
