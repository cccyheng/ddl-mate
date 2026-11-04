/**
 * 合成通知样图生成器（本地 Chrome + Playwright 截图，**不自建字体引擎**）。
 *
 *   node frontend/scripts/make-notice-samples.mjs
 *
 * 输出（全部是虚构的合成内容，不含任何真实聊天记录或用户照片）：
 *   frontend/public/samples/notices/notice-01..08-*.png
 *   frontend/public/samples/notices/expected.json
 *
 * Playwright 与本机 Chrome 用绝对路径（仓库内既有约定）；
 * 两者缺一时**直接报错退出**：绝不伪造图片，也不自造字体引擎。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', 'public', 'samples', 'notices')
const PLAYWRIGHT_ENTRY =
  'C:/Users/33284/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

/** 8 张合成通知的正文；`expect` 是每张图的期望要点，供验收脚本比对。 */
const SAMPLES = [
  {
    file: 'notice-01-homework.png',
    title: '数据结构课程群',
    lines: [
      '2026年10月8日 09:12 张老师',
      '各位同学：',
      '第三次作业请在 2026年10月20日 22:00 前提交到学习通，',
      '提交要求: 实验报告PDF，文件命名 学号-姓名。',
    ],
    note: '合成示例图，不是真实聊天记录',
    expect: { deadline: '2026-10-20T22:00', mustInclude: ['学习通'], note: '完整日期 + 时刻 → 应自动填 DDL' },
  },
  {
    file: 'notice-02-chat-time.png',
    title: '大学物理课程群',
    lines: ['2026年10月8日 08:30 王老师', '请下周一交实验预习报告，纸质稿交到课代表那里。'],
    note: '合成示例图：只有聊天发送时间，不是截止时间',
    expect: { deadline: '', mustNotIncludeDeadline: true, note: '发送时间不能被当成截止时间，应留空提示' },
  },
  {
    file: 'notice-03-two-tasks.png',
    title: '本周作业通知（合成示例）',
    lines: [
      '第 8 周作业清单',
      '1. 数据结构作业三: 2026年10月20日 22:00 前提交到学习通',
      '2. 大学物理第三次作业: 2026年11月3日 14:00 前交纸质稿',
    ],
    note: '合成示例图：两条任务各有自己的时间',
    expect: {
      deadline: '2026-10-20T22:00',
      secondDeadline: '2026-11-03T14:00',
      minTasks: 2,
      note: '编号任务应拆成两条、互不串联',
    },
  },
  {
    file: 'notice-04-email.png',
    title: '软件工程课程群',
    lines: [
      '2026年10月9日 15:40 李老师',
      '课程设计开题报告请于 2026年10月18日 18:00 前发送到',
      'a+b@example.edu.cn，主题写学号。',
    ],
    note: '合成示例图：邮箱地址不能被标点切碎',
    expect: { deadline: '2026-10-18T18:00', mustInclude: ['a+b@example.edu.cn'], note: '邮箱地址必须完整保留' },
  },
  {
    file: 'notice-05-month-day.png',
    title: '班级群通知',
    lines: ['2026年9月28日 20:05 班长', '选课确认表请在 10月15日 交到教务处，过期不补。'],
    note: '合成示例图：只有月日、没有年份',
    expect: { deadline: '', mustNotIncludeDeadline: true, note: '月日无年 → 必须留空提示，不能用系统年份猜' },
  },
  {
    file: 'notice-06-vague.png',
    title: '实验课群',
    lines: ['2026年10月7日 21:10 实验员', '下节课前把预习报告写好带过来，明天下午的实验照常进行。'],
    note: '合成示例图：相对时间不能猜',
    expect: { deadline: '', mustNotIncludeDeadline: true, note: '「下节课前 / 明天下午」→ 必须留空提示' },
  },
  {
    file: 'notice-07-list.png',
    title: '期末任务清单（合成示例）',
    lines: [
      '期末三项任务',
      '1. 高等数学作业册: 2026年12月20日 23:00 前交给学习委员',
      '2. 大学英语作文: 2026年12月25日 17:30 前提交到雨课堂',
      '3. 数据结构课程设计: 2027年1月8日 12:00 前答辩',
    ],
    note: '合成示例图：批量识别 + 勾选',
    expect: {
      deadline: '2026-12-20T23:00',
      thirdDeadline: '2027-01-08T12:00',
      minTasks: 3,
      mustInclude: ['雨课堂'],
      note: '三条任务各有自己的截止时间，末条 2027-01-08T12:00',
    },
  },
  {
    file: 'notice-08-url.png',
    title: '教务通知',
    lines: [
      '2026年10月11日 10:00 教务处',
      '教学评价请在 2026年10月30日 16:00 前完成，',
      '入口见 https://example.edu/eval?term=2026F 。',
    ],
    note: '合成示例图：URL 原样保留',
    expect: {
      deadline: '2026-10-30T16:00',
      mustInclude: ['https://example.edu/eval?term=2026F'],
      note: 'URL 不能被标点切碎',
    },
  },
]

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char],
  )
}

function renderHtml(sample) {
  const body = sample.lines
    .map((line, index) => `<p class="${index === 0 ? 'time' : ''}">${escapeHtml(line)}</p>`)
    .join('\n      ')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 720px; min-height: 420px; background: #ffffff; color: #111111;
    font-family: "Microsoft YaHei", "微软雅黑", SimHei, sans-serif;
    font-size: 26px; line-height: 1.75; padding: 28px 32px;
  }
  h1 { font-size: 20px; font-weight: 600; color: #555555; margin-bottom: 14px; }
  p { margin-bottom: 6px; word-break: break-all; }
  p.time { color: #444444; }
  footer { margin-top: 18px; font-size: 16px; color: #999999; }
</style></head>
<body>
  <h1>${escapeHtml(sample.title)}</h1>
      ${body}
  <footer>（${escapeHtml(sample.note)}）</footer>
</body></html>`
}

async function loadPlaywright() {
  try {
    return await import(pathToFileURL(PLAYWRIGHT_ENTRY).href)
  } catch (error) {
    throw new Error(`无法加载 Playwright（${PLAYWRIGHT_ENTRY}）：${error.message}`)
  }
}

async function launchChrome(chromium) {
  let lastError
  for (const executablePath of CHROME_CANDIDATES) {
    try {
      return await chromium.launch({ executablePath, headless: true })
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`无法启动本机 Chrome：${lastError?.message ?? '未知错误'}`)
}

async function main() {
  const { chromium } = await loadPlaywright()
  const browser = await launchChrome(chromium)
  await mkdir(outDir, { recursive: true })
  const expected = {
    generatedBy: 'frontend/scripts/make-notice-samples.mjs',
    note: '合成示例图，非真实聊天记录',
    samples: {},
  }

  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 460 }, deviceScaleFactor: 2 })
    for (const sample of SAMPLES) {
      await page.setContent(renderHtml(sample), { waitUntil: 'load' })
      await page.screenshot({ path: path.join(outDir, sample.file) })
      expected.samples[sample.file] = sample.expect
      console.log(`已生成 ${sample.file}`)
    }
    await page.close()
  } finally {
    await browser.close()
  }

  await writeFile(path.join(outDir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`, 'utf8')
  console.log(`已生成 ${SAMPLES.length} 张样图与 expected.json → ${outDir}`)
}

main().catch((error) => {
  console.error(`[make-notice-samples] ${error.message}`)
  process.exitCode = 1
})
