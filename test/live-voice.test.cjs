const assert = require('node:assert/strict');
const test = require('node:test');
const LiveVoice = require('../extension/src/live.js');

class FakeWebSocket {
  static latest;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.latest = this;
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ listener, once: !!options.once });
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    const listeners = this.listeners.get(type) || [];
    for (const entry of [...listeners]) {
      entry.listener(event);
      if (entry.once) this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== entry));
    }
  }

  send(value) { this.sent.push(value); }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

test('Live connection sends the 3.1 voice setup and waits for setupComplete', async () => {
  let received;
  const connected = LiveVoice.connect({
    apiKey: 'demo key',
    voice: 'Kore',
    systemInstruction: 'Use the timestamped scene notes.',
    tools: [{ functionDeclarations: [{ name: 'inspect_paused_scene' }] }],
    WebSocketImpl: FakeWebSocket,
    onMessage: (message) => { received = message; },
  });
  const socket = FakeWebSocket.latest;
  socket.readyState = 1;
  socket.emit('open');

  const setupMessage = JSON.parse(socket.sent[0]);
  assert.equal(socket.url, `${LiveVoice.ENDPOINT}?key=demo%20key`);
  assert.equal(setupMessage.setup.model, 'models/gemini-3.1-flash-live-preview');
  assert.deepEqual(setupMessage.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.deepEqual(setupMessage.setup.realtimeInputConfig.automaticActivityDetection, { disabled: true });
  assert.equal(setupMessage.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(setupMessage.setup.systemInstruction.parts[0].text, 'Use the timestamped scene notes.');
  assert.equal(setupMessage.setup.tools[0].functionDeclarations[0].name, 'inspect_paused_scene');

  socket.emit('message', { data: JSON.stringify({ setupComplete: {} }) });
  const live = await connected;
  live.send({ realtimeInput: { text: 'What color is the track?' } });
  socket.emit('message', { data: JSON.stringify({ serverContent: { turnComplete: true } }) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(JSON.parse(socket.sent[1]), { realtimeInput: { text: 'What color is the track?' } });
  assert.deepEqual(received, { serverContent: { turnComplete: true } });
  live.close();
});

test('Live websocket message decoder accepts text, Blob and binary JSON frames', async () => {
  const json = JSON.stringify({ setupComplete: {} });
  const bytes = new TextEncoder().encode(json);

  assert.equal(await LiveVoice.decodeMessageData(json), json);
  assert.equal(await LiveVoice.decodeMessageData(new Blob([json])), json);
  assert.equal(await LiveVoice.decodeMessageData(bytes.buffer), json);
  assert.equal(await LiveVoice.decodeMessageData(bytes), json);
  assert.match(LiveVoice.describeMessageData(new Blob([json])), /^Blob \(/);
});

test('microphone samples are downsampled to signed 16-bit PCM and base64 encoded', () => {
  const pcm = LiveVoice.downsampleToPcm16(new Float32Array(480).fill(0.5), 48000);
  const base64 = LiveVoice.pcm16ToBase64(pcm);
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

  assert.equal(pcm.length, 160);
  assert.equal(bytes.length, 320);
  assert.ok(pcm.every((sample) => sample === 16384));
});

test('microphone samples below 16 kHz are resampled instead of mislabeled', () => {
  const pcm = LiveVoice.downsampleToPcm16(new Float32Array(80).fill(0.25), 8000);

  assert.equal(pcm.length, 160);
  assert.ok(pcm.every((sample) => sample === 8192));
});
