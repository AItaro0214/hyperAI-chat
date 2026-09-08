import { Hono } from 'hono';
import { requireAuth } from '../lib/guard.js';
import { getCatalog, getGroqPricing, toolPricing, FAMILIES } from '../lib/models.js';
import { applyDiscount, estimateVideoCost, fetchVideoModels } from '../lib/video.js';
import { getSettings } from '../lib/store.js';
import { fetchSpeechModels } from '../lib/speech.js';

const catalog = new Hono();
catalog.use('/models', requireAuth);
catalog.use('/pricing', requireAuth);
catalog.use('/settings', requireAuth);

catalog.get('/models', async (c) => {
  const force = c.req.query('refresh') === '1';
  const data = await getCatalog(c.env, { force });
  const settings = await getSettings(c.env);
  return c.json({
    models: data.models,
    families: FAMILIES,
    errors: data.errors,
    updatedAt: data.updatedAt,
    defaults: {
      provider: settings.defaultProvider,
      model: settings.defaultModel,
      asrModel: settings.asrModel,
      ttsModel: settings.ttsModel,
      ttsVoice: settings.ttsVoice,
      imageModel: settings.imageModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      systemPrompt: settings.systemPrompt,
      webSearchDefault: settings.webSearchDefault,
      webSearchEngine: settings.webSearchEngine,
      webSearchMaxResults: settings.webSearchMaxResults,
    },
  });
});

// Read-only view of the settings the chat UI needs.
catalog.get('/settings', async (c) => {
  const settings = await getSettings(c.env);
  return c.json({ settings });
});

catalog.get('/pricing', async (c) => {
  const data = await getCatalog(c.env);
  const groqTable = await getGroqPricing(c.env);
  const models = data.models.map((m) => ({
    ref: m.ref,
    provider: m.provider,
    id: m.id,
    name: m.name,
    family: m.family,
    kind: m.kind,
    free: !!m.free,
    context: m.context,
    input: m.input,
    output: m.output,
    pricing: m.pricing,
  }));
  // Video models live behind their own listing and never appear in the chat
  // catalogue, so they are fetched separately for the pricing view.
  let videoModels = [];
  try {
    videoModels = (await fetchVideoModels(c.env)).map((m) => {
      // A concrete "one clip costs this" figure. Some models declare no
      // durations or resolutions, so a 5s / 720p reference clip is used.
      const resolution = m.resolutions?.includes('720p') ? '720p' : m.resolutions?.[0] || '720p';
      const duration = m.durations?.includes(5) ? 5 : m.durations?.[0] || 5;
      const cost = estimateVideoCost(m, { resolution, duration, generateAudio: m.generateAudio });
      // Token-priced models are impossible to compare by eye, so every model
      // also gets a per-second figure at the same reference resolution.
      const perSecond = estimateVideoCost(m, { resolution, duration: 1, generateAudio: m.generateAudio });
      return {
        id: m.id,
        name: m.name,
        resolutions: m.resolutions,
        durations: m.durations,
        generateAudio: m.generateAudio,
        pricing: m.pricing,
        rates: m.rates,
        discount: m.discount || 0,
        example: cost == null ? null : { resolution, duration, cost: applyDiscount(cost, m.discount), list: cost },
        perSecond: perSecond == null ? null : { resolution, cost: applyDiscount(perSecond, m.discount), list: perSecond },
      };
    });
  } catch (e) {
    data.errors.push('video: ' + e.message);
  }

  // TTS models carry the `speech` output modality and are absent from the main
  // catalogue, so they are fetched separately for the pricing view.
  let speechModels = [];
  try {
    speechModels = (await fetchSpeechModels(c.env)).map((m) => ({
      id: m.id,
      name: m.name,
      free: m.free,
      perMillionChars: m.perMillionChars,
      voices: m.voices.length,
    }));
  } catch (e) {
    data.errors.push('speech: ' + e.message);
  }

  return c.json({
    models,
    videoModels,
    speechModels,
    families: FAMILIES,
    groq: {
      as_of: groqTable.as_of,
      source: groqTable.source,
      note: groqTable.note,
      tools: groqTable.tools,
      // Shipped rates for speech models, which the live Groq listing may omit.
      speech: Object.entries(groqTable.models || {})
        .filter(([, v]) => v.kind === 'asr' || v.kind === 'tts')
        .map(([id, v]) => ({ id, ...v })),
    },
    tools: toolPricing(),
    errors: data.errors,
    updatedAt: data.updatedAt,
  });
});

export default catalog;
