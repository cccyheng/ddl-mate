// 探测本机可用字体是否有 TrueType 轮廓（glyf），供 HTML 无关的 PNG 生成器使用。
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const candidates = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyh.ttf',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc',
  'C:/Windows/Fonts/Deng.ttf',
]

function u16(buf, at) { return buf.readUInt16BE(at) }
function u32(buf, at) { return buf.readUInt32BE(at) }

for (const file of candidates) {
  try {
    const buf = await readFile(file)
    const tag = buf.toString('ascii', 0, 4)
    const tables = []
    let offset = 0
    if (tag === 'ttcf') {
      offset = u32(buf, 12) // 第一个字体
      tables.push(`ttc fonts=${u32(buf, 8)}`)
    }
    const numTables = u16(buf, offset + 4)
    const names = []
    for (let i = 0; i < numTables; i += 1) {
      const at = offset + 12 + i * 16
      names.push(buf.toString('ascii', at, at + 4))
    }
    console.log(path.basename(file), `size=${buf.length}`, `tag=${tag}`, tables.join(' '))
    console.log('   tables:', names.join(','))
  } catch (error) {
    console.log(path.basename(file), '不可用:', error.message)
  }
}
