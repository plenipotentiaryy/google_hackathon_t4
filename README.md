# AutoAD — feasibility prototype

Chrome extension. Open a YouTube video and Gemini watches it from the URL, then returns an **English** timed
audio-description track as JSON: the speech gaps, what's worth describing in each, and a line
written to fit the gap. It also builds a time-indexed detailed scene guide for later questions.
Each line is voiced with Gemini TTS and played inside its gap, kept in sync
with play, pause, seek, speed changes and ads.

```
extension/            ← load this folder in Chrome (Load unpacked)
  src/gemini.js       prompts + schemas, video → AD track and scene guide, text → speech (Interactions API)
  src/live.js         microphone PCM and spoken replies (Gemini Live API)
  src/audio.js        TTS PCM → trimmed WAV clip with exact duration
  src/player.js       ADPlayer: plays clips in gaps of any <video>
  src/content.js      YouTube glue: auto-generate, cache, SPA navigation, ads, UI
scripts/probe.cjs     run the Gemini half from the terminal
test/harness.html     ADPlayer sync tests (25 checks)
test/youtube-mock.html content.js tests on a mock watch page, Gemini stubbed (27 checks)
test/live-voice.test.cjs and test/gemini-moment.test.cjs  Live transport and video-request tests (no API key)
```

## Run it

1. **Key for the probe:** create `.env` at the repo root containing `GEMINI_API_KEY=<key>`.
2. **Probe the Gemini half** (no Chrome needed):
   ```bash
   node scripts/probe.cjs --tts-only "A woman in a red coat crosses the empty street."
   ```
   ```bash
   node scripts/probe.cjs "https://www.youtube.com/watch?v=VIDEO_ID" --tts 5
   ```
   It prints the cues, word budget vs actual words, and each clip's measured length vs its gap.
   WAVs go to `out/<videoId>/`.
3. **Extension:**
   - Go to `chrome://extensions`, turn on Developer mode, click Load unpacked and choose `extension/`.
   - Click the AutoAD toolbar icon and paste your key.
   - Open any public video. The button at the top-left of the player shows progress. Lines play as they're voiced.
   - Pause the video and choose **Describe this moment** for a quick English explanation of the current scene and the preceding eight seconds. You can also type follow-up questions in the scene field; Gemini retains the conversation only while the video remains on the same scene.
   - For spoken questions, click **Ask by voice**, allow microphone access, speak, then click **Stop & send**. Gemini 3.1 Flash Live speaks its answer and shows the transcription. The mic stops after the reply. If the detailed scene notes do not answer the question, Live asks the video model to inspect the original scene before replying.
   - Logs are in DevTools on the YouTube tab, filtered by `[AutoAD]`.
4. **Offline tests:**
   - Run all Node tests without an API key:
     ```bash
     node --test test/*.test.cjs
     ```
   - Start the browser mock tests:
     ```bash
     python3 -m http.server 8765
     ```
     Then open `http://localhost:8765/test/harness.html` or `/test/youtube-mock.html` and click *Run scripted tests*. The tests use a built-in simulated 60-second video timeline, so no media file is required.

## How the timing works

- **Prompt:** the narrator speaks at ~150 wpm, so each cue has `max_words = floor((gap − 0.35 s) × 2.5)`. The model targets a useful visual cue every 6–12 seconds, including brief two-word cues in short speech gaps.
- **Fit:** the TTS clip's real length is known after rendering. If it's longer than the room left in the gap, it plays up to ×1.3 faster with pitch preserved.
- **Hold (last resort):** if a clip is still playing when speech would resume, the video pauses until the line ends. A description is never talked over. Set `overrun: 'drop'` in `player.js` to skip such lines instead.
- **Ducking:** the video's volume drops 50% under each line.
- **Pause and seek:**
  - A user pause pauses the clip; resuming continues it.
  - Seeking stops the clip. Seeking back replays a line; landing more than 0.75 s into a gap skips it.
- **Speed:** clip rate = fit × the video's playback rate.
- **Ads:** while an ad plays (`.ad-showing`), AD is suspended.

## Not solved yet (things to measure)

- **Gap edges:** Gemini samples video at 1 fps, so gap edges may be off by about ±1 s. A live silence check on the video's audio (`AnalyserNode`) before each line would tighten this.
- **Quota:** automatic mode uses two video calls per video (timed AD cues and a detailed scene index), plus one TTS call per line (1.5 s debounce, results cached). Voice replies use a separate Gemini Live session; a question that needs more visual evidence invokes one additional scene-analysis call.
- **Latency:** the AD-cue and scene-index calls run in parallel. Very long videos may produce large scene indexes; chunking the index into smaller requests is a future optimization.
