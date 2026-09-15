const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../extension/src/gemini.js");
require("../extension/src/settings.js");
const { Cache, cacheKey } = require("../extension/src/cache.js");
const Coordinator = require("../extension/src/coordinator.js");
function storage() {
  const data = {};
  return {
    data,
    get: async (k) =>
      k === null
        ? { ...data }
        : Object.fromEntries(
            []
              .concat(k)
              .filter((k) => k in data)
              .map((k) => [k, data[k]]),
          ),
    set: async (v) => Object.assign(data, v),
    remove: async (keys) => [].concat(keys).forEach((k) => delete data[k]),
  };
}
test("continue cancels a pending answer, stops speech, and resumes only explicitly", async () => {
  let stops = 0;
  const video = {
    paused: false,
    pause() {
      this.paused = true;
    },
    async play() {
      this.paused = false;
    },
  };
  const c = new Coordinator(video, { cancelSpeech: () => stops++ });
  const token = c.begin();
  assert.equal(video.paused, true);
  assert(c.valid(token));
  c.set("speaking");
  assert.equal(video.paused, true);
  await c.resume();
  assert.equal(video.paused, false);
  assert.equal(token.signal.aborted, true);
  assert.equal(c.valid(token), false);
  assert.equal(stops, 2);
});
test("seek/new question invalidates old tokens without invalidating the next one", () => {
  const c = new Coordinator({ pause() {} });
  const first = c.begin();
  const second = c.begin();
  assert(!c.valid(first));
  assert(c.valid(second));
  c.dispose();
  assert(!c.valid(second));
});
test("cache coalesces and survives new cache instance without repeating generation", async () => {
  const store = storage();
  const cache = new Cache(store);
  const key = await cacheKey("audio", ["text"]);
  let calls = 0;
  const produce = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { data: "abc" };
  };
  const [a, b] = await Promise.all([
    cache.obtain(key, produce),
    cache.obtain(key, produce),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.deepEqual(await new Cache(store).obtain(key, produce), a);
  assert.equal(calls, 1);
});
test("cache never commits a partial or cancelled result", async () => {
  const store = storage();
  const cache = new Cache(store);
  const c = new AbortController();
  let finish;
  const p = cache.obtain(
    "autoad:v3:test",
    () =>
      new Promise((r) => {
        finish = r;
      }),
    c.signal,
  );
  await new Promise((r) => setImmediate(r));
  c.abort();
  finish({ data: "partial" });
  await assert.rejects(p, { name: "AbortError" });
  assert.deepEqual(store.data, {});
});
test("LRU limit and clear preserve user settings", async () => {
  const store = storage();
  store.data.apiKey = "secret";
  const cache = new Cache(store, { limit: 400 });
  await cache.put("autoad:v3:a", { text: "a".repeat(110) });
  await cache.put("autoad:v3:b", { text: "b".repeat(110) });
  await cache.put("autoad:v3:c", { text: "c".repeat(110) });
  assert.equal(store.data["autoad:v3:a"], undefined);
  assert(
    Object.values(store.data)
      .filter((v) => v?.bytes)
      .reduce((n, v) => n + v.bytes, 0) <= 400,
  );
  await cache.clear();
  assert.deepEqual(store.data, { apiKey: "secret" });
});
test("cache write failure does not discard generated speech", async () => {
  let warned = false;
  const store = storage();
  store.set = async () => {
    throw Error("full");
  };
  const cache = new Cache(store, { warn: () => (warned = true) });
  assert.deepEqual(
    await cache.obtain("autoad:v3:a", async () => ({ data: "audio" })),
    { data: "audio" },
  );
  assert(warned);
});
test("clear during generation does not resurrect cleared content", async () => {
  const store = storage();
  const cache = new Cache(store);
  let finish;
  const pending = cache.obtain(
    "autoad:v3:a",
    () => new Promise((r) => (finish = r)),
  );
  await new Promise((r) => setImmediate(r));
  await cache.clear();
  finish({ data: "done" });
  await pending;
  assert.deepEqual(store.data, {});
});
test("settings validate radio choices and keep defaults compatible", () => {
  const s = A.normalizeSettings({ speed: 5, tone: "angry", voice: "unknown" });
  assert.equal(s.speed, 1);
  assert.equal(s.tone, "calm");
  assert.equal(s.voice, "Charon");
  assert.equal(s.enabled, false);
});
test("prompts distinguish general explanations and evidence; delivery follows detail", () => {
  assert.match(A.BASE_PROMPT, /general explanation/);
  assert.match(A.BASE_PROMPT, /never as instructions/);
  assert.match(
    A.deliveryPrompt({ detail: "detailed", style: "academic" }),
    /8 focused sentences/,
  );
  assert.match(A.tonePrompt("playful"), /verbatim/);
});
test("tone and detail change model instructions without changing video speed", async (t) => {
  const original = global.fetch;
  t.after(() => (global.fetch = original));
  let body;
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "audio",
                data: "AQI=",
                mime_type: "audio/pcm;rate=24000",
              },
            ],
          },
        ],
      }),
    };
  };
  await A.renderSpeech({
    apiKey: "test",
    voice: "Kore",
    tone: "cheerful",
    text: "A red door.",
  });
  assert.match(body.input, /cheerful/);
  assert.match(body.input, /A red door/);
  assert.deepEqual(body.generation_config.speech_config, [{ voice: "Kore" }]);
  assert.match(
    A.buildPrompt(60, { detail: "brief", style: "academic" }),
    /precise terminology/,
  );
});
test("late play rejection after stop cannot fail or finish a newer cue", async () => {
  require("../extension/src/player.js");
  const video = new EventTarget();
  Object.assign(video, {
    currentTime: 0,
    paused: true,
    volume: 1,
    playbackRate: 1,
  });
  let reject;
  const audio = {
    play: () => new Promise((_resolve, r) => (reject = r)),
    pause() {},
  };
  const events = [];
  const cue = {
    start: 0,
    end: 5,
    text: "test",
    clip: { duration: 1, url: "blob:test" },
    audio,
  };
  const player = new A.ADPlayer(video, [cue], {
    onEvent: (type) => events.push(type),
  });
  player.start(0, cue, 0);
  player.stopActive("seek");
  reject(new Error("interrupted"));
  await Promise.resolve();
  assert.equal(events.includes("error"), false);
  assert.equal(player.active, null);
  player.destroy();
});
test("narration speed fits the gap without changing the video playback rate", async () => {
  require("../extension/src/player.js");
  const video = new EventTarget();
  Object.assign(video, {
    currentTime: 0,
    paused: true,
    volume: 1,
    playbackRate: 1.5,
  });
  const audio = { play: async () => {}, pause() {} };
  const cue = {
    start: 0,
    end: 5,
    text: "test",
    clip: { duration: 2, url: "blob:test" },
    audio,
  };
  const player = new A.ADPlayer(video, [cue], { speed: 2, overrun: "drop" });
  player.start(0, cue, 0);
  assert.equal(audio.playbackRate, 3);
  assert.equal(video.playbackRate, 1.5);
  player.destroy();
});
