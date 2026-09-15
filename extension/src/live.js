// Gemini Live API WebSocket transport for voice questions from the paused scene.
(function (root) {
  const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';

  function buildSetup({ model = DEFAULT_MODEL, voice = 'Charon', systemInstruction, tools = [] }) {
    const setup = {
      model: model.startsWith('models/') ? model : `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      systemInstruction: { parts: [{ text: systemInstruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (tools.length) setup.tools = tools;
    return setup;
  }

  async function decodeMessageData(data) {
    if (typeof data === 'string') return data;
    if (data && typeof data.text === 'function') return data.text();
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    throw new Error(`Unsupported WebSocket payload type: ${Object.prototype.toString.call(data)}`);
  }

  function describeMessageData(data) {
    if (typeof data === 'string') return `text (${data.length} chars)`;
    if (data && Number.isFinite(data.size)) return `Blob (${data.size} bytes)`;
    if (data instanceof ArrayBuffer) return `ArrayBuffer (${data.byteLength} bytes)`;
    if (ArrayBuffer.isView(data)) return `${data.constructor.name} (${data.byteLength} bytes)`;
    return Object.prototype.toString.call(data);
  }

  function connect({ apiKey, model = DEFAULT_MODEL, voice = 'Charon', systemInstruction, tools, signal, onMessage, onError, onClose, WebSocketImpl = root.WebSocket, timeoutMs = 15000 }) {
    if (!apiKey) return Promise.reject(new Error('Add your Gemini API key in the AutoAD settings.'));
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('Live connection cancelled.'));
    if (!WebSocketImpl) return Promise.reject(new Error('WebSocket is not available in this browser.'));

    const url = `${ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    return new Promise((resolve, reject) => {
      let socket;
      let ready = false;
      let settled = false;
      let timeout = 0;

      const cleanupPendingConnection = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      };

      const rejectBeforeReady = (error) => {
        if (settled) return;
        settled = true;
        cleanupPendingConnection();
        reject(error instanceof Error ? error : new Error(String(error || 'Could not connect to Gemini Live.')));
      };

      const handle = {
        send(message) {
          if (!socket || socket.readyState !== 1) throw new Error('Gemini Live is not connected.');
          socket.send(JSON.stringify(message));
        },
        close() {
          if (!socket || (socket.readyState !== 0 && socket.readyState !== 1)) return;
          try {
            // The browser may reject close-code arguments while the handshake is still pending.
            if (socket.readyState === 0) socket.close();
            else socket.close(1000, 'AutoAD closed the voice session');
          } catch {}
        },
      };

      const abort = () => {
        handle.close();
        rejectBeforeReady(signal.reason || new Error('Live connection cancelled.'));
      };

      try {
        socket = new WebSocketImpl(url);
        // Be explicit about binary frames; text frames still arrive as strings.
        socket.binaryType = 'arraybuffer';
      } catch (error) {
        rejectBeforeReady(error);
        return;
      }

      timeout = setTimeout(() => {
        handle.close();
        rejectBeforeReady(new Error('Timed out connecting to Gemini Live.'));
      }, timeoutMs);

      signal?.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', () => {
        try {
          socket.send(JSON.stringify({ setup: buildSetup({ model, voice, systemInstruction, tools }) }));
        } catch (error) {
          handle.close();
          rejectBeforeReady(error);
        }
      }, { once: true });

      socket.addEventListener('message', async (event) => {
        let message;
        try {
          message = JSON.parse(await decodeMessageData(event.data));
        } catch (error) {
          onError?.(new Error(`Gemini Live returned an unreadable message (${describeMessageData(event.data)}): ${error.message}`));
          return;
        }

        if (message.error) {
          const error = new Error(message.error.message || 'Gemini Live returned an error.');
          if (!ready) rejectBeforeReady(error);
          else onError?.(error);
          return;
        }

        if (message.setupComplete) {
          if (!settled) {
            ready = true;
            settled = true;
            cleanupPendingConnection();
            resolve(handle);
          }
          return;
        }

        if (ready) onMessage?.(message);
      });

      socket.addEventListener('error', () => {
        const error = new Error('Could not connect to Gemini Live. Check the API key and network access.');
        if (!ready) rejectBeforeReady(error);
        else onError?.(error);
      });

      socket.addEventListener('close', (event) => {
        cleanupPendingConnection();
        if (!ready) rejectBeforeReady(new Error(event.reason || 'Gemini Live closed before setup completed.'));
        else onClose?.(event);
      });
    });
  }

  function downsampleToPcm16(samples, sampleRate, targetRate = 16000) {
    if (!samples || !samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) return new Int16Array();
    if (sampleRate === targetRate) {
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) pcm[i] = toPcm16(samples[i]);
      return pcm;
    }

    const ratio = sampleRate / targetRate;
    const length = Math.floor(samples.length / ratio);
    const pcm = new Int16Array(length);
    if (sampleRate < targetRate) {
      for (let i = 0; i < length; i++) {
        const position = i * ratio;
        const left = Math.floor(position);
        const right = Math.min(samples.length - 1, left + 1);
        const fraction = position - left;
        pcm[i] = toPcm16(samples[left] + (samples[right] - samples[left]) * fraction);
      }
      return pcm;
    }

    for (let i = 0; i < length; i++) {
      const start = i * ratio;
      const end = Math.min(samples.length, (i + 1) * ratio);
      const first = Math.floor(start);
      const last = Math.min(samples.length - 1, Math.ceil(end) - 1);
      let sum = 0;
      let weight = 0;
      for (let j = first; j <= last; j++) {
        const overlap = Math.max(0, Math.min(end, j + 1) - Math.max(start, j));
        sum += samples[j] * overlap;
        weight += overlap;
      }
      pcm[i] = toPcm16(sum / Math.max(Number.EPSILON, weight));
    }
    return pcm;
  }

  function toPcm16(value) {
    const sample = Math.max(-1, Math.min(1, value));
    return sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }

  function pcm16ToBase64(pcm) {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  const LiveVoice = root.AutoADLive || (root.AutoADLive = {});
  Object.assign(LiveVoice, { DEFAULT_MODEL, ENDPOINT, buildSetup, connect, decodeMessageData, describeMessageData, downsampleToPcm16, pcm16ToBase64 });
  root.AutoADLive = LiveVoice;
  if (root.AutoAD) root.AutoAD.LiveVoice = LiveVoice;
  if (typeof module !== 'undefined' && module.exports) module.exports = LiveVoice;
})(globalThis);
