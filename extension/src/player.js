// Plays pre-rendered AD clips inside the gaps of any <video>, following play/pause/seek/rate.
// No YouTube-specific code here; content.js wires it to the YouTube player.
(function (root) {
  const { TIMING } = root.AutoAD;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  class ADPlayer {
    // cues: sorted [{start, end, text, clip?: {url, duration}}] in seconds.
    // overrun: 'hold' pauses the video until a too-long clip finishes; 'drop' skips clips that can't fit at maxFit.
    constructor(video, cues, opts = {}) {
      this.video = video;
      this.cues = cues;
      this.opts = {
        margin: TIMING.playMargin,
        maxFit: TIMING.maxFit,
        lateTolerance: 0.75,
        duck: 0.5,
        overrun: "hold",
        speed: 1,
        ...opts,
      };
      this.onEvent = opts.onEvent || (() => {});
      this.next = 0;
      this.active = null; // {i, cue, audio, fit}
      this.pausedByAD = false;
      this.suspended = false;
      this.enabled = true;
      this.ducked = null; // {from, to}
      this.timer = 0;

      this.handlers = {
        play: () => this.onPlay(),
        pause: () => this.onPause(),
        seeking: () => this.onSeeking(),
        ratechange: () => this.applyRate(),
        volumechange: () => this.onVolumeChange(),
        ended: () => this.stopActive("ended"),
        timeupdate: () => this.tick(),
      };
      for (const [type, fn] of Object.entries(this.handlers))
        video.addEventListener(type, fn);
      this.seekTo(video.currentTime);
      if (!video.paused) this.startTimer();
    }

    setClip(i, clip) {
      const cue = this.cues[i];
      if (cue.clip) URL.revokeObjectURL(cue.clip.url);
      if (cue.audio) {
        cue.audio.pause();
        cue.audio.src = "";
      }
      cue.clip = clip;
      cue.audio = new Audio(clip.url);
      cue.audio.preload = "auto";
      cue.audio.preservesPitch = true;
    }

    setSpeed(speed) {
      this.opts.speed = speed;
      this.applyRate();
    }

    setEnabled(on) {
      this.enabled = on;
      if (!on) this.stopActive("disabled");
      else this.seekTo(this.video.currentTime);
    }

    // For ads: the <video> plays other media, so its currentTime is not ours.
    suspend() {
      this.suspended = true;
      this.stopActive("suspended");
    }

    resume() {
      this.suspended = false;
      this.seekTo(this.video.currentTime);
    }

    destroy() {
      this.stopActive("destroyed");
      clearInterval(this.timer);
      for (const [type, fn] of Object.entries(this.handlers))
        this.video.removeEventListener(type, fn);
      for (const cue of this.cues) {
        if (cue.audio) cue.audio.src = "";
        if (cue.clip) URL.revokeObjectURL(cue.clip.url);
      }
    }

    // --- timeline ---

    // timeupdate is only ~4 Hz; a 100 ms timer while playing tightens cue starts.
    // Timers keep running in background tabs that play audio, unlike requestAnimationFrame.
    startTimer() {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), 100);
    }

    tick() {
      if (!this.enabled || this.suspended) return;
      const v = this.video;
      const t = v.currentTime;
      const a = this.active;
      if (a) {
        if (this.opts.overrun === "drop" && t >= a.cue.end - this.opts.margin) {
          this.stopActive("gap-ended");
          return;
        }
        if (
          this.opts.overrun === "hold" &&
          !v.paused &&
          !a.audio.paused &&
          t >= a.cue.end - 0.05
        ) {
          this.pausedByAD = true;
          v.pause();
          this.emit("hold", a);
        }
        return;
      }
      if (v.paused) return;
      while (
        this.next < this.cues.length &&
        t > this.cues[this.next].start + this.opts.lateTolerance
      ) {
        this.emit("missed", { i: this.next, cue: this.cues[this.next] });
        this.next++;
      }
      const cue = this.cues[this.next];
      if (cue && t >= cue.start) {
        const i = this.next++;
        if (!cue.clip) this.emit("not-ready", { i, cue });
        else this.start(i, cue, t);
      }
    }

    start(i, cue, t) {
      const room = Math.max(0.5, cue.end - t - this.opts.margin);
      const need = cue.clip.duration / (room * this.opts.speed);
      if (need > this.opts.maxFit && this.opts.overrun === "drop") {
        this.emit("dropped", { i, cue, need });
        return;
      }
      const audio = cue.audio;
      const fit = clamp(need, 1, this.opts.maxFit);
      const active = (this.active = { i, cue, audio, fit, need });
      audio.currentTime = 0;
      audio.onended = () => {
        if (this.active === active) this.finish();
      };
      this.duck();
      audio.volume = this.ducked ? this.ducked.from : this.video.volume;
      this.applyRate();
      audio.play().catch((err) => {
        if (this.active !== active) return;
        this.emit("error", { i, cue, error: err.message });
        this.finish();
      });
      this.emit("start", this.active);
    }

    finish() {
      const a = this.active;
      if (!a) return;
      a.audio.onended = null;
      this.active = null;
      this.unduck();
      this.emit("end", a);
      if (this.pausedByAD) {
        this.pausedByAD = false;
        this.video.play();
      }
    }

    stopActive(reason) {
      const a = this.active;
      if (!a) return;
      a.audio.onended = null;
      a.audio.pause();
      a.audio.currentTime = 0;
      this.active = null;
      this.unduck();
      this.emit("stop", { ...a, reason });
    }

    seekTo(t) {
      const { lateTolerance } = this.opts;
      let lo = 0;
      let hi = this.cues.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.cues[mid].start + lateTolerance < t) lo = mid + 1;
        else hi = mid;
      }
      this.next = lo;
    }

    applyRate() {
      const a = this.active;
      if (a)
        a.audio.playbackRate = clamp(
          a.fit * this.opts.speed * this.video.playbackRate,
          0.25,
          8,
        );
    }

    // --- video events ---

    onPlay() {
      this.pausedByAD = false; // the user resumed during a hold: their call
      const a = this.active;
      if (a && a.audio.paused && this.enabled && !this.suspended) {
        a.audio.play().catch(() => {});
        this.emit("resume", a);
      }
      this.startTimer();
    }

    onPause() {
      if (this.pausedByAD) return; // our own hold; the clip keeps playing
      clearInterval(this.timer);
      const a = this.active;
      if (a && !a.audio.paused) {
        a.audio.pause();
        this.emit("pause", a);
      }
    }

    onSeeking() {
      this.stopActive("seek");
      if (this.pausedByAD) {
        this.pausedByAD = false;
        this.video.play();
      }
      this.seekTo(this.video.currentTime);
    }

    // --- ducking: lower the video under a clip, restore afterwards unless the user changed volume ---

    duck() {
      if (this.ducked) return;
      const from = this.video.volume;
      const to = from * this.opts.duck;
      this.ducked = { from, to };
      this.video.volume = to;
    }

    unduck() {
      if (!this.ducked) return;
      this.video.volume = this.ducked.from;
      this.ducked = null;
    }

    onVolumeChange() {
      if (this.ducked && Math.abs(this.video.volume - this.ducked.to) > 0.01)
        this.ducked = null;
    }

    emit(type, data) {
      this.onEvent(type, { ...data, t: this.video.currentTime });
    }
  }

  root.AutoAD.ADPlayer = ADPlayer;
})(globalThis);
