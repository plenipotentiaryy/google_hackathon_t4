// YouTube glue: on each watch page, load or generate the AD track, voice it with Gemini TTS,
// and hand it to ADPlayer. Everything runs here in the content script: Gemini allows CORS
// from youtube.com, and a service worker would be killed during the long video call.
(function () {
  const A = globalThis.AutoAD;
  const SETTING_KEYS = ['apiKey', 'videoModel', 'ttsModel', 'voice', 'enabled'];
  const NAV_DEBOUNCE_MS = 1500; // don't spend quota on videos clicked straight past
  const TTS_CONCURRENCY = 2;

  const log = (...args) => console.log('%c[AutoAD]', 'color:#3ea6ff;font-weight:bold', ...args);

  let settings = { ...A.DEFAULTS, apiKey: '', enabled: true };
  let session = null; // {id, abort, status, player, voiced, failed, error, t0, adObserver}
  let navTimer = 0;
  let lastHref = location.href;

  const videoId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);
  const adShowing = () => !!document.querySelector('#movie_player.ad-showing');

  // ---------- navigation ----------

  function schedule(delay = NAV_DEBOUNCE_MS) {
    clearTimeout(navTimer);
    navTimer = setTimeout(onNavigate, delay);
  }

  function restart() {
    teardown();
    schedule(0);
  }

  // Silence immediately; decide after the navigation lands whether this is still the same video.
  document.addEventListener('yt-navigate-start', () => session?.player?.suspend());
  document.addEventListener('yt-navigate-finish', () => {
    lastHref = location.href;
    schedule();
  });
  // Fallback in case YouTube renames its navigation events.
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    schedule();
  }, 1000);

  async function onNavigate() {
    const id = videoId();
    if (session && session.id === id) {
      if (session.player && !adShowing()) session.player.resume();
      return;
    }
    teardown();
    if (!id) return;
    const s = (session = { id, abort: new AbortController(), status: 'loading', voiced: 0, failed: 0 });
    ui.mount();
    if (!settings.apiKey || !settings.enabled) return ui.render();

    const video = await findVideo(s);
    if (session !== s) return;
    if (!video) return fail(s, new Error('YouTube video element not found'));
    ui.mount();
    if (video.duration === Infinity || document.querySelector('#movie_player.ytp-live')) {
      s.status = 'live';
      return ui.render();
    }

    let cues = (await chrome.storage.local.get(`cues:${id}`))[`cues:${id}`]?.cues;
    if (cues) log(`track for ${id} from cache: ${cues.length} lines`);
    else {
      s.status = 'analyzing';
      s.t0 = Date.now();
      ui.render();
      try {
        const track = await A.generateTrack({
          apiKey: settings.apiKey,
          model: settings.videoModel,
          videoUrl: `https://www.youtube.com/watch?v=${id}`,
          durationSec: adShowing() ? undefined : video.duration, // during a pre-roll the duration is the ad's
          signal: s.abort.signal,
        });
        cues = track.cues;
        log(`track for ${id}: ${cues.length} lines in ${(track.ms / 1000).toFixed(1)}s`, track.usage);
        await chrome.storage.local.set({ [`cues:${id}`]: { cues, model: settings.videoModel, at: Date.now() } });
      } catch (err) {
        return fail(s, err);
      }
    }
    if (session !== s) return;
    console.table(cues.map((c) => ({ start: A.formatTime(c.start), end: A.formatTime(c.end), budget: A.wordBudget(c), words: A.countWords(c.text), text: c.text })));

    s.player = new A.ADPlayer(video, cues.map((c) => ({ ...c })), { onEvent: (type, d) => onPlayerEvent(type, d) });
    s.player.setEnabled(settings.enabled);
    watchAds(s);
    s.status = 'voicing';
    ui.render();
    await voice(s);
    if (session !== s) return;
    s.status = 'on';
    ui.render();
    log(`voiced ${s.voiced}/${cues.length} lines${s.failed ? `, ${s.failed} failed` : ''}`);
  }

  async function findVideo(s) {
    for (let k = 0; k < 50 && session === s; k++) {
      const v = document.querySelector('#movie_player video.html5-main-video');
      if (v && v.readyState >= 1) return v;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  function fail(s, err) {
    if (s.abort.signal.aborted || session !== s) return;
    log('error:', err);
    s.status = 'error';
    s.error = err.message;
    ui.render();
  }

  function teardown() {
    if (!session) return;
    session.abort.abort();
    session.player?.destroy();
    session.adObserver?.disconnect();
    session = null;
    ui.line('');
    ui.render();
  }

  // ---------- voicing ----------

  async function voice(s) {
    const cues = s.player.cues;
    const keys = cues.map((_, i) => `tts:${s.id}:${i}`);
    const cached = await chrome.storage.local.get(keys);
    const todo = [];
    cues.forEach((c, i) => {
      const hit = cached[keys[i]];
      if (hit && hit.text === c.text && hit.voice === settings.voice) attach(s, i, hit);
      else todo.push(i);
    });

    const worker = async () => {
      while (todo.length && session === s) {
        const i = takeNearest(todo, cues, s.player.video.currentTime);
        try {
          const { data, rate } = await A.renderSpeech({
            apiKey: settings.apiKey, model: settings.ttsModel, voice: settings.voice, text: cues[i].text, signal: s.abort.signal,
          });
          if (session !== s) return;
          const entry = { text: cues[i].text, voice: settings.voice, data, rate };
          attach(s, i, entry);
          chrome.storage.local.set({ [keys[i]]: entry });
        } catch (err) {
          if (s.abort.signal.aborted) return;
          s.failed++;
          log(`voicing line ${i + 1} failed:`, err.message);
        }
      }
    };
    await Promise.all(Array.from({ length: TTS_CONCURRENCY }, worker));
  }

  function attach(s, i, { data, rate }) {
    s.player.setClip(i, A.pcmToClip(data, rate));
    s.voiced++;
    ui.render();
  }

  // Upcoming lines first, starting at the playhead; lines already passed go last.
  function takeNearest(todo, cues, t) {
    const rank = (i) => (cues[i].end >= t ? cues[i].start : 1e9 + cues[i].start);
    let best = 0;
    for (let k = 1; k < todo.length; k++) if (rank(todo[k]) < rank(todo[best])) best = k;
    return todo.splice(best, 1)[0];
  }

  // ---------- ads & player events ----------

  function watchAds(s) {
    const mp = document.querySelector('#movie_player');
    if (!mp) return;
    let wasAd = null;
    const check = () => {
      const ad = mp.classList.contains('ad-showing');
      if (ad === wasAd) return;
      wasAd = ad;
      if (ad) s.player.suspend();
      else s.player.resume();
      log(ad ? 'ad playing: AD suspended' : 'content playing: AD active');
    };
    s.adObserver = new MutationObserver(check);
    s.adObserver.observe(mp, { attributes: true, attributeFilter: ['class'] });
    check();
  }

  function onPlayerEvent(type, d) {
    const at = A.formatTime(d.t);
    const n = d.i + 1;
    if (type === 'start') {
      ui.line(d.cue.text);
      log(`${at} ▶ line ${n}${d.fit > 1 ? ` (sped up ×${d.fit.toFixed(2)})` : ''}: ${d.cue.text}`);
    } else if (type === 'end' || type === 'stop') {
      ui.line('');
    }
    if (type === 'hold') log(`${at} ⏸ holding video for line ${n} (needed ×${d.need.toFixed(2)})`);
    if (type === 'not-ready') log(`${at} line ${n} skipped: not voiced yet`);
    if (type === 'error') log(`${at} line ${n} could not play:`, d.error);
  }

  // ---------- UI: one toggle button + the current line (visual only) inside the player ----------

  const ui = {
    root: null,
    btn: null,
    lineEl: null,
    timer: 0,

    mount() {
      const mp = document.querySelector('#movie_player');
      if (!mp) return;
      if (!this.root) {
        this.root = document.createElement('div');
        this.root.className = 'autoad-ui';
        this.btn = document.createElement('button');
        this.btn.type = 'button';
        this.btn.className = 'autoad-btn';
        // Keep clicks and keys from reaching YouTube's play/pause and shortcut handlers.
        for (const t of ['click', 'mousedown', 'mouseup', 'dblclick', 'keydown', 'keyup']) this.btn.addEventListener(t, (e) => e.stopPropagation());
        this.btn.addEventListener('click', onButton);
        // Not aria-live: a screen reader reading this would talk over the spoken description.
        this.lineEl = document.createElement('div');
        this.lineEl.className = 'autoad-line';
        this.root.append(this.btn, this.lineEl);
      }
      if (this.root.parentNode !== mp) mp.append(this.root);
      clearInterval(this.timer);
      this.timer = setInterval(() => session?.status === 'analyzing' && this.render(), 1000);
      this.render();
    },

    render() {
      if (!this.root) return;
      const s = session;
      this.root.hidden = !s;
      if (!s) return;
      let text;
      let state = 'busy';
      if (!settings.apiKey) [text, state] = ['AD · add a Gemini API key (AutoAD toolbar icon)', 'error'];
      else if (s.status === 'error') [text, state] = ['AD · failed, click to retry', 'error'];
      else if (s.status === 'live') [text, state] = ['AD · live streams not supported', 'off'];
      else if (!settings.enabled) [text, state] = ['AD off', 'off'];
      else if (s.status === 'analyzing') text = `AD · analyzing video… ${Math.round((Date.now() - s.t0) / 1000)}s`;
      else if (s.status === 'voicing') text = `AD on · voicing ${s.voiced}/${s.player.cues.length}`;
      else if (s.status === 'on') [text, state] = [`AD on · ${s.player.cues.length} lines`, 'on'];
      else text = 'AD · loading…';
      this.btn.textContent = text;
      this.btn.dataset.state = state;
      this.btn.title = s.error || 'Toggle audio description';
      this.btn.setAttribute('aria-pressed', String(!!settings.enabled));
    },

    line(text) {
      if (this.lineEl) this.lineEl.textContent = text;
    },
  };

  function onButton() {
    if (!settings.apiKey) return;
    if (session?.status === 'error') return restart();
    chrome.storage.local.set({ enabled: !settings.enabled }); // storage.onChanged applies it
  }

  // ---------- settings ----------

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !SETTING_KEYS.some((k) => k in changes)) return;
    await loadSettings();
    const toggleOnly = Object.keys(changes).every((k) => k === 'enabled');
    if (toggleOnly && session && (session.player || session.status === 'analyzing')) {
      session.player?.setEnabled(settings.enabled);
      ui.render();
    } else {
      restart();
    }
  });

  async function loadSettings() {
    const stored = await chrome.storage.local.get(SETTING_KEYS);
    settings = { ...A.DEFAULTS, apiKey: '', enabled: true };
    for (const k of SETTING_KEYS) if (stored[k] !== undefined && stored[k] !== '') settings[k] = stored[k];
  }

  loadSettings().then(() => schedule(500));
})();
