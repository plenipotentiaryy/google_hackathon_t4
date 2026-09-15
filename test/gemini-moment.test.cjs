const assert = require('node:assert/strict');
const test = require('node:test');
const AutoAD = require('../extension/src/gemini.js');

test('scene questions send a YouTube video URI without unsupported processing options', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  let request;
  global.fetch = async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'The track is red.' }] }],
      }),
    };
  };

  const answer = await AutoAD.describeMoment({
    apiKey: 'test-key',
    videoUrl: 'https://www.youtube.com/watch?v=demo123',
    currentSec: 30,
    durationSec: 120,
    question: 'What color is the track?',
    conversation: [{ question: 'What happened before?', answer: 'A runner reaches the bend.' }],
  });

  assert.equal(answer, 'The track is red.');
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['x-goog-api-key'], 'test-key');

  const [video, prompt] = request.body.input;
  assert.deepEqual(video, { type: 'video', uri: 'https://www.youtube.com/watch?v=demo123' });
  assert.equal(Object.hasOwn(video, 'processing'), false);
  assert.match(prompt.text, /paused at 00:30\.0/);
  assert.match(prompt.text, /preceding 8 seconds/);
  assert.match(prompt.text, /Viewer question: What color is the track\?/);
  assert.match(prompt.text, /Viewer: What happened before\?\s+Assistant: A runner reaches the bend\./);
});

test('startup scene indexing requests detailed time-coded sections', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  let request;
  global.fetch = async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        steps: [{
          type: 'model_output',
          content: [{ type: 'text', text: JSON.stringify({ scenes: [
            { start: '00:00.0', end: '00:08.0', description: 'A runner enters a red track from the left.', visible_text: '' },
            { start: '00:08.0', end: '00:16.0', description: 'The runner slows beside a blue bench.', visible_text: 'FINISH' },
          ] }) }],
        }],
      }),
    };
  };

  const result = await AutoAD.generateSceneIndex({
    apiKey: 'test-key',
    videoUrl: 'https://www.youtube.com/watch?v=demo123',
    durationSec: 16,
  });

  const [video, prompt] = request.body.input;
  assert.deepEqual(video, { type: 'video', uri: 'https://www.youtube.com/watch?v=demo123' });
  assert.equal(Object.hasOwn(video, 'processing'), false);
  assert.match(prompt.text, /time-indexed visual scene guide/);
  assert.match(prompt.text, /6–10 seconds each/);
  assert.match(prompt.text, /colors/);
  assert.deepEqual(result.scenes.map((scene) => [scene.start, scene.end, scene.visibleText]), [
    [0, 8, ''], [8, 16, 'FINISH'],
  ]);
});
