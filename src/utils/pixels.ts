export type PixelValues = readonly (number | null)[] | Float64Array

export function decodePixels(buffer: ArrayBuffer): Float64Array {
  if (buffer.byteLength < 32) throw new Error('Truncated pixel array')
  const header = new DataView(buffer)
  if (header.getUint32(0, true) !== 0x52414e43 || header.getUint32(4, true) !== 1)
    throw new Error('Unsupported pixel array format')
  const width = header.getUint32(8, true),
    height = header.getUint32(12, true)
  const elementSize = header.getUint32(16, true),
    maskBytes = header.getUint32(20, true),
    count = header.getUint32(24, true)
  if (
    !width ||
    !height ||
    width * height !== count ||
    elementSize !== 8 ||
    maskBytes !== Math.ceil(count / 8) ||
    buffer.byteLength !== 32 + count * 8 + maskBytes
  )
    throw new Error('Invalid pixel array dimensions')
  const pixels = new Float64Array(count)
  const mask = new Uint8Array(buffer, 32 + count * 8, maskBytes)
  for (let i = 0; i < count; i++)
    pixels[i] = mask[i >> 3] & (1 << (i & 7)) ? header.getFloat64(32 + i * 8, true) : NaN
  return pixels
}
