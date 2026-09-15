const A = globalThis.AutoAD;
const $ = (id) => document.getElementById(id);
const keys = Object.keys(A.DEFAULT_SETTINGS);
let storage;
let settings = { ...A.DEFAULT_SETTINGS };
function announce(message) {
  $("saved").textContent = message;
}
function render() {
  $("connection-status").textContent = settings.apiKey
    ? "API key saved · Ready to open a video"
    : "Connect Gemini to get started";
  $("connection-status").dataset.ready = String(!!settings.apiKey);
  $("connection-form").hidden = !!settings.apiKey;
  for (const element of document.querySelectorAll("[data-setting]")) {
    if (element.type === "radio")
      element.checked =
        String(settings[element.dataset.setting]) === element.value;
    else if (document.activeElement !== element)
      element.value = settings[element.dataset.setting];
  }
}
function group(key, title, options, target) {
  const field = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = title;
  field.append(legend);
  const row = document.createElement("div");
  row.className = "autoad-choices";
  for (const [value, text] of options) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = key;
    input.value = value;
    input.dataset.setting = key;
    const span = document.createElement("span");
    span.textContent = text;
    label.append(input, span);
    row.append(label);
  }
  field.append(row);
  $(target).append(field);
}
group(
  "speed",
  "Narration speed",
  [
    ["0.75", "0.75×"],
    ["1", "1×"],
    ["1.5", "1.5×"],
    ["2", "2×"],
  ],
  "preferences",
);
group(
  "detail",
  "Description detail",
  [
    ["brief", "Brief"],
    ["standard", "Standard"],
    ["detailed", "Detailed"],
  ],
  "preferences",
);
group(
  "style",
  "Language style",
  [
    ["plain", "Plain"],
    ["academic", "Academic"],
  ],
  "preferences",
);
group(
  "tone",
  "Voice tone",
  [
    ["calm", "Calm"],
    ["cheerful", "Cheerful"],
    ["playful", "Playful"],
  ],
  "tone-group",
);
for (const voice of A.VOICES) $("voice").add(new Option(voice, voice));
async function save(key, value) {
  if (!storage) return;
  try {
    await storage.set({ [key]: key === "speed" ? Number(value) : value });
    settings = A.normalizeSettings({ ...settings, [key]: value });
    render();
    announce("Preferences saved.");
  } catch {
    announce("Could not save preferences. Please try again.");
  }
}
document.addEventListener("change", (event) => {
  const key = event.target.dataset.setting;
  if (key) save(key, event.target.value.trim());
});
$("connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = $("setup-key").value.trim();
  if (!value) {
    announce("Enter your Gemini API key.");
    $("setup-key").focus();
    return;
  }
  await save("apiKey", value);
  if (settings.apiKey) {
    $("setup-key").value = "";
    document.querySelector(".autoad-launch").focus();
  }
});
$("save-key").addEventListener("click", async () => {
  const value = $("apiKey").value.trim();
  if (!value) {
    announce("Enter a replacement API key.");
    $("apiKey").focus();
    return;
  }
  await save("apiKey", value);
  $("apiKey").value = "";
});
$("clear").addEventListener("click", async () => {
  try {
    await new A.Cache(storage).clear();
    announce("Cached descriptions cleared.");
  } catch {
    announce("Could not clear cache. Please try again.");
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    $("connection-details").open &&
    $("connection-details").contains(document.activeElement)
  ) {
    event.preventDefault();
    $("connection-details").open = false;
    $("connection-details").querySelector("summary").focus();
  }
});
render();
(async () => {
  try {
    storage = globalThis.chrome?.storage?.local;
    if (!storage) throw new Error("Unavailable");
    settings = A.normalizeSettings(await storage.get(keys));
    render();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const updates = {};
      for (const key of keys)
        if (key in changes) updates[key] = changes[key].newValue;
      settings = A.normalizeSettings({ ...settings, ...updates });
      render();
    });
  } catch {
    $("storage-error").hidden = false;
    $("storage-error").textContent =
      "Browser storage is unavailable. Reopen AutoAD from the Chrome extensions toolbar.";
    for (const element of document.querySelectorAll("input,select,button"))
      element.disabled = true;
  }
})();
