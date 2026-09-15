#!/usr/bin/env node
// Exercise the Gemini half of AutoAD from the terminal, no Chrome needed.
//
//   node scripts/probe.cjs <youtube-url> [--tts N|all] [--duration SEC] [--model M] [--voice V]
//   node scripts/probe.cjs --tts-only "Text to speak"
//
// Reads GEMINI_API_KEY from the environment or from .env at the repo root.
// Writes out/<videoId>/track.json and cue-NN.wav so you can listen to the lines.
const fs = require('fs');
const path = require('path');
const AutoAD = require('../extension/src/gemini.js');
require('../extension/src/audio.js');

const ROOT = path.join(__dirname, '..');
const { TIMING, formatTime, countWords, wordBudget, summarize } = AutoAD;

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
  const args = { tts: '5' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else rest.push(a);
  }
  args.url = rest[0];
  return args;
}

function videoIdOf(url) {
  const u = new URL(url);
  return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
}

// Best effort: the watch page embeds "lengthSeconds". Helps the prompt and clamps cues.
async function fetchDuration(id) {
  try {
    const html = await (await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { 'accept-language': 'en' } })).text();
    const m = /"lengthSeconds":"(\d+)"/.exec(html);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n);

async function speak(apiKey, args, text, file) {
  const t0 = Date.now();
  const res = await AutoAD.renderSpeech({ apiKey, model: args['tts-model'], voice: args.voice, text });
  const raw = AutoAD.decodePcm(res.data).length / res.rate;
  const { wav, duration } = AutoAD.pcmToWav(res.data, res.rate);
  fs.writeFileSync(file, wav);
  return { res, raw, duration, ms: Date.now() - t0 };
}

async function ttsOnly(apiKey, args, text) {
  const dir = path.join(ROOT, 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'tts-test.wav');
  const { res, raw, duration, ms } = await speak(apiKey, args, text, file);
  console.log('Response shape:', summarize(res.response));
  console.log(`\n${countWords(text)} words → ${duration.toFixed(2)}s trimmed (${raw.toFixed(2)}s raw), ${res.rate} Hz, ${ms} ms`);
  console.log(`≈ ${(countWords(text) / duration * 60).toFixed(0)} wpm   (budget assumes ${TIMING.wordsPerSec * 60})`);
  console.log(`Wrote ${path.relative(ROOT, file)}`);
}

async function probe(apiKey, args) {
  const id = videoIdOf(args.url);
  const videoUrl = `https://www.youtube.com/watch?v=${id}`;
  const durationSec = args.duration ? Number(args.duration) : await fetchDuration(id);
  const model = args.model || AutoAD.DEFAULTS.videoModel;
  console.log(`Video ${id}  duration ${durationSec ? formatTime(durationSec) : '?'}  model ${model}\nAnalyzing…`);

  const track = await AutoAD.generateTrack({ apiKey, model, videoUrl, durationSec });
  const dir = path.join(ROOT, 'out', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'track.json'), JSON.stringify({ videoUrl, model, durationSec, ...track }, null, 2));

  const { cues } = track;
  console.log(`\n${cues.length} cues in ${(track.ms / 1000).toFixed(1)}s   usage ${JSON.stringify(track.usage || {})}\n`);
  console.log(`${pad('#', 3)} ${pad('start', 8)} ${pad('end', 8)} ${padL('gap', 5)} ${padL('budget', 6)} ${padL('words', 5)}  text`);
  let over = 0;
  cues.forEach((c, i) => {
    const words = countWords(c.text);
    const budget = wordBudget(c);
    const flag = words > budget ? ' !' : '';
    if (flag) over++;
    console.log(`${pad(i + 1, 3)} ${pad(formatTime(c.start), 8)} ${pad(formatTime(c.end), 8)} ${padL((c.end - c.start).toFixed(1), 5)} ${padL(budget, 6)} ${padL(words + flag, 5)}  ${c.text}`);
  });
  const gaps = cues.map((c) => c.end - c.start);
  if (cues.length) {
    console.log(`\nover word budget: ${over}/${cues.length}   mean gap ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)}s   min gap ${Math.min(...gaps).toFixed(1)}s`);
  }

  const n = args.tts === 'all' ? cues.length : Math.min(cues.length, Number(args.tts) || 0);
  if (!n) return;
  console.log(`\nVoicing ${n} line(s) with ${args['tts-model'] || AutoAD.DEFAULTS.ttsModel} / ${args.voice || AutoAD.DEFAULTS.voice}…\n`);
  console.log(`${pad('#', 3)} ${padL('room', 5)} ${padL('clip', 5)} ${padL('fit', 5)}  verdict`);
  const tally = { fits: 0, speedup: 0, hold: 0 };
  for (let i = 0; i < n; i++) {
    const c = cues[i];
    const file = path.join(dir, `cue-${String(i + 1).padStart(2, '0')}.wav`);
    const { duration } = await speak(apiKey, args, c.text, file);
    const room = Math.max(0.5, c.end - c.start - TIMING.playMargin);
    const fit = duration / room;
    const verdict = fit <= 1 ? 'fits' : fit <= TIMING.maxFit ? `speed-up ×${fit.toFixed(2)}` : `HOLD video ${(duration / TIMING.maxFit - room).toFixed(1)}s`;
    tally[fit <= 1 ? 'fits' : fit <= TIMING.maxFit ? 'speedup' : 'hold']++;
    console.log(`${pad(i + 1, 3)} ${padL(room.toFixed(1), 5)} ${padL(duration.toFixed(1), 5)} ${padL(fit.toFixed(2), 5)}  ${verdict}`);
  }
  console.log(`\nfits ${tally.fits}   speed-up ${tally.speedup}   hold ${tally.hold}   → WAVs in ${path.relative(ROOT, dir)}/`);
}

async function main() {
  loadEnv();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Missing GEMINI_API_KEY. Create .env at the repo root containing:\n  GEMINI_API_KEY=<your key>');
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  if (args['tts-only']) return ttsOnly(apiKey, args, typeof args['tts-only'] === 'string' ? args['tts-only'] : args.url);
  if (!args.url) {
    console.error('Usage: node scripts/probe.cjs <youtube-url> [--tts N|all] [--duration SEC] [--model M] [--voice V]\n       node scripts/probe.cjs --tts-only "Text to speak"');
    process.exit(1);
  }
  return probe(apiKey, args);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
