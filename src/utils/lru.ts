export class LruCache<K, V> {
  private entries = new Map<K, V>()
  private limit: number
  constructor(limit: number) {
    this.limit = limit
  }
  get(key: K): V | undefined {
    const value = this.entries.get(key)
    if (value !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, value)
    }
    return value
  }
  has(key: K) {
    return this.entries.has(key)
  }
  delete(key: K) {
    return this.entries.delete(key)
  }
  set(key: K, value: V) {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!)
  }
}
