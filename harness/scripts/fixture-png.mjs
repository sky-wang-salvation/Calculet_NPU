import { deflateSync } from 'node:zlib'

// Deterministic protocol-test bytes, not a generated model image.
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const name = Buffer.from(type)
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, crc])
}
export function fixturePng() {
  const width = 480, height = 270
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  const glyphs = ['11111001000010000100001000010000100', '11111100001000011110100001000011111',
    '11111100001000011111000010000111111', '11111001000010000100001000010000100']
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (width * 3 + 1) + 1 + x * 3
    const bar = Math.floor(x / 80)
    let color = [[28, 54, 81], [29, 88, 106], [29, 126, 123], [75, 152, 121], [171, 183, 124], [228, 192, 131]][bar]
    const gx = Math.floor((x - 122) / 10), gy = Math.floor((y - 100) / 10)
    if (gx >= 0 && gx < 24 && gy >= 0 && gy < 7 && gx % 6 < 5 && glyphs[Math.floor(gx / 6)][gy * 5 + gx % 6] === '1') color = [255, 255, 255]
    pixels.set(color, i)
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Description\0TEST FIXTURE ONLY - NO MODEL OR NPU EXECUTION')), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
