# AutoAD — accessible YouTube audio description

Chrome extension for blind and low-vision viewers. A single light panel provides timed English audio descriptions, scene questions by text or microphone, replay, and narration preferences. Cloud AI calls use Google Gemini only.

## Install / update

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked** → this repository's `extension/` directory. To update an existing installation, click its Reload button and reload the YouTube tab.
2. Open a public recorded YouTube video. AutoAD appears in the right column (inside the player in fullscreen).
3. Expand **Connection and storage**, enter the Gemini API key, and choose **Save API key**. The toolbar popup remains available as a connection-settings fallback. The key is stored in this browser and is not included in copied discussion context.
4. Click **Enable descriptions**. The video pauses while analysis runs and the first two available cues in the next minute are voiced. If fewer cues exist, those are sufficient. If there are no suitable upcoming gaps, the status says so.
5. Click **Continue video**. Remaining clips load in the background. **Pause descriptions** disables narration without pausing a playing video.

Generation starts explicitly per video; opening a page alone does not spend AI quota. Cached results are reused. Initial analysis of an uncached video can still take time; ready does not mean every clip has finished rendering.

## Ask about a scene

- **Ask by voice** pauses the video and current narration before requesting microphone access. Speak, then **Stop & send**. The microphone is released, Gemini answers, and the video stays paused.
- A typed question or **Describe this moment** also pauses the video automatically.
- Ask follow-up questions at the same timestamp. **Continue video** cancels pending answers/microphone capture, silences response audio and resumes the video. Directly playing the YouTube player also cancels the current answer.
- **Repeat last description** plays completed audio without a new AI request. Seeking clears scene history and invalidates late replies.
- **Open Gemini** pauses video/audio and opens Gemini in a new tab. **Copy discussion context** copies the URL, timestamp and last four question/answer pairs for manual pasting. It never sends the conversation to the website automatically.

## Preferences

Speed: 0.75× / 1× / 1.5× / 2×; detail: Brief / Standard / Detailed; language style: Plain / Academic; named Gemini voices with Preview voice; tone: Calm / Cheerful / Playful. Preferences save automatically.

Speed affects narration, not YouTube's playback speed, and does not regenerate TTS. Changing voice/tone reuses text and renders the matching voice. Changing detail/style creates the corresponding track. Descriptions always obey dialogue-gap budgets; long explanations belong in paused answers. If a clip cannot fit at the allowed rate, it is skipped. A playing clip is cut off at the gap boundary rather than spoken over dialogue. No automatic pauses for ordinary narration.

## Accessibility: Windows Narrator and macOS VoiceOver

The panel exposes a named landmark, native labeled buttons and fields, native radio groups with checked states, visible keyboard focus, and expandable controls. Use Tab / Shift+Tab to navigate, Enter or Space to activate buttons, and arrow keys to choose radio options. Escape closes a focused connection section and returns focus to its summary. Collapse/Expand keeps its button available.

Status changes use a polite status region; errors use an alert. Spoken description text is intentionally **not** an automatic live region, so screen readers do not read it on top of Gemini audio. There is no second custom hover narrator. Reading under the pointer depends on the user's screen-reader settings. Browser accessibility-tree verification is not equivalent to an auditory end-to-end Narrator/VoiceOver test; both native checks remain part of release acceptance.

## Architecture

- `extension/src/content.js`: page/session orchestration, preparation, text and Live questions, audio cancellation and settings.
- `panel.js` / `content.css`: single light UI, responsive/fullscreen positioning and accessibility.
- `coordinator.js`: request generations, cancellation and explicit video resume.
- `settings.js`: named voices, validated defaults and preferences.
- `cache.js`: hashed/versioned keys, completed-result caching, in-flight coalescing within a session and LRU eviction (200 MiB budget). Storage errors warn without discarding playable generated audio.
- `gemini.js`: shared evidence prompt, JSON track/index schemas, text answers and Gemini TTS.
- `live.js`: Gemini Live transport and PCM microphone conversion.
- `audio.js` / `player.js`: PCM/WAV conversion, fit checks, ducking, seeking and playback-rate synchronization.

Configured models: `gemini-3.8-flash`, `gemini-3.1-flash-tts-preview`, `gemini-3.1-flash-live-preview`. Models are editable; no silent fallback. Live uses its supported protocol separately from the Interactions API. Voice and tone affect rendering; factuality instructions remain unchanged. Live responses are replayable only after a complete audio turn; mixed-rate streams report replay unavailable.

Scene notes may be wrong or incomplete. Live calls `inspect_paused_scene` when evidence is insufficient. Text questions inspect the original video directly. General explanations are distinguished from video claims. Future scene notes are excluded from the question context, but the original full-video URL is still available to the analysis model: no-spoiler behavior is an instruction, not a hard temporal media boundary. Neither prompts nor tests guarantee hallucination-free responses.

## Run checks

No dependency installation or build step is needed for the extension or Node tests. Use current Node.js with `node:test`, Web Crypto, fetch, and AbortSignal.timeout/any (Node 22+).

```sh
npm test
npm run serve
```

Open:

- `http://127.0.0.1:8765/test/youtube-mock.html` — click **Run scripted tests** for UI, cache, questions, voice cancellation and navigation checks. This is a local demo: simulated timeline, scripted answers, generated tones and a fake microphone. No live API calls or real recording.
- `http://127.0.0.1:8765/test/harness.html` — click **Run scripted tests** for the standalone player's fit/hold/drop-compatible behavior, pause/resume, seeking, ducking and playback speed. The content integration selects `overrun: 'drop'`; legacy hold mode remains tested separately.

For a real API probe, set `GEMINI_API_KEY` in a local `.env` (gitignored), then:

```sh
node scripts/probe.cjs --tts-only "A woman in a red coat enters the café."
node scripts/probe.cjs "https://www.youtube.com/watch?v=VIDEO_ID" --tts 2
```

The probe writes local WAVs under ignored `out/`. It requires a working API key and consumes the project's quota. Do not commit `.env` or embed a key in a URL.

## Verification and remaining acceptance

Implemented and checked locally: Node tests, browser integration tests with stubs, player timing tests, and accessible names/roles/states in the browser accessibility tree. See `VALIDATION.md` for recorded results and boundaries.

Before a live demo, verify with a project key: clothing question, unreadable-detail refusal, technical concept explanation, follow-up, voice/tone/speed changes, real microphone permission/cancellation and replay after revisiting a video. Also complete native VoiceOver on macOS and Narrator on Windows, real YouTube/fullscreen/ad checks. API entitlement and voice quality have not been established by offline tests.

No installer, Web Store publishing, downloadable WAV UI, continuous screen streaming, or non-Google AI service is included.
