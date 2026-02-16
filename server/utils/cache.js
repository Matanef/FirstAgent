// server/utils/cache.js

const caches = new Map();

export function getCache(name, ttlMs) {
  if (!caches.has(name)) {
    caches.set(name, { store: new Map(), ttlMs, lastCleanup: Date.now() });
  }
  const cache = caches.get(name);

  // simple periodic cleanup
  const now = Date.now();
  if (now - cache.lastCleanup > cache.ttlMs) {
    for (const [key, entry] of cache.store.entries()) {
      if (now - entry.timestamp > cache.ttlMs) {
        cache.store.delete(key);
      }
    }
    cache.lastCleanup = now;
  }

  return {
    get(key) {
      const entry = cache.store.get(key);
      if (!entry) return null;
      if (now - entry.timestamp > cache.ttlMs) {
        cache.store.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value) {
      cache.store.set(key, { value, timestamp: Date.now() });
    }
  };
}