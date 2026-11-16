import { expect, it } from 'vitest'
import { decodePixels } from './pixels'

function fixture() {
  const buffer = new ArrayBuffer(32 + 3 * 8 + 1),
    data = new DataView(buffer)
  const header = [0x52414e43, 1, 3, 1, 8, 1, 3, 0]
  header.forEach((value, i) => data.setUint32(i * 4, value, true))
  data.setFloat64(32, 1.2345678901234567, true)
  data.setFloat64(40, -42, true)
  data.setUint8(56, 3)
  return buffer
}
it('decodes little-endian scientific values losslessly and retains missing coverage', () => {
  const values = decodePixels(fixture())
  expect(values[0]).toBe(1.2345678901234567)
  expect(values[1]).toBe(-42)
  expect(values[2]).toBeNaN()
})
it('rejects truncated, unrecognized and dimensionally invalid payloads', () => {
  expect(() => decodePixels(new ArrayBuffer(3))).toThrow('Truncated')
  const unknown = fixture()
  new DataView(unknown).setUint32(0, 0, true)
  expect(() => decodePixels(unknown)).toThrow('Unsupported')
  const mismatch = fixture()
  new DataView(mismatch).setUint32(8, 2, true)
  expect(() => decodePixels(mismatch)).toThrow('dimensions')
})
