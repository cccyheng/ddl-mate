/**
 * 内容哈希（SHA-256）——**同源码可跑在 Hermes 与 Node 两边**。
 *
 * 用途只有两个：
 * 1. 截图去重（同一张图重复提交时能认出来）；
 * 2. 校验归档文件与登记表里记录的哈希一致（恢复来源是否真的是那一张）。
 *
 * 为什么不用 `node:crypto`：这段代码会被 Metro 打进 iOS bundle，Hermes 里没有
 * `node:crypto`。因此优先用标准的 `crypto.subtle`（Hermes / Node 都有），
 * 实在没有时退回下面这份**纯 JS 的 SHA-256 实现**（FIPS 180-4），
 * 保证任何运行环境都不会因为「拿不到哈希」而整条截图归档流程失败。
 *
 * 纯 JS 版本只用于几十 KB–几 MB 的字节数组，实测足够快；它不是密码学用途，
 * 只是内容指纹。
 */

/** 优先 `crypto.subtle`；不可用时返回 `null`。 */
function subtleDigest(): ((algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>) | null {
  const globalCrypto = (globalThis as { crypto?: { subtle?: { digest?: unknown } } }).crypto
  const digest = globalCrypto?.subtle?.digest
  if (typeof digest !== 'function') return null
  return (algorithm, data) => (digest as (a: string, d: Uint8Array) => Promise<ArrayBuffer>).call(globalCrypto!.subtle, algorithm, data)
}

/* ------------------------- 纯 JS SHA-256（回退实现） ------------------------- */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

function sha256Fallback(bytes: Uint8Array): string {
  const length = bytes.length
  const bitLength = length * 8
  const withPadding = new Uint8Array((((length + 8) >> 6) + 1) << 6)
  withPadding.set(bytes)
  withPadding[length] = 0x80
  // 64 位大端长度（截图不可能超过 2^32 位，高 32 位固定写 0）。
  const view = new DataView(withPadding.buffer)
  view.setUint32(withPadding.length - 4, bitLength >>> 0, false)
  view.setUint32(withPadding.length - 8, Math.floor(bitLength / 0x100000000), false)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(offset + index * 4, false)
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3)
      const s1 = rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10)
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!]
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (hh + s1 + ch + K[index]! + w[index]!) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h[0] = (h[0]! + a) >>> 0
    h[1] = (h[1]! + b) >>> 0
    h[2] = (h[2]! + c) >>> 0
    h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0
    h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0
    h[7] = (h[7]! + hh) >>> 0
  }

  let out = ''
  for (const value of h) out += value.toString(16).padStart(8, '0')
  return out
}

/** 字节数组 → 小写十六进制 SHA-256。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = subtleDigest()
  if (digest) {
    try {
      const buffer = await digest('SHA-256', bytes)
      return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    } catch {
      // 落到纯 JS 实现，绝不让「哈希失败」阻断归档。
    }
  }
  return sha256Fallback(bytes)
}

/** base64 → 字节数组（不依赖 `Buffer`，Hermes 里没有它）。 */
export function base64ToBytes(base64: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = String(base64 ?? '').replace(/\s/g, '').replace(/^data:[^,]*,/, '')
  const usable = clean.replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor((usable.length * 3) / 4))
  let byteIndex = 0
  let chunk = 0
  let chunkBits = 0
  for (const char of usable) {
    const value = alphabet.indexOf(char)
    if (value < 0) continue
    chunk = (chunk << 6) | value
    chunkBits += 6
    if (chunkBits >= 8) {
      chunkBits -= 8
      bytes[byteIndex] = (chunk >> chunkBits) & 0xff
      byteIndex += 1
    }
  }
  return bytes.subarray(0, byteIndex)
}

/** 小写十六进制 SHA-256（base64 输入）。 */
export async function sha256HexOfBase64(base64: string): Promise<string> {
  return sha256Hex(base64ToBytes(base64))
}
