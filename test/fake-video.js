// Small HTMLMediaElement-shaped clock for deterministic browser tests. It lets
// ADPlayer tests cover pause, seek, rate and volume without committing a large
// binary fixture to the repository.
class FakeVideo extends EventTarget {
  constructor({ duration = 60 } = {}) {
    super();
    this.duration = duration;
    this.readyState = 1;
    this.paused = true;
    this.seeking = false;
    this._time = 0;
    this._rate = 1;
    this._volume = 1;
    this._timer = 0;
    this._lastTick = 0;
  }

  get currentTime() { return this._time; }
  set currentTime(value) {
    this._time = Math.max(0, Math.min(this.duration, Number(value) || 0));
    this.seeking = true;
    this.dispatchEvent(new Event('seeking'));
    this.seeking = false;
    this.dispatchEvent(new Event('seeked'));
    this.dispatchEvent(new Event('timeupdate'));
  }

  get playbackRate() { return this._rate; }
  set playbackRate(value) {
    this._rate = Number(value) || 1;
    this.dispatchEvent(new Event('ratechange'));
  }

  get volume() { return this._volume; }
  set volume(value) {
    this._volume = Math.max(0, Math.min(1, Number(value) || 0));
    this.dispatchEvent(new Event('volumechange'));
  }

  play() {
    if (!this.paused) return Promise.resolve();
    this.paused = false;
    this._lastTick = performance.now();
    this._timer = setInterval(() => this.#tick(), 20);
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    clearInterval(this._timer);
    this._timer = 0;
    this.dispatchEvent(new Event('pause'));
  }

  #tick() {
    if (this.paused) return;
    const now = performance.now();
    this._time = Math.min(this.duration, this._time + ((now - this._lastTick) / 1000) * this._rate);
    this._lastTick = now;
    this.dispatchEvent(new Event('timeupdate'));
    if (this._time >= this.duration) {
      this.paused = true;
      clearInterval(this._timer);
      this._timer = 0;
      this.dispatchEvent(new Event('pause'));
      this.dispatchEvent(new Event('ended'));
    }
  }
}
