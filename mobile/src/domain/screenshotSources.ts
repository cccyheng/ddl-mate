/**
 * **取回历史截图所必需的最小清单**（离线兜底）。
 *
 * 为什么要有这个文件：
 * - 用户明确要求「把以前那些截图也放进软件里」；
 * - 那几张图只存在于**电脑工作区**（`.tools/photo/...`），手机相册里没有；
 * - 但**绝不能**把某个人具体的课表事实写进产品源码，也绝不能读任意文件系统路径。
 *
 * 因此这里**只**放「离线恢复必须知道的东西」：
 * 1. 稳定的 `catalogKey`（取回文件、写库 upsert 都用它）；
 * 2. 电脑上的**相对路径**（服务端只允许这个目录下的这份文件）；
 * 3. 内容 SHA256 与字节数 —— 下载完必须逐字节校验，否则无法确认取到的是哪一份。
 *
 * 刻意**不**放任何描述性内容（标题里的星期 / 课程名、图上有什么没有什么）：
 * 那些属于**电脑上的目录数据**（`.tools/photo/archive-catalog.json`），
 * App 通过 `GET /v1/archive/sources` 读回来并持久化进本机
 * `source_screenshots`，之后离线也能看到；读不到时界面只显示这里的中性标题。
 *
 * 这里**没有图片字节**，也没有课程记录。取回是用户在界面上的显式动作，
 * 取回后按普通截图走一遍识别 → 核对 → 导入。
 */

/**
 * 一条离线兜底来源。
 *
 * 只含「怎么找到并验证那一份文件」的信息，不含任何个人课表内容。
 */
export interface KnownSourceEntry {
  /** 稳定键（数据库 `source_screenshots.catalog_key` 用它做 upsert）。 */
  catalogKey: string
  /** 中性标题（**不含**星期 / 课程 / 图上内容等个人信息）。 */
  neutralTitle: string
  /** **工作区相对路径**（不是绝对路径；服务端只允许这个目录下的这份文件）。 */
  archiveRelPath: string
  /** 小写十六进制 SHA-256；取回后逐字节校验，防止拿到别的东西。 */
  sha256: string
  byteLength: number
  /** 文件大概是什么形态（只用于界面占位，不含个人内容）。 */
  kind: 'vertical-cards' | 'horizontal-grid'
}

/** 小写十六进制 SHA-256 的形状校验（宁可在这里拦住，也不要把坏数据写进库）。 */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/**
 * 离线兜底清单（4 条，对应 `.tools/photo/` 下项目保留的真实文件）。
 *
 * 哈希与字节数都是**读真实文件算出来的**，不是手抄的估计值；
 * `mobile/tests/screenshotSources.test.mjs` 会拿磁盘上的文件逐条校验。
 */
export const KNOWN_SOURCE_CATALOG: readonly KnownSourceEntry[] = [
  {
    catalogKey: 'retained-original-vertical-week7',
    neutralTitle: '历史截图 1（竖版）',
    archiveRelPath: '.tools/photo/retained-original.png',
    sha256: '84ae2c9add39e39c2792ed6f2f7040180227e138efed5b05c2be9debb70a0056',
    byteLength: 1752730,
    kind: 'vertical-cards',
  },
  {
    catalogKey: 'phone-20261012-122524-horizontal',
    neutralTitle: '历史截图 2（横向）',
    archiveRelPath: '.tools/photo/phone-20261012-122524/input.png',
    sha256: 'dc7fb819931f795ae97766e723196ea21292102d88922fb7f416b1af33c154a6',
    byteLength: 521579,
    kind: 'horizontal-grid',
  },
  {
    catalogKey: 'phone-20261012-202526-horizontal',
    neutralTitle: '历史截图 3（横向，内容与第 2 张相同）',
    archiveRelPath: '.tools/photo/phone-20261012-202526/input.png',
    sha256: 'dc7fb819931f795ae97766e723196ea21292102d88922fb7f416b1af33c154a6',
    byteLength: 521579,
    kind: 'horizontal-grid',
  },
  {
    catalogKey: 'user-20261013-dense-horizontal',
    neutralTitle: '历史截图 4（横向）',
    archiveRelPath: '.tools/photo/user-20261013-dense/input.png',
    sha256: '9d78ab5dbf5c2e20796ab007142a735d001770d4a4e617b5495897e1a954a809',
    byteLength: 201603,
    kind: 'horizontal-grid',
  },
]

export function knownSourceByKey(catalogKey: string): KnownSourceEntry | null {
  return KNOWN_SOURCE_CATALOG.find((entry) => entry.catalogKey === catalogKey) ?? null
}

/**
 * 离线兜底清单 → 仓库 upsert 输入。
 *
 * 描述性字段一律中性 / 留空：真实标题与说明等电脑目录同步回来再补上
 * （`upsertSourceEntry` 只更新文案，不会删除任何历史）。
 */
export function knownSourceToCatalogEntry(entry: KnownSourceEntry): {
  catalogKey: string
  title: string
  description: string | null
  archiveRelPath: string
  sha256: string
  byteLength: number
  width: number | null
  height: number | null
  layout: string | null
  capturedAt: string | null
  provenance: string | null
} {
  return {
    catalogKey: entry.catalogKey,
    title: entry.neutralTitle,
    description: null,
    archiveRelPath: entry.archiveRelPath,
    sha256: entry.sha256,
    byteLength: entry.byteLength,
    width: null,
    height: null,
    layout: entry.kind === 'horizontal-grid' ? 'table-grid' : null,
    capturedAt: null,
    provenance: '电脑上保留的项目自有截图（离线清单只记路径与校验和）',
  }
}

/**
 * 校验一份**已经下载到本机**的归档来源：字节长度与 SHA256 都要与清单一致。
 *
 * 为什么必须校验：伴侣服务只允许读清单里列出的那几份文件，但网络中断 / 磁盘写入
 * 截断都可能让手机拿到半份。校验不通过就**不登记**，让用户重试，而不是把坏文件
 * 当成「已经恢复好的截图」。
 */
export function verifyDownloadedSource(
  entry: Pick<KnownSourceEntry, 'byteLength' | 'sha256'>,
  info: { byteLength: number; sha256: string },
): { ok: true } | { ok: false; message: string } {
  if (info.byteLength !== entry.byteLength) {
    return {
      ok: false,
      message: `取回的字节数不对（期望 ${entry.byteLength}，实际 ${info.byteLength}），可能没传完。请重试。`,
    }
  }
  if (info.sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
    return { ok: false, message: '取回的内容与登记的来源不一致（校验和不同）。已放弃这次恢复，请重试。' }
  }
  return { ok: true }
}
