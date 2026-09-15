// AutoAD page coordinator. Model output is text, never markup or instructions.
(function () {
  const A = globalThis.AutoAD;
  const SETTING_KEYS = Object.keys(A.DEFAULT_SETTINGS);
  let settings = { ...A.DEFAULT_SETTINGS };
  let session = null,
    navTimer,
    lastHref = location.href;
  const log = () => {}; // Do not log questions, API keys or video-derived content.
  const videoId = () =>
    location.pathname === "/watch"
      ? new URLSearchParams(location.search).get("v")
      : null;
  const adShowing = () => !!document.querySelector("#movie_player.ad-showing");
  const valid = (s, token) =>
    session === s &&
    !s.abort.signal.aborted &&
    (!token || s.control.valid(token));
  const panel = new A.Panel({
    main: () => {
      const s = session;
      if (!s) return;
      if (s.control?.state === "error") (s.retryAction || (() => prepare(s)))();
      else if (
        [
          "ready",
          "paused",
          "speaking",
          "recording",
          "waiting",
          "starting",
        ].includes(s.control?.state)
      )
        continueVideo(s);
      else if (!s.enabled) prepare(s);
      else disable(s);
    },
    continue: () => continueVideo(session),
    voice: () => {
      if (session?.liveMicState === "recording") stopVoiceQuestion(session);
      else startVoiceQuestion(session);
    },
    describe: () =>
      askAboutMoment(
        "Describe this moment and what happened immediately before it.",
      ),
    send: () => askAboutMoment(panel.question()),
    repeat: () => repeat(session),
    preview: () => previewVoice(session),
    setting: (key, value) => saveSetting(key, value),
    clear: async () => {
      try {
        await cache.clear();
        panel.notice("Cached descriptions cleared.");
      } catch {
        panel.notice("Could not clear cache. Try again.");
      }
    },
    gemini: () => {
      session?.control?.pause();
      window.open(
        "https://gemini.google.com/",
        "_blank",
        "noopener,noreferrer",
      );
    },
    copy: async () => {
      const s = session;
      if (!s) return;
      try {
        await navigator.clipboard.writeText(
          `YouTube: https://www.youtube.com/watch?v=${s.id}\nTimestamp: ${A.formatTime(s.video?.currentTime || 0)}\n` +
            s.sceneChat
              .slice(-4)
              .map((t) => `Viewer: ${t.question}\nAutoAD: ${t.answer}`)
              .join("\n"),
        );
        panel.notice("Discussion context copied. Paste it into Gemini.");
      } catch {
        panel.notice("Clipboard unavailable. Copy the video link manually.");
      }
    },
  });
  const ui = {
    render: () => panel.update(session, settings),
    answer: (text) => panel.text(text),
    line: (text) => {
      if (text) panel.text(text);
    },
    clearQuestion: () => panel.clearQuestion(),
  };
  const cache = new A.Cache(chrome.storage.local, {
    warn: (message) => panel.notice(message),
  });
  function schedule(delay = 500) {
    clearTimeout(navTimer);
    navTimer = setTimeout(onNavigate, delay);
  }
  function teardown() {
    if (!session) return;
    const s = session;
    s.abort.abort();
    s.prepareAbort?.abort();
    s.control?.dispose();
    s.player?.destroy();
    s.adObserver?.disconnect();
    for (const [event, fn] of Object.entries(s.handlers || {}))
      s.video.removeEventListener(event, fn);
    session = null;
    ui.render();
  }
  document.addEventListener("yt-navigate-start", () => {
    teardown();
  });
  document.addEventListener("yt-navigate-finish", () => {
    lastHref = location.href;
    schedule();
  });
  const navigationTimer = setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      teardown();
      schedule();
    }
  }, 1000);
  window.addEventListener("pagehide", () => {
    clearTimeout(navTimer);
    clearInterval(navigationTimer);
    teardown();
  });
  async function onNavigate() {
    const id = videoId();
    if (session?.id === id) return;
    teardown();
    if (!id) return;
    const s = (session = {
      id,
      abort: new AbortController(),
      enabled: false,
      sceneChat: [],
      sceneTime: null,
      liveMicState: "idle",
      asking: false,
    });
    ui.render();
    for (let i = 0; i < 50 && valid(s); i++) {
      const v = document.querySelector("#movie_player video.html5-main-video");
      if (v && v.readyState >= 1) {
        s.video = v;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!valid(s)) return;
    if (!s.video) {
      s.error = "YouTube player unavailable. Reload this page.";
      return ui.render();
    }
    s.control = new A.Coordinator(s.video, {
      cancelSpeech: () => {
        clearTimeout(s.answerTimeout);
        stopMomentAudio(s);
        stopLiveVoice(s);
        s.player?.stopActive("control");
        s.asking = false;
      },
      changed: () => ui.render(),
    });
    s.handlers = {
      seeking: () => {
        const preparing = s.control.state === "preparing";
        s.control.pause(preparing ? "preparing" : "paused");
        s.sceneChat = [];
        s.sceneTime = null;
        s.lastSpeech = null;
        ui.answer("Position changed. Ask about this scene or continue video.");
        if (s.control.state === "preparing") checkReady(s);
      },
      play: () => {
        s.control.cancel();
        s.control.set("watching");
      },
      pause: () => {
        if (s.control.state === "watching") s.control.set("paused");
      },
    };
    for (const [event, fn] of Object.entries(s.handlers))
      s.video.addEventListener(event, fn);
    const mp = document.querySelector("#movie_player");
    s.adObserver = new MutationObserver(() => {
      if (adShowing()) {
        s.control.cancel();
        s.player?.suspend();
        s.control.set("ad");
      } else if (s.control.state === "ad") {
        s.player?.resume();
        s.control.set(s.video.paused ? "paused" : "watching");
      }
    });
    s.adObserver.observe(mp, { attributes: true, attributeFilter: ["class"] });
    ui.render();
    // Stored preferences do not automatically spend quota on every navigation.
  }
  function fail(s, error, retry) {
    s.retryAction = retry;
    if (!valid(s)) return;
    s.error = String(error.message || error).replaceAll(
      settings.apiKey || "\0",
      "[redacted]",
    );
    s.control?.pause("error");
    ui.render();
  }
  function disable(s) {
    s.enabled = false;
    s.prepareAbort?.abort();
    s.control.cancel();
    s.player?.setEnabled(false);
    s.control.set("off");
  }
  async function continueVideo(s) {
    if (!s?.control) return;
    s.error = "";
    s.player?.setEnabled(s.enabled);
    if (!adShowing()) s.player?.resume();
    try {
      await s.control.resume();
    } catch (e) {
      fail(s, e);
    }
  }
  function beginQuestion(s, state = "waiting") {
    s.error = "";
    const time = s.video.currentTime;
    if (s.sceneTime === null || Math.abs(time - s.sceneTime) > 0.1)
      s.sceneChat = [];
    s.sceneTime = time;
    const token = s.control.begin(state);
    s.answerTimeout = setTimeout(() => {
      if (valid(s, token))
        fail(s, new Error("Question timed out. Retry or continue video."), () =>
          startVoiceQuestion(s),
        );
    }, 90000);
    return token;
  }
  function speechKey(text, prefs = settings) {
    return A.cacheKey("audio", [
      A.TTS_CACHE_VERSION,
      prefs.ttsModel,
      prefs.voice,
      prefs.tone,
      text,
    ]);
  }
  async function speech(text, signal, prefs = { ...settings }) {
    const key = await speechKey(text, prefs);
    return cache.obtain(
      key,
      async () => {
        const { data, rate } = await A.renderSpeech({
          apiKey: prefs.apiKey,
          model: prefs.ttsModel,
          voice: prefs.voice,
          tone: prefs.tone,
          text,
          signal,
        });
        return { data, rate, text };
      },
      signal,
    );
  }
  async function prepare(s) {
    if (!s?.video || !settings.apiKey) return;
    s.retryAction = () => prepare(s);
    s.prepareAbort?.abort();
    s.prepareAbort = new AbortController();
    const signal = s.prepareAbort.signal;
    s.enabled = true;
    s.error = "";
    s.noGaps = false;
    s.control.pause("preparing");
    s.player?.destroy();
    s.player = null;
    if (!Number.isFinite(s.video.duration)) {
      return fail(
        s,
        new Error("Live streams are not supported. Choose a recorded video."),
      );
    }
    if (adShowing()) {
      s.control.set("ad");
      s.enabled = false;
      return;
    }
    const prefs = { ...settings };
    s.preparedSettings = prefs;
    const params = {
      apiKey: prefs.apiKey,
      model: prefs.videoModel,
      videoUrl: `https://www.youtube.com/watch?v=${s.id}`,
      durationSec: s.video.duration,
      preferences: prefs,
      signal,
    };
    s.sceneIndexPromise = (async () => {
      const key = await A.cacheKey("scenes", [
        s.id,
        A.SCENE_INDEX_VERSION,
        prefs.videoModel,
      ]);
      const result = await cache.obtain(
        key,
        () => A.generateSceneIndex(params),
        signal,
      );
      if (valid(s) && !signal.aborted) s.sceneDescriptions = result.scenes;
    })().catch(() => {});
    try {
      const key = await A.cacheKey("track", [
        s.id,
        A.TRACK_CACHE_VERSION,
        prefs.videoModel,
        prefs.detail,
        prefs.style,
      ]);
      const track = await cache.obtain(
        key,
        () => A.generateTrack(params),
        signal,
      );
      if (!valid(s) || signal.aborted) return;
      s.cues = track.cues;
      s.voiced = new Set();
      s.failed = new Set();
      s.voicingDone = false;
      s.player = new A.ADPlayer(
        s.video,
        s.cues.map((c) => ({ ...c })),
        {
          overrun: "drop",
          speed: settings.speed,
          onEvent: (type, d) => {
            if (!valid(s)) return;
            if (type === "start") {
              ui.line(d.cue.text);
              s.lastSpeech = d.cue.saved;
              ui.render();
            }
            if (type === "error")
              fail(
                s,
                new Error(
                  "Description audio could not play. Retry or continue video.",
                ),
              );
          },
        },
      );
      s.player.setEnabled(true);
      checkReady(s);
      const todo = s.cues.map((_, i) => i);
      const worker = async () => {
        while (todo.length && valid(s) && !signal.aborted) {
          const i = takeNearest(todo, s.cues, s.video.currentTime);
          try {
            const entry = await speech(s.cues[i].text, signal, prefs);
            if (!valid(s) || signal.aborted) return;
            s.player.cues[i].saved = entry;
            s.player.setClip(i, A.pcmToClip(entry.data, entry.rate));
            s.voiced.add(i);
          } catch (error) {
            if (signal.aborted) return;
            s.failed.add(i);
            s.error =
              "Some descriptions could not be prepared. Retry or continue video.";
          }
          checkReady(s);
        }
      };
      await Promise.all([worker(), worker()]);
      if (valid(s) && !signal.aborted) {
        s.voicingDone = true;
        checkReady(s);
      }
    } catch (e) {
      if (!signal.aborted) fail(s, e);
    }
  }
  function takeNearest(todo, cues, t) {
    let best = 0;
    const rank = (i) =>
      cues[i].end >= t ? cues[i].start : 1e9 + cues[i].start;
    for (let j = 1; j < todo.length; j++)
      if (rank(todo[j]) < rank(todo[best])) best = j;
    return todo.splice(best, 1)[0];
  }
  function checkReady(s) {
    if (!s.cues || !valid(s)) return;
    const t = s.video.currentTime;
    const first = s.cues
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.start >= t && c.start <= t + 60)
      .slice(0, 2);
    s.noGaps = !first.length;
    if (s.control.state === "preparing") {
      if (first.every(({ i }) => s.voiced.has(i))) s.control.set("ready");
      else if (first.some(({ i }) => s.failed.has(i))) s.control.set("error");
    }
    ui.render();
  }
  function stopMomentAudio(s) {
    if (s?.momentAudio) {
      s.momentAudio.onended = null;
      s.momentAudio.pause();
      s.momentAudio.src = "";
      s.momentAudio = null;
    }
    if (s?.momentUrl) {
      URL.revokeObjectURL(s.momentUrl);
      s.momentUrl = null;
    }
  }
  async function playAnswer(s, entry, token) {
    if (!valid(s, token)) return;
    stopMomentAudio(s);
    s.lastSpeech = entry;
    ui.answer(entry.text);
    const clip = A.pcmToClip(entry.data, entry.rate);
    s.momentUrl = clip.url;
    const audio = (s.momentAudio = new Audio(clip.url));
    audio.preservesPitch = true;
    audio.playbackRate = settings.speed;
    audio.onended = () => {
      if (valid(s, token)) {
        clearTimeout(s.answerTimeout);
        stopMomentAudio(s);
        s.control.set("paused");
      }
    };
    s.control.set("speaking");
    await audio.play();
  }
  async function repeat(s) {
    if (!s?.lastSpeech) return;
    const entry = s.lastSpeech;
    const token = s.control.begin("speaking");
    try {
      await playAnswer(s, entry, token);
    } catch (e) {
      if (valid(s, token)) fail(s, e);
    }
  }
  async function previewVoice(s) {
    if (!s?.video) return;
    const token = s.control.begin("waiting");
    try {
      const entry = await speech(
        "This is your AutoAD narration voice.",
        token.signal,
      );
      await playAnswer(s, entry, token);
    } catch (e) {
      if (valid(s, token)) fail(s, e);
    }
  }
  async function askAboutMoment(question) {
    const s = session;
    const clean = String(question || "")
      .trim()
      .slice(0, 500);
    if (!s?.video || !settings.apiKey || !clean || adShowing()) return;
    const token = beginQuestion(s);
    s.asking = true;
    ui.answer("Asking Gemini about this moment…");
    ui.render();
    try {
      const text = await A.describeMoment({
        apiKey: settings.apiKey,
        model: settings.videoModel,
        videoUrl: `https://www.youtube.com/watch?v=${s.id}`,
        currentSec: s.sceneTime,
        durationSec: s.video.duration,
        question: clean,
        conversation: s.sceneChat.slice(-4),
        preferences: settings,
        signal: token.signal,
      });
      if (!valid(s, token)) return;
      s.sceneChat.push({ question: clean, answer: text });
      s.sceneChat = s.sceneChat.slice(-4);
      ui.answer(text);
      ui.clearQuestion();
      const entry = await speech(text, token.signal);
      await playAnswer(s, entry, token);
    } catch (e) {
      if (valid(s, token)) fail(s, e, () => askAboutMoment(clean));
    } finally {
      if (valid(s, token)) {
        s.asking = false;
        ui.render();
      }
    }
  }
  function relevantSceneContext(s, time) {
    // Do not send a note spanning into the future: its text can reveal later events.
    const scenes = (s.sceneDescriptions || []).filter(
      (c) => c.end <= time && c.end >= Math.max(0, time - 12),
    );
    const cues = (s.cues || []).filter(
      (c) => c.end <= time && c.end >= Math.max(0, time - 12),
    );
    return (
      [
        ...scenes.map(
          (c) =>
            `${A.formatTime(c.start)}–${A.formatTime(c.end)}: ${c.description} ${c.visibleText || ""}`,
        ),
        ...cues.map((c) => `${A.formatTime(c.start)}: ${c.text}`),
      ].join("\n") ||
      "No verified notes for this moment. Use inspect_paused_scene."
    );
  }
  async function finishLiveAnswer(s) {
    const token = s.liveToken;
    if (!valid(s, token)) return;
    const chunks = s.liveChunks || [];
    if (!chunks.length) return;
    const rate = chunks[0].rate;
    if (chunks.some((c) => c.rate !== rate)) {
      panel.notice("This streamed answer cannot be replayed.");
      return;
    }
    const samples = chunks.map((c) => A.decodePcm(c.data));
    const all = new Int16Array(samples.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of samples) {
      all.set(part, offset);
      offset += part.length;
    }
    const entry = {
      data: A.LiveVoice.pcm16ToBase64(all),
      rate,
      text: s.liveOutputText || "Spoken answer",
    };
    s.lastSpeech = entry;
    s.sceneChat.push({
      question: s.liveQuestionText || "Voice question",
      answer: entry.text,
    });
    s.sceneChat = s.sceneChat.slice(-4);
    const key = await A.cacheKey("live-answer", [
      s.id,
      s.sceneTime,
      settings.liveModel,
      settings.voice,
      settings.tone,
      s.sceneChat,
    ]);
    await cache.put(key, entry);
    if (valid(s, token)) ui.render();
  }
  const LIVE_SCENE_TOOLS = [
    {
      functionDeclarations: [
        {
          name: "inspect_paused_scene",
          description:
            "Use only when the detailed scene notes do not contain enough evidence to answer the viewer. Ask the video analysis model to inspect the original YouTube video at the paused timestamp and return visual evidence for this question.",
          parameters: {
            type: "OBJECT",
            properties: {
              question: {
                type: "STRING",
                description:
                  "The visual question that the existing scene notes cannot answer.",
              },
            },
            required: ["question"],
          },
        },
      ],
    },
  ];

  async function inspectPausedScene(s, call) {
    if (call.name !== "inspect_paused_scene" || !valid(s, s.liveToken)) return;
    const video = s.video || s.player?.video;
    const token = s.liveToken;
    const currentSec = s.liveSceneTime ?? video?.currentTime ?? 0;
    const question = String(
      call.args?.question || s.liveQuestionText || "Describe the paused scene.",
    )
      .trim()
      .slice(0, 500);
    if (session === s)
      ui.answer(
        `${liveAnswerText(s)}\nChecking the original video for more detail…`.trim(),
      );
    let result;
    try {
      result = await A.describeMoment({
        apiKey: settings.apiKey,
        model: settings.videoModel,
        preferences: settings,
        videoUrl: `https://www.youtube.com/watch?v=${s.id}`,
        currentSec,
        durationSec: video?.duration,
        question: `Inspect the original video carefully at this paused moment and the preceding few seconds. Answer this viewer question with only details supported by the video: ${question}`,
        signal: s.liveToken.signal,
      });
    } catch (err) {
      result = `The original-video fallback could not inspect the scene: ${err.message}. Use the detailed notes if they support an answer; otherwise tell the viewer you cannot confirm it.`;
    }
    if (!valid(s, token) || !s.liveVoice) return;
    try {
      s.liveVoice.send({
        toolResponse: {
          functionResponses: [
            { id: call.id, name: call.name, response: { result } },
          ],
        },
      });
    } catch (err) {
      onLiveError(s, err);
    }
  }

  function stopLiveOutput(s) {
    for (const source of s?.liveAudioSources || []) {
      try {
        source.stop();
      } catch {}
    }
    if (s) {
      s.liveAudioSources = [];
      s.liveNextAudioAt = 0;
    }
  }

  function stopLiveMicrophone(s, sendActivityEnd = true) {
    if (!s) return;
    const hadStream = !!s.liveMicStream;
    s.liveMicState = "idle";
    if (s.liveProcessor) {
      s.liveProcessor.onaudioprocess = null;
      try {
        s.liveProcessor.disconnect();
      } catch {}
      s.liveProcessor = null;
    }
    if (s.liveMicSource) {
      try {
        s.liveMicSource.disconnect();
      } catch {}
      s.liveMicSource = null;
    }
    if (s.liveMuteGain) {
      try {
        s.liveMuteGain.disconnect();
      } catch {}
      s.liveMuteGain = null;
    }
    if (s.liveMicStream) {
      for (const track of s.liveMicStream.getTracks()) track.stop();
      s.liveMicStream = null;
    }
    if (sendActivityEnd && hadStream && s.liveVoice) {
      try {
        s.liveVoice.send({ realtimeInput: { activityEnd: {} } });
      } catch (err) {
        log("could not end the microphone activity:", err.message);
      }
    }
  }

  function stopLiveVoice(s) {
    if (!s) return;
    stopLiveMicrophone(s, false);
    s.liveVoice?.close();
    s.liveVoice = null;
    s.liveSceneTime = null;
    stopLiveOutput(s);
    if (s.liveAudioContext) {
      const context = s.liveAudioContext;
      s.liveAudioContext = null;
      if (context.state !== "closed") context.close().catch(() => {});
    }
  }

  function liveAnswerText(s) {
    const parts = [];
    if (s.liveQuestionText) parts.push(`You: ${s.liveQuestionText}`);
    if (s.liveOutputText) parts.push(`Gemini: ${s.liveOutputText}`);
    return parts.join("\n");
  }

  function updateLiveAnswer(s) {
    if (session === s) ui.answer(liveAnswerText(s));
  }

  function playLiveAudioChunk(s, inlineData) {
    const token = s.liveToken;
    const context = s.liveAudioContext;
    if (!context || !inlineData?.data) return;
    try {
      const binary = atob(inlineData.data);
      const sampleCount = Math.floor(binary.length / 2);
      if (!sampleCount) return;
      const samples = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        const lo = binary.charCodeAt(i * 2);
        const hi = binary.charCodeAt(i * 2 + 1);
        let value = (hi << 8) | lo;
        if (value >= 0x8000) value -= 0x10000;
        samples[i] = value / 0x8000;
      }
      const rate =
        Number(/rate=(\d+)/.exec(inlineData.mimeType || "")?.[1]) || 24000;
      s.liveChunks ||= [];
      s.liveChunks.push({ data: inlineData.data, rate });
      const buffer = context.createBuffer(1, sampleCount, rate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = settings.speed;
      s.control.set("speaking");
      source.connect(context.destination);
      const startAt = Math.max(
        context.currentTime + 0.025,
        s.liveNextAudioAt || 0,
      );
      s.liveNextAudioAt = startAt + buffer.duration / settings.speed;
      s.liveAudioSources ||= [];
      s.liveAudioSources.push(source);
      source.onended = () => {
        s.liveAudioSources = s.liveAudioSources.filter(
          (item) => item !== source,
        );
        if (valid(s, token) && s.liveComplete && !s.liveAudioSources.length)
          s.control.set("paused");
      };
      if (context.state === "suspended") context.resume().catch(() => {});
      source.start(startAt);
    } catch (err) {
      log("could not play Gemini Live audio:", err.message);
    }
  }

  function onLiveMessage(s, message) {
    for (const call of message.toolCall?.functionCalls || [])
      inspectPausedScene(s, call);
    const content = message.serverContent;
    if (!content || !valid(s, s.liveToken)) return;
    if (content.interrupted) {
      stopLiveOutput(s);
      s.liveOutputText = "";
      s.liveChunks = [];
      s.liveHasOutputTranscription = false;
      updateLiveAnswer(s);
    }
    if (content.inputTranscription?.text) {
      s.liveQuestionText =
        (s.liveQuestionText || "") + content.inputTranscription.text;
      updateLiveAnswer(s);
    }
    if (content.outputTranscription?.text) {
      const text = content.outputTranscription.text;
      if (!s.liveHasOutputTranscription) {
        // The transcript can arrive after matching modelTurn text; use one canonical copy.
        s.liveOutputText = text;
        s.liveHasOutputTranscription = true;
      } else s.liveOutputText = `${s.liveOutputText || ""}${text}`;
      updateLiveAnswer(s);
    }
    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.mimeType?.startsWith("audio/pcm"))
        playLiveAudioChunk(s, part.inlineData);
      if (part.text && !s.liveHasOutputTranscription) {
        s.liveOutputText = `${s.liveOutputText || ""}${part.text}`;
        updateLiveAnswer(s);
      }
    }
    if (content.turnComplete) {
      clearTimeout(s.answerTimeout);
      s.liveComplete = true;
      finishLiveAnswer(s).catch(() => {});
      stopLiveMicrophone(s, true);
      s.liveMicState = "idle";
      if (!s.liveAudioSources?.length) s.control.set("paused");
      ui.render();
    }
  }

  function onLiveError(s, error) {
    if (!valid(s, s.liveToken)) return;
    stopLiveMicrophone(s, false);
    s.liveVoice?.close();
    s.liveVoice = null;
    s.liveMicState = "idle";
    stopLiveOutput(s);
    fail(s, new Error(`Voice chat failed: ${error.message}`), () =>
      startVoiceQuestion(s),
    );
    ui.render();
  }

  function startLiveMicrophone(s, stream, context) {
    const live = A.LiveVoice;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (
        !valid(s, s.liveToken) ||
        s.liveMicState !== "recording" ||
        !s.liveVoice
      )
        return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = live.downsampleToPcm16(input, event.inputBuffer.sampleRate);
      if (!pcm.length) return;
      try {
        s.liveVoice.send({
          realtimeInput: {
            audio: {
              data: live.pcm16ToBase64(pcm),
              mimeType: "audio/pcm;rate=16000",
            },
          },
        });
      } catch (err) {
        onLiveError(s, err);
      }
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    s.liveMicStream = stream;
    s.liveMicSource = source;
    s.liveProcessor = processor;
    s.liveMuteGain = mute;
    s.liveVoice.send({ realtimeInput: { activityStart: {} } });
  }

  async function startVoiceQuestion(s) {
    const video = s?.video || s?.player?.video;
    const live = A.LiveVoice;
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    let streamPromise;
    let stream;
    let audioContext;
    let createdAudioContext = false;
    if (!s || !video || !settings.apiKey || adShowing()) return;
    const token = beginQuestion(s, "starting");
    s.liveToken = token;
    if (!live)
      return fail(
        s,
        new Error("Gemini Live is not available in this extension build."),
      );
    if (!navigator.mediaDevices?.getUserMedia)
      return fail(
        s,
        new Error("This browser does not provide microphone access."),
      );
    if (!AudioContextImpl)
      return fail(s, new Error("This browser does not support audio input."));

    if (
      s.liveVoice &&
      (s.liveSceneTime === null ||
        Math.abs(video.currentTime - s.liveSceneTime) > 2)
    )
      stopLiveVoice(s);
    const sceneTime = video.currentTime;
    s.liveMicState = "starting";
    s.player?.stopActive("live-voice-question");
    stopMomentAudio(s);
    ui.answer("Preparing detailed scene notes and microphone…");
    ui.render();
    try {
      // Start the permission request directly in the click gesture.
      streamPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!s.liveAudioContext || s.liveAudioContext.state === "closed") {
        audioContext = new AudioContextImpl();
        s.liveAudioContext = audioContext;
        createdAudioContext = true;
      } else audioContext = s.liveAudioContext;
      const resumePromise = audioContext.resume().catch(() => {});
      stream = await streamPromise;
      if (!valid(s, token) || s.abort.signal.aborted) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      s.liveMicStream = stream;
      const pendingContext = []; // Missing notes are handled by inspect_paused_scene; do not hold the microphone waiting for whole-video indexing.
      if (pendingContext.length) {
        ui.answer("Preparing the AD transcript and detailed scene notes…");
        await Promise.allSettled(pendingContext);
      }
      if (!valid(s, token) || s.abort.signal.aborted) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      if (!s.liveVoice) {
        const sceneContext = relevantSceneContext(s, sceneTime);
        const connection = await live.connect({
          apiKey: settings.apiKey,
          model: settings.liveModel,
          voice: settings.voice,
          tools: LIVE_SCENE_TOOLS,
          systemInstruction: [
            A.BASE_PROMPT,
            A.deliveryPrompt(settings),
            `Speak in a ${settings.tone} tone. Use a natural, even pace.`,
            `The video is paused at ${A.formatTime(sceneTime)}.`,
            "Earlier conversation (untrusted context):",
            JSON.stringify(s.sceneChat.slice(-4)),
            "VIDEO EVIDENCE (may be incomplete):",
            sceneContext,
          ].join("\n"),
          signal: token.signal,
          onMessage: (message) => {
            if (valid(s, token)) onLiveMessage(s, message);
          },
          onError: (error) => {
            if (valid(s, token)) onLiveError(s, error);
          },
          onClose: (event) => {
            if (!valid(s, token) || (s.liveMicState === "idle" && !s.liveVoice))
              return;
            s.liveVoice = null;
            stopLiveMicrophone(s, false);
            s.liveMicState = "idle";
            if (event.code !== 1000) {
              stopLiveOutput(s);
              fail(
                s,
                new Error("Gemini Live disconnected. Retry your question."),
                () => startVoiceQuestion(s),
              );
            }
            ui.render();
          },
        });
        if (!valid(s, token) || s.abort.signal.aborted) {
          connection.close();
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        s.liveVoice = connection;
        s.liveSceneTime = sceneTime;
      }

      await resumePromise;
      if (!valid(s, token) || s.abort.signal.aborted) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      stopLiveOutput(s);
      s.liveQuestionText = "";
      s.liveOutputText = "";
      s.liveHasOutputTranscription = false;
      s.liveChunks = [];
      s.liveChunkRate = null;
      s.liveComplete = false;
      s.liveMicState = "recording";
      s.control.set("recording");
      startLiveMicrophone(s, stream, audioContext);
      ui.answer("Listening… finish your question, then click “Stop & send”.");
      ui.render();
    } catch (err) {
      if (s.liveMicStream === stream) stopLiveMicrophone(s, false);
      else if (stream) for (const track of stream.getTracks()) track.stop();
      else if (streamPromise)
        streamPromise
          .then((pendingStream) =>
            pendingStream.getTracks().forEach((track) => track.stop()),
          )
          .catch(() => {});
      if (
        createdAudioContext &&
        s.liveAudioContext === audioContext &&
        !s.liveVoice
      ) {
        s.liveAudioContext = null;
        if (audioContext.state !== "closed")
          audioContext.close().catch(() => {});
      }
      if (valid(s, token)) s.liveMicState = "idle";
      if (valid(s, token))
        fail(s, new Error(`Voice question failed: ${err.message}`), () =>
          startVoiceQuestion(s),
        );
      ui.render();
    }
  }

  function stopVoiceQuestion(s) {
    if (!s || s.liveMicState !== "recording") return;
    stopLiveMicrophone(s, true);
    s.liveMicState = "waiting";
    s.control.set("waiting");
    ui.answer(liveAnswerText(s) || "Sending your question to Gemini Live…");
    ui.render();
  }

  async function saveSetting(key, value) {
    try {
      await chrome.storage.local.set({
        [key]: key === "speed" ? Number(value) : value,
      });
      panel.notice("Preferences saved automatically");
    } catch {
      panel.notice("Could not save preferences. Please retry.");
    }
  }
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local" || !SETTING_KEYS.some((k) => k in changes)) return;
    settings = A.normalizeSettings(
      await chrome.storage.local.get(SETTING_KEYS),
    );
    const s = session;
    if (s) {
      const onlySpeed = Object.keys(changes).every((k) => k === "speed");
      if (onlySpeed) {
        if (s.liveAudioSources?.length || s.liveMicState !== "idle")
          s.control.pause();
        s.player?.setSpeed(settings.speed);
        if (s.momentAudio) s.momentAudio.playbackRate = settings.speed;
      } else {
        s.control?.pause();
        if ("enabled" in changes && !settings.enabled) disable(s);
        else if (s.enabled) prepare(s);
      }
    }
    ui.render();
  });
  chrome.storage.local
    .get(SETTING_KEYS)
    .then((stored) => {
      settings = A.normalizeSettings(stored);
      schedule(0);
    })
    .catch(() => {
      panel.notice("Settings storage unavailable.");
      schedule(0);
    });
})();
