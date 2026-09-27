// ============================================
// 🗃️ 크기·TTL 제한 인메모리 캐시
// ============================================
// 항목 수가 maxEntries를 넘으면 가장 오래 넣은 항목부터 버린다.
// 만료 항목은 조회 시 지운다 (별도 타이머 없음).

class BoundedTtlCache {
  constructor(ttlMs, maxEntries, now = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.map.delete(key);
    while (this.map.size >= this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { BoundedTtlCache };
