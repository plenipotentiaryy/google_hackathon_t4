(function (root) {
  class Coordinator {
    constructor(video, { cancelSpeech = () => {}, changed = () => {} } = {}) {
      this.video = video;
      this.cancelSpeech = cancelSpeech;
      this.changed = changed;
      this.state = "off";
      this.generation = 0;
      this.request = null;
    }
    set(state) {
      this.state = state;
      this.changed(state);
    }
    cancel() {
      this.generation++;
      this.request?.abort();
      this.request = null;
      this.cancelSpeech();
    }
    pause(state = "paused") {
      this.cancel();
      this.video.pause();
      this.set(state);
    }
    begin(state = "waiting") {
      this.pause(state);
      this.request = new AbortController();
      return { generation: this.generation, signal: this.request.signal };
    }
    valid(token) {
      return token.generation === this.generation && !token.signal.aborted;
    }
    async resume() {
      this.cancel();
      this.set("watching");
      try {
        await this.video.play();
      } catch (e) {
        this.set("error");
        throw e;
      }
    }
    dispose() {
      this.cancel();
    }
  }
  globalThis.AutoAD.Coordinator = Coordinator;
  if (typeof module !== "undefined") module.exports = Coordinator;
})(globalThis);
