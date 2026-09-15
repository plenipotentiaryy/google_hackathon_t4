const panel = new AutoAD.Panel({});
const settings = { ...AutoAD.DEFAULT_SETTINGS, apiKey: "layout-fixture" };
const states = ["off", "preparing", "ad", "ready", "paused", "error"];
function setState(state) {
  panel.update(
    {
      enabled: state !== "off",
      control: { state },
      video: { paused: state !== "off" },
      lastSpeech: state === "paused" ? {} : null,
      error:
        state === "error"
          ? "Could not prepare descriptions. Retry or continue video."
          : "",
    },
    settings,
  );
  panel.text(
    state === "paused"
      ? "A woman in a red coat enters the café."
      : "Enable descriptions to begin.",
  );
}
function check() {
  const results = [];
  for (const state of states) {
    setState(state);
    const box = panel.root.getBoundingClientRect();
    const last = panel.root.querySelector("summary").getBoundingClientRect();
    const logo = panel.root.querySelector("[data-action=gemini]");
    const lbox = logo.getBoundingClientRect();
    results.push({
      state,
      width: box.width,
      height: box.height,
      scroll: panel.root.scrollHeight > panel.root.clientHeight + 1,
      allControlsVisible: last.bottom <= box.bottom,
      logo: [lbox.width, lbox.height],
      accessibleName: logo.getAttribute("aria-label"),
    });
  }
  document.getElementById("results").textContent = JSON.stringify(
    { viewport: [innerWidth, innerHeight], results },
    null,
    2,
  );
  setState("paused");
}
document.getElementById("run").onclick = check;
document.getElementById("long").onclick = () => {
  setState("paused");
  panel.text("A detailed scene description. ".repeat(100));
};
check();
