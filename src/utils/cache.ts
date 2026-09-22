/**
 * Tiny LRU cache — sync, fixed max size, no timers.
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly maxSize: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
