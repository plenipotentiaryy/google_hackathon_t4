(function (root) {
  const A = root.AutoAD;
  const PREFIX = "autoad:v3:";
  async function cacheKey(kind, values) {
    const bytes = new TextEncoder().encode(JSON.stringify(values));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return (
      PREFIX +
      kind +
      ":" +
      Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("")
    );
  }
  class Cache {
    constructor(storage, { limit = 200 * 1024 * 1024, warn = () => {} } = {}) {
      this.storage = storage;
      this.limit = limit;
      this.warn = warn;
      this.pending = new Map();
      this.writes = Promise.resolve();
      this.epoch = 0;
    }
    async get(key) {
      try {
        const hit = (await this.storage.get(key))[key];
        if (!hit?.complete) return null;
        // Serialize metadata updates with writes/eviction. Never restore an evicted entry.
        this.writes = this.writes
          .then(async () => {
            const current = (await this.storage.get(key))[key];
            if (current)
              await this.storage.set({
                [key]: { ...current, used: Date.now() },
              });
          })
          .catch(() => {});
        return hit.value;
      } catch {
        this.warn("Local cache unavailable. Playback can continue.");
        return null;
      }
    }
    put(key, value, expectedEpoch = this.epoch) {
      const entry = { complete: true, value, used: Date.now() };
      entry.bytes =
        new TextEncoder().encode(JSON.stringify(entry)).length + key.length;
      this.writes = this.writes
        .then(async () => {
          if (expectedEpoch !== this.epoch || entry.bytes > this.limit) return;
          const all = await this.storage.get(null);
          const records = Object.entries(all).filter(
            ([k, v]) => k.startsWith(PREFIX) && k !== key && v?.complete,
          );
          let size = records.reduce(
            (n, [, v]) =>
              n +
              (v.bytes || new TextEncoder().encode(JSON.stringify(v)).length),
            entry.bytes,
          );
          const remove = [];
          for (const [k, v] of records.sort((a, b) => a[1].used - b[1].used)) {
            if (size <= this.limit) break;
            remove.push(k);
            size -=
              v.bytes || new TextEncoder().encode(JSON.stringify(v)).length;
          }
          if (remove.length) await this.storage.remove(remove);
          await this.storage.set({ [key]: entry });
        })
        .catch(() =>
          this.warn("Could not save local audio. Playback can continue."),
        );
      return this.writes;
    }
    async obtain(key, producer, signal) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const hit = await this.get(key);
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (hit) return hit;
      // Coalesce within the same cancellation scope; a new session never inherits an aborted promise.
      const existing = this.pending.get(key);
      if (existing && existing.signal === signal) return existing.promise;
      const epoch = this.epoch;
      const slot = { signal };
      slot.promise = (async () => {
        const value = await producer();
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        await this.put(key, value, epoch);
        return value;
      })().finally(() => {
        if (this.pending.get(key) === slot) this.pending.delete(key);
      });
      this.pending.set(key, slot);
      return slot.promise;
    }
    async clear() {
      this.epoch++;
      await this.writes;
      const all = await this.storage.get(null);
      await this.storage.remove(
        Object.keys(all).filter(
          (k) => k.startsWith(PREFIX) || /^(cues:|tts:|scene-index:)/.test(k),
        ),
      );
    }
  }
  Object.assign(A, { Cache, cacheKey });
  if (typeof module !== "undefined") module.exports = { Cache, cacheKey };
})(globalThis);
