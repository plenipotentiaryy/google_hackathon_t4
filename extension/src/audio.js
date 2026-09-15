// Gemini TTS returns base64 16-bit little-endian mono PCM. Turn it into a trimmed WAV clip
// with an exact duration, which is what the player's fit check needs.
(function (root) {
  function decodePcm(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length & ~1);
    for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Int16Array(bytes.buffer); // assumes a little-endian host, like every Chrome platform
  }

  // Drop leading/trailing near-silence so duration reflects the spoken words.
  function trimSilence(samples, rate, threshold = 500, padSec = 0.04) {
    let a = 0;
    let b = samples.length - 1;
    while (a < samples.length && Math.abs(samples[a]) < threshold) a++;
    while (b > a && Math.abs(samples[b]) < threshold) b--;
    if (a >= b) return samples;
    const pad = Math.round(padSec * rate);
    return samples.subarray(Math.max(0, a - pad), Math.min(samples.length, b + 1 + pad));
  }

  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const tag = (offset, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
    };
    tag(0, 'RIFF');
    v.setUint32(4, 36 + samples.length * 2, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    v.setUint32(16, 16, true); // fmt chunk size
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); // byte rate
    v.setUint16(32, 2, true); // block align
    v.setUint16(34, 16, true); // bits per sample
    tag(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    new Int16Array(buf, 44).set(samples);
    return new Uint8Array(buf);
  }

  function pcmToWav(b64, rate) {
    const samples = trimSilence(decodePcm(b64), rate);
    return { wav: encodeWav(samples, rate), duration: samples.length / rate };
  }

  // Browser only: a playable clip for the player.
  function pcmToClip(b64, rate) {
    const { wav, duration } = pcmToWav(b64, rate);
    return { url: URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })), duration };
  }

  const AutoAD = root.AutoAD || (root.AutoAD = {});
  Object.assign(AutoAD, { decodePcm, trimSilence, encodeWav, pcmToWav, pcmToClip });
  if (typeof module !== 'undefined' && module.exports) module.exports = AutoAD;
})(globalThis);
