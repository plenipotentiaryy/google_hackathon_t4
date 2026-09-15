# Validation — AutoAD accessible panel

Implementation based on upstream `92a7730`. Local validation date: 2026-09-15.

- Node suite: **18/18 passed**. Run `npm test`; covers existing request/Live transport tests plus cancellation, cache persistence/coalescing/eviction/failures, settings, prompt delivery, late playback rejection and speed.
- Browser integration: **32/32 passed** on the local fixture through the Codex in-app Chromium browser. Includes explicit enable/preparation, manual continue, questions during playback, follow-up context, replay without requests, cached re-enable, voice changes, cancellation after seek, ad suspension, mocked microphone failure, streamed PCM replay and navigation teardown.
- Standalone player: **25/25 passed** in the browser fixture (real audio tones and simulated video clock). Legacy hold mode is tested here; production content code selects drop mode.
- Accessibility tree exposes panel name, labels, checked radio states, expanded/collapsed state and status regions. Text answers are not automatically announced over their audio.

## Not yet verified

- Real Gemini API / microphone end-to-end: no project API key was configured in the environment or local `.env` during implementation.
- Native VoiceOver spoken navigation and Windows Narrator spoken navigation: accessibility structure verified, auditory OS-specific acceptance still pending. Windows is not available on this Mac.
- Real YouTube extension installation, layout across YouTube variants, fullscreen/ad transitions and API permissions. Mock page behavior is not proof of these integrations.
- Model factual accuracy, video gap accuracy, speech quality/style fidelity and latency under live quota.

No private key or real user microphone audio was used in these checks.

## Toolbar design follow-up (0.2.1)

The toolbar popup and standalone preferences now share the video panel's stylesheet and controls. Browser visual checks used `test/options-preview.html` with simulated storage for: saved key, first launch without a key, and unavailable storage. Changed the speed radio and verified its checked state plus save announcement. No real key or restricted Chrome page was used. Actual installed popup refresh must be performed in Chrome.

## Compact layout follow-up (0.2.3)

Local browser layout fixture: `test/panel-layout.html`. Checked at 1366×768 and 1440×900 CSS pixels: 410 px panel width; off/preparing/ad/ready/short-answer states measured 567.1 px tall, error state 614.1 px. No outer scrolling; Connection and storage remained visible. Long answer measured 610.5 px with only its text area scrolling. Gemini target measured 48×48 px; accessible name is “Open Gemini in a new tab”; keyboard focus outline measured 3 px. Popup preview also exposes the same logo and accessible name. Temporary viewport overrides were reset after checking. These are local layout checks, not a new real API validation.
