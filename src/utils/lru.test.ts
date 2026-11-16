import { expect, it } from 'vitest'
import { LruCache } from './lru'
it('bounds memory and retains recently accessed entries', () => {
  const cache = new LruCache<string, number>(2)
  cache.set('a', 1)
  cache.set('b', 2)
  expect(cache.get('a')).toBe(1)
  cache.set('c', 3)
  expect(cache.has('a')).toBe(true)
  expect(cache.has('b')).toBe(false)
  cache.set('a', 4)
  expect(cache.get('a')).toBe(4)
})
