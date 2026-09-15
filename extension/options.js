const { DEFAULTS } = globalThis.AutoAD;
const FIELDS = ["apiKey", "videoModel", "ttsModel", "voice", "enabled"];
const VOICES = AutoAD.VOICES;

const $ = (id) => document.getElementById(id);
for (const v of VOICES) $("voice").add(new Option(v, v));

let flashTimer = 0;
function flash(msg) {
  $("saved").textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ($("saved").textContent = ""), 1500);
}

(async () => {
  const stored = await chrome.storage.local.get(FIELDS);
  const s = { ...AutoAD.DEFAULT_SETTINGS };
  for (const k of FIELDS)
    if (stored[k] !== undefined && stored[k] !== "") s[k] = stored[k];

  for (const k of FIELDS) {
    const el = $(k);
    if (el.type === "checkbox") el.checked = !!s[k];
    else el.value = s[k];
    el.addEventListener("change", async () => {
      await chrome.storage.local.set({
        [k]: el.type === "checkbox" ? el.checked : el.value.trim(),
      });
      flash("Saved");
    });
  }

  $("clear").addEventListener("click", async () => {
    try {
      await new AutoAD.Cache(chrome.storage.local).clear();
      flash("Cache cleared");
    } catch {
      flash("Could not clear cache");
    }
  });
})();
