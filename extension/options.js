const { DEFAULTS } = globalThis.AutoAD;
const FIELDS = ['apiKey', 'videoModel', 'ttsModel', 'voice', 'enabled'];
const VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

const $ = (id) => document.getElementById(id);
for (const v of VOICES) $('voice').add(new Option(v, v));

let flashTimer = 0;
function flash(msg) {
  $('saved').textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ($('saved').textContent = ''), 1500);
}

(async () => {
  const stored = await chrome.storage.local.get(FIELDS);
  const s = { ...DEFAULTS, apiKey: '', enabled: true };
  for (const k of FIELDS) if (stored[k] !== undefined && stored[k] !== '') s[k] = stored[k];

  for (const k of FIELDS) {
    const el = $(k);
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k];
    el.addEventListener('change', async () => {
      await chrome.storage.local.set({ [k]: el.type === 'checkbox' ? el.checked : el.value.trim() });
      flash('Saved');
    });
  }

  $('clear').addEventListener('click', async () => {
    const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('cues:') || k.startsWith('tts:'));
    await chrome.storage.local.remove(keys);
    flash(`Cleared ${keys.length} entries`);
  });
})();
