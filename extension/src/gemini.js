// Gemini calls for AutoAD: one video call -> timed AD track, one TTS call per line.
// Classic script: runs as a content script (globalThis.AutoAD) and in Node via require().
(function (root) {
  const API = 'https://generativelanguage.googleapis.com/v1beta/interactions';

  const DEFAULTS = {
    videoModel: 'gemini-3.8-flash',
    ttsModel: 'gemini-3.1-flash-tts-preview',
    voice: 'Charon',
  };

  // Shared by the prompt (word budget), the player (fit) and the probe (report).
  const TIMING = {
    wordsPerSec: 2.5, // ~150 wpm narrator
    promptMargin: 0.5, // seconds the prompt reserves at the end of each gap
    playMargin: 0.3, // seconds the player keeps clear before speech resumes
    maxFit: 1.3, // max speed-up applied to a clip that is longer than its gap
  };

  const TTS_DIRECTION = 'Read as a calm, clear audio-description narrator at a brisk, even pace: ';

  const TRACK_SCHEMA = {
    type: 'object',
    properties: {
      cues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'When speech stops, MM:SS.s' },
            end: { type: 'string', description: 'When speech resumes, MM:SS.s' },
            max_words: { type: 'integer', description: 'floor((end - start - 0.5) * 2.5)' },
            text: { type: 'string', description: 'The description, at most max_words words' },
          },
          required: ['start', 'end', 'max_words', 'text'],
        },
      },
    },
    required: ['cues'],
  };

  function buildPrompt(durationSec) {
    const wps = TIMING.wordsPerSec;
    const m = TIMING.promptMargin;
    return [
      'You are a professional audio describer writing an audio-description track for blind and low-vision viewers of this video.',
      '',
      'Listen to the soundtrack and find the gaps: stretches of at least 1.5 seconds where nobody is speaking, narrating or singing lyrics. Music, sound effects and ambience are fine inside a gap.',
      '',
      'For each gap, decide whether something visual happens that a listener would miss: actions, people appearing or leaving, scene or location changes, expressions that matter, on-screen text (titles, captions, signs, names). If nothing important is visible, or the sound already makes it obvious, leave that gap out. Prefer fewer, useful cues over describing everything.',
      '',
      'Timing rules (critical: each line is spoken inside its gap and must finish before speech resumes):',
      '- start = the moment speech stops; end = the moment speech resumes (or the video ends). Use the video timeline, format MM:SS.s (e.g. 01:07.5).',
      `- The narrator speaks at about ${Math.round(wps * 60)} words per minute (${wps} words per second).`,
      `- max_words = floor((end - start - ${m}) * ${wps}). Work it out before writing the text.`,
      '- text must have at most max_words words. If max_words is below 3, skip the gap.',
      '- Cues are in chronological order and never overlap.',
      '',
      'Style: present tense, concise and concrete. Never say "we see" or "the camera shows". Use names only once they have been said or shown; otherwise describe briefly ("a woman in a red coat"). Quote on-screen text exactly.',
      durationSec ? `\nThe video is ${formatTime(durationSec)} long.` : '',
    ].join('\n');
  }

  async function generateTrack({ apiKey, model = DEFAULTS.videoModel, videoUrl, durationSec, signal }) {
    const t0 = Date.now();
    const res = await callApi(apiKey, {
      model,
      input: [
        { type: 'video', uri: videoUrl },
        { type: 'text', text: buildPrompt(durationSec) },
      ],
      response_format: { type: 'text', mime_type: 'application/json', schema: TRACK_SCHEMA },
    }, signal);
    const text = findContent(res, 'text').map((c) => c.text).join('');
    if (!text) throw new Error('No text output in response: ' + summarize(res));
    const parsed = JSON.parse(text);
    return { cues: normalizeCues(parsed.cues, durationSec), usage: res.usage, ms: Date.now() - t0 };
  }

  async function renderSpeech({ apiKey, model = DEFAULTS.ttsModel, voice = DEFAULTS.voice, text, signal }) {
    const res = await callApi(apiKey, {
      model,
      input: TTS_DIRECTION + text,
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    }, signal);
    const audio = findContent(res, 'audio').find((c) => c.data);
    if (!audio) throw new Error('No audio in response: ' + summarize(res));
    const rate = Number(/rate=(\d+)/.exec(audio.mime_type || '')?.[1]) || 24000;
    return { data: audio.data, rate, response: res };
  }

  // Content blocks of one type from the model's output steps (skips thoughts and user input).
  function findContent(res, type) {
    const out = [];
    const take = (items) => {
      for (const c of items || []) if (c && c.type === type) out.push(c);
    };
    for (const step of res.steps || []) if (!step.type || step.type === 'model_output') take(step.content);
    take(res.outputs);
    if (type === 'text' && !out.length && typeof res.output_text === 'string') out.push({ type, text: res.output_text });
    return out;
  }

  class ApiError extends Error {
    constructor(status, body) {
      let message = body;
      try {
        message = JSON.parse(body).error?.message || body;
      } catch {}
      super(`Gemini ${status}: ${String(message).slice(0, 300)}`);
      this.status = status;
      this.body = body;
    }
  }

  async function callApi(apiKey, body, signal, tries = 5) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal,
      });
      if (res.ok) return res.json();
      const text = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= tries - 1) throw new ApiError(res.status, text);
      await sleep(retryDelayMs(text, attempt), signal);
    }
  }

  // Honors RetryInfo.retryDelay ("31s") when present, else exponential backoff with jitter.
  function retryDelayMs(errorBody, attempt) {
    try {
      const details = JSON.parse(errorBody).error?.details || [];
      const delay = details.find((d) => d.retryDelay)?.retryDelay;
      if (delay) return Math.min(60000, parseFloat(delay) * 1000 + 250);
    } catch {}
    return Math.min(60000, 2000 * 2 ** attempt + Math.random() * 500);
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason);
      }, { once: true });
    });
  }

  function parseTime(value) {
    if (typeof value === 'number') return value;
    const parts = String(value).trim().split(':').map(Number);
    if (!parts.length || parts.some(Number.isNaN)) return NaN;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = (sec - m * 60).toFixed(1).padStart(4, '0');
    return `${String(m).padStart(2, '0')}:${s}`;
  }

  // Seconds, sorted, non-overlapping, inside the video.
  function normalizeCues(cues, durationSec) {
    const sorted = (cues || [])
      .map((c) => ({ start: parseTime(c.start), end: parseTime(c.end), maxWords: c.max_words, text: String(c.text || '').trim() }))
      .filter((c) => c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
      .sort((a, b) => a.start - b.start);
    const out = [];
    for (const c of sorted) {
      if (durationSec && c.start >= durationSec) continue;
      if (durationSec) c.end = Math.min(c.end, durationSec);
      const prev = out[out.length - 1];
      if (prev && c.start < prev.end) continue;
      out.push(c);
    }
    return out;
  }

  const countWords = (text) => (text.match(/\S+/g) || []).length;
  const wordBudget = (cue) => Math.floor((cue.end - cue.start - TIMING.promptMargin) * TIMING.wordsPerSec);

  // JSON with long strings (base64 audio) truncated, for logging response shapes.
  function summarize(value) {
    return JSON.stringify(value, (k, v) => (typeof v === 'string' && v.length > 120 ? `${v.slice(0, 40)}…(${v.length} chars)` : v));
  }

  const AutoAD = root.AutoAD || (root.AutoAD = {});
  Object.assign(AutoAD, {
    DEFAULTS, TIMING, TRACK_SCHEMA, ApiError,
    buildPrompt, generateTrack, renderSpeech, findContent,
    parseTime, formatTime, normalizeCues, countWords, wordBudget, summarize,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = AutoAD;
})(globalThis);
