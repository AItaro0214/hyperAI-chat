/* Voice picker for Groq TTS. The chosen model/voice is remembered on the
 * device and used by the 🔊 button on every assistant answer. */
const $ = (sel) => document.querySelector(sel);

// Orpheus ships a fixed cast per model.
/** Filled from /api/tts/models; the browser entry is added locally. */
let speechModels = [];

/** Japanese-capable system voices, newest browsers list several. */
export function browserVoices() {
  try {
    const all = window.speechSynthesis?.getVoices?.() || [];
    const ja = all.filter((v) => /^ja/i.test(v.lang));
    return (ja.length ? ja : all).slice(0, 12);
  } catch {
    return [];
  }
}

/** Speaks with the OS voices — free, instant, and offline. */
export function speakInBrowser(text, voiceName) {
  if (!window.speechSynthesis) throw new Error('このブラウザは読み上げに対応していません');
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
  const voice = browserVoices().find((v) => v.name === voiceName);
  if (voice) utter.voice = voice;
  utter.lang = voice?.lang || 'ja-JP';
  window.speechSynthesis.speak(utter);
}

const STORE_KEY = 'cft.tts';
let ctx = null;

export function ttsPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (saved.model && saved.voice) return saved;
  } catch {
    /* ignore */
  }
  return {
    model: ctx?.state?.defaults?.ttsModel || 'google/gemini-3.8-flash-tts',
    voice: ctx?.state?.defaults?.ttsVoice || 'Kore',
  };
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}

function voicesFor(model) {
  if (model === 'browser') return browserVoices().map((v) => v.name);
  return speechModels.find((m) => m.id === model)?.voices || [];
}

function renderVoices() {
  const prefs = ttsPrefs();
  const model = $('#tts-model').value || prefs.model;
  const voices = voicesFor(model);
  const active = voices.includes(prefs.voice) ? prefs.voice : voices[0];
  $('#tts-voices').innerHTML = voices
    .map((v) => '<button type="button" class="chip toggle" data-voice="' + v + '" data-on="' + (v === active ? 'true' : 'false') + '">' + v + '</button>')
    .join('');
  savePrefs({ model, voice: active });
}

export function initTts(context) {
  ctx = context;

  for (const btn of document.querySelectorAll('#voice-mode .seg-btn')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('#voice-mode .seg-btn')) b.classList.toggle('active', b === btn);
      const tts = btn.dataset.mode === 'tts';
      $('#asr-panel').hidden = tts;
      $('#tts-panel').hidden = !tts;
      if (tts) refreshModels();
    });
  }

  $('#tts-model').addEventListener('change', renderVoices);

  $('#tts-voices').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-voice]');
    if (!chip) return;
    for (const c of $('#tts-voices').children) c.dataset.on = String(c === chip);
    savePrefs({ model: $('#tts-model').value, voice: chip.dataset.voice });
  });

  $('#tts-test').addEventListener('click', async () => {
    const prefs = ttsPrefs();
    const btn = $('#tts-test');
    btn.disabled = true;
    $('#tts-status').textContent = '合成中…';
    try {
      const sample = $('#tts-sample').value.slice(0, 400);
      if (prefs.model === 'browser') {
        speakInBrowser(sample, prefs.voice);
        $('#tts-status').textContent = 'ブラウザ内蔵の音声で再生しました（無料）';
      } else {
        const res = await ctx.api('/api/tts', {
          method: 'POST',
          body: JSON.stringify({ text: sample, model: prefs.model, voice: prefs.voice }),
        });
        $('#tts-preview').src = res.url;
        $('#tts-preview').hidden = false;
        $('#tts-preview').play().catch(() => {});
        $('#tts-status').textContent =
          prefs.voice + ' / ' + res.chars + '文字' + (res.cost ? ' · ' + ctx.usd(res.cost) : '');
      }
    } catch (e) {
      $('#tts-status').textContent = '';
      ctx.toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

/** Populates the model list from the live catalogue, falling back to Orpheus. */
/** Pulls the live TTS catalogue; the browser voice is appended locally. */
export async function refreshModels() {
  const select = document.getElementById('tts-model');
  if (!select) return;
  if (!speechModels.length) {
    select.innerHTML = '<option>読み込み中…</option>';
    try {
      speechModels = (await ctx.api('/api/tts/models')).models || [];
    } catch {
      speechModels = [];
    }
    // Orpheus stays reachable for anyone who preferred it.
    speechModels.push(
      { id: 'canopylabs/orpheus-v1-english', name: 'Orpheus 英語（Groq）', voices: ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'] },
      { id: 'browser', name: 'ブラウザ内蔵（無料・オフライン）', voices: [] }
    );
  }

  const prefs = ttsPrefs();
  select.innerHTML = speechModels
    .map((m) => {
      const price = m.perMillionChars ? '　$' + m.perMillionChars.toFixed(2) + '/100万字' : m.free ? '　無料' : '';
      return (
        '<option value="' + m.id + '"' + (m.id === prefs.model ? ' selected' : '') + '>' +
        (m.name || m.id) + price + '</option>'
      );
    })
    .join('');
  renderVoices();
}