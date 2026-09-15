(function (root) {
  const A = root.AutoAD;
  const VOICES = [
    "Zephyr",
    "Puck",
    "Charon",
    "Kore",
    "Fenrir",
    "Leda",
    "Orus",
    "Aoede",
    "Callirrhoe",
    "Autonoe",
    "Enceladus",
    "Iapetus",
    "Umbriel",
    "Algieba",
    "Despina",
    "Erinome",
    "Algenib",
    "Rasalgethi",
    "Laomedeia",
    "Achernar",
    "Alnilam",
    "Schedar",
    "Gacrux",
    "Pulcherrima",
    "Achird",
    "Zubenelgenubi",
    "Vindemiatrix",
    "Sadachbia",
    "Sadaltager",
    "Sulafat",
  ];
  const DEFAULT_SETTINGS = {
    ...A.DEFAULTS,
    apiKey: "",
    enabled: false,
    speed: 1,
    detail: "standard",
    style: "plain",
    tone: "calm",
    liveModel: "gemini-3.1-flash-live-preview",
  };
  function normalizeSettings(input = {}) {
    const s = { ...DEFAULT_SETTINGS };
    for (const k of ["apiKey", "videoModel", "ttsModel", "liveModel"])
      if (typeof input[k] === "string" && input[k].trim())
        s[k] = input[k].trim();
    if (VOICES.includes(input.voice)) s.voice = input.voice;
    if ([0.75, 1, 1.5, 2].includes(Number(input.speed)))
      s.speed = Number(input.speed);
    if (["brief", "standard", "detailed"].includes(input.detail))
      s.detail = input.detail;
    if (["plain", "academic"].includes(input.style)) s.style = input.style;
    if (["calm", "cheerful", "playful"].includes(input.tone))
      s.tone = input.tone;
    s.enabled = input.enabled === true;
    return s;
  }
  Object.assign(A, { VOICES, DEFAULT_SETTINGS, normalizeSettings });
  if (typeof module !== "undefined") module.exports = A;
})(globalThis);
