(function (root) {
  const A = root.AutoAD;
  class Panel {
    constructor(actions) {
      this.actions = actions;
      this.root = document.createElement("aside");
      this.root.className = "autoad-ui";
      this.root.setAttribute("aria-label", "AutoAD audio description controls");
      // All markup is static. Model output and video content are assigned with textContent only.
      this.root.innerHTML = `
        <header class="autoad-header"><h2><span aria-hidden="true">▥</span> AutoAD</h2><button type="button" data-action="gemini">✦ Open Gemini</button><button type="button" data-action="collapse" aria-expanded="true" aria-controls="autoad-body">Collapse</button></header>
        <div id="autoad-body">
          <p class="autoad-status" role="status" aria-live="polite" aria-atomic="true">Description is off</p>
          <p class="autoad-error" role="alert" hidden></p>
          <button type="button" class="autoad-primary autoad-btn" data-action="main">Enable descriptions</button>
          <button type="button" data-action="continue" class="autoad-continue" hidden>Continue video</button>
          <section class="autoad-card" aria-labelledby="autoad-current"><h3 id="autoad-current">Current description / answer</h3><p class="autoad-line">Enable descriptions to begin.</p><button type="button" data-action="repeat" disabled>↻ Repeat last description</button></section>
          <section class="autoad-question-block" aria-labelledby="autoad-ask-title"><h3 id="autoad-ask-title">Ask about this scene</h3><div class="autoad-row"><button type="button" class="autoad-mic" data-action="voice">Ask by voice</button><button type="button" class="autoad-ask" data-action="describe">Describe this moment</button></div><label for="autoad-question">Your question</label><div class="autoad-row"><input id="autoad-question" class="autoad-question" type="text" maxlength="500" placeholder="What is happening here?"><button type="button" class="autoad-send" data-action="send">Send question</button></div><button type="button" class="autoad-copy" data-action="copy">Copy discussion context</button></section>
          <fieldset><legend>Voice</legend><div class="autoad-row"><select aria-label="Narration voice" data-setting="voice"></select><button type="button" data-action="preview">Preview voice</button></div></fieldset>
          <details class="autoad-connection"><summary>Connection and storage</summary><form class="autoad-key-form"><label for="autoad-key">Gemini API key</label><input id="autoad-key" type="password" autocomplete="off"><p class="autoad-hint">Stored in this browser. Never included in copied context.</p><button type="submit">Save API key</button></form><div class="autoad-models"></div><button type="button" data-action="clear">Clear cached descriptions</button></details>
          <p class="autoad-foot" role="status">Preferences saved automatically</p>
        </div>`;
      this.$ = (selector) => this.root.querySelector(selector);
      for (const event of [
        "click",
        "mousedown",
        "mouseup",
        "dblclick",
        "keydown",
        "keyup",
      ])
        this.root.addEventListener(event, (e) => e.stopPropagation());
      this.root.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          const active = document.activeElement;
          const details = active?.closest("details");
          if (details?.open) {
            details.open = false;
            details.querySelector("summary").focus();
            e.preventDefault();
          }
        }
      });
      this.root.addEventListener("click", (e) => {
        const button = e.target.closest("button[data-action]");
        if (!button) return;
        if (button.dataset.action === "collapse") {
          const open = button.getAttribute("aria-expanded") === "true";
          this.$("#autoad-body").hidden = open;
          button.setAttribute("aria-expanded", String(!open));
          button.textContent = open ? "Expand" : "Collapse";
          return;
        }
        actions[button.dataset.action]?.();
      });
      this.$(".autoad-question").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          actions.send();
        }
      });
      this.$(".autoad-key-form").addEventListener("submit", (e) => {
        e.preventDefault();
        actions.setting("apiKey", this.$("#autoad-key").value.trim());
        this.$("#autoad-key").value = "";
      });
      for (const voice of A.VOICES)
        this.$("select").add(new Option(voice, voice));
      for (const [key, label] of [
        ["videoModel", "Video model"],
        ["ttsModel", "Voice model"],
        ["liveModel", "Live model"],
      ]) {
        const el = document.createElement("label");
        el.textContent = label;
        const input = document.createElement("input");
        input.type = "text";
        input.dataset.setting = key;
        el.append(input);
        this.$(".autoad-models").append(el);
      }
      this.root.addEventListener("change", (e) => {
        if (e.target.dataset.setting)
          actions.setting(e.target.dataset.setting, e.target.value);
      });
      this.position = () => {
        const fullscreen = document.fullscreenElement;
        const secondary = document.querySelector("ytd-watch-flexy #secondary");
        const parent = fullscreen || secondary || document.body;
        if (this.root.parentNode !== parent) parent.prepend(this.root);
        this.root.classList.toggle(
          "autoad-floating",
          !secondary || !!fullscreen,
        );
        this.root.classList.toggle("autoad-fullscreen", !!fullscreen);
      };
      document.addEventListener("fullscreenchange", this.position);
      this.position();
    }
    update(s, settings) {
      this.root.hidden = !s;
      if (!s) return;
      this.position();
      const state = s.control?.state || "off";
      const states = {
        off: "Description is off",
        preparing: "Preparing descriptions…",
        ready: s.noGaps
          ? "Ready — no description gaps in the next minute"
          : "Ready — Continue video",
        watching: "Description is on",
        recording: "Listening — Stop & send when finished",
        starting: "Preparing microphone…",
        waiting: "Gemini is answering…",
        speaking: "Playing answer",
        paused: "Video paused",
        error: "Needs attention",
        ad: "Advertisement — descriptions paused",
      };
      this.$(".autoad-status").textContent = !settings.apiKey
        ? "Add a Gemini API key to begin"
        : states[state] || state;
      this.$(".autoad-error").hidden = !s.error;
      this.$(".autoad-error").textContent = s.error || "";
      const main = this.$("[data-action=main]");
      main.textContent =
        state === "error"
          ? "Retry"
          : [
                "ready",
                "paused",
                "speaking",
                "recording",
                "waiting",
                "starting",
              ].includes(state)
            ? "Continue video"
            : !s.enabled
              ? "Enable descriptions"
              : state === "preparing"
                ? "Preparing descriptions…"
                : "Pause descriptions";
      main.disabled =
        !settings.apiKey || state === "preparing" || state === "ad";
      this.$("[data-action=continue]").hidden =
        !s.video?.paused ||
        state === "off" ||
        main.textContent === "Continue video";
      this.$("[data-action=repeat]").disabled = !s.lastSpeech;
      const busy = [
        "preparing",
        "starting",
        "waiting",
        "recording",
        "ad",
      ].includes(state);
      for (const selector of [
        ".autoad-question",
        ".autoad-send",
        ".autoad-ask",
      ])
        this.$(selector).disabled = !settings.apiKey || !s.video || busy;
      const mic = this.$(".autoad-mic");
      mic.disabled =
        !settings.apiKey || !s.video || (busy && state !== "recording");
      mic.textContent = state === "recording" ? "Stop & send" : "Ask by voice";
      mic.setAttribute("aria-pressed", String(state === "recording"));
      this.$("[data-action=preview]").disabled = !settings.apiKey || busy;
      for (const el of this.root.querySelectorAll("[data-setting]")) {
        if (el.type === "radio")
          el.checked = String(settings[el.dataset.setting]) === el.value;
        else if (document.activeElement !== el)
          el.value = settings[el.dataset.setting];
      }
      if (!settings.apiKey) this.$("details").open = true;
    }
    text(text) {
      this.$(".autoad-line").textContent = text;
    }
    notice(text) {
      this.$(".autoad-foot").textContent = text;
    }
    question() {
      return this.$(".autoad-question").value;
    }
    clearQuestion() {
      this.$(".autoad-question").value = "";
    }
  }
  A.Panel = Panel;
})(globalThis);
