/**
 * 通知正文 → 任务候选（**本地保守规则**，不是大模型语义抽取）。
 *
 * 设计边界（与验收要求一一对应）：
 *   1. 只在原文里出现**完整日期 + 完整时刻**时才给出候选截止时间；
 *      只有「月日」没有年份、只有日期没有时刻、或「明天 / 下周五 / 下节课前」这类相对说法，
 *      一律**留空**并保留原话提示核对 —— 绝不拿系统当前年份、当前日期或 23:59 去猜。
 *   2. 通知里的「聊天发送时间」不是截止时间：
 *      `2026年10月8日 08:30 王老师：请下周一交作业` 的第一组日期时间是消息时间，
 *      只有出现在截止/提交语境里的日期时间才会被当成 DDL。
 *   3. 日期时间在提交前由 `toOffsetDateTime` 显式带上 +08:00（业务时区 Asia/Shanghai）。
 *   4. 邮箱、URL、带 `+` 的地址在切分时先做占位保护，不会被标点切碎。
 *   5. 课程只做**与已有课程名/代码完全一致**的匹配，不做模糊归并。
 *
 * 所有返回值都只是「候选」，最终写库必须由用户勾选并确认。
 */

/** 需要用户核对/补全的提示（保持原话，不改成猜测值）。 */
export const NOTICE_HINTS = {
  deadlineMissing: '原文里没有完整的「日期 + 时刻」，暂未填写截止时间：请选日期后再选时间，缺一项就不要填。',
  deadlineNoYear: '原文只有「月日」没有年份，无法确定是哪一年：请按通知年份补全后再填。',
  deadlineNoTime: '原文只有日期没有具体时刻：请确认具体几点截止（不要默认 23:59）。',
  deadlineRelative: '原文是「明天 / 下周 / 下节课前」这类相对说法，需要先知道通知是哪一天才能算：请手工确认日期。',
  deadlineInvalid: '原文里的日期或时刻不存在（例如 2 月 30 日 / 25:00），已忽略，请核对后手工填写。',
  deadlineAmbiguous: '原文里有多组日期时间，无法确定哪个是截止时间：请对照原文选择正确的截止时间。',
  deadlineNotClearlyDeadline:
    '原文里有完整的日期时间，但看不出它是截止时间（例如是活动开始时间）：请确认后手动填写。',
  deadlineChatTime: '第一组日期时间是聊天发送时间，不是截止时间，已忽略。',
  courseUnmatched: '没有在已有课程里找到完全一致的课程名，暂未关联课程，可手工选择。',
};

export const WEEKDAY_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

const ORDINAL = '一二三四五六七八九十';

const DATE_PATTERNS = [
  { name: 'cn', re: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g },
  { name: 'iso', re: /(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/g },
  { name: 'md-cn', re: /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g },
  { name: 'd-cn', re: /(\d{1,2})\s*[日号](?=\s*[，,。;；!！:：]?\s*(?:前|之前|以前|截止|提交|交|完成|晚|早)?)/g },
];

/**
 * 时间：`22:00`、`22：00`、`22点`、`22点30`、`晚上8点`、`下午3点前`。
 * 前缀（凌晨/早上/上午/中午/下午/傍晚/晚上）一起吃掉，避免日期与时间之间多出一段前缀导致无法合并。
 */
const TIME_RE = /(凌晨|早上|上午|中午|下午|傍晚|晚上|今晚|明晚)?\s*(\d{1,2})\s*(?::|：|点|时)\s*(?:(\d{1,2})\s*分?)?/g;

const RELATIVE_DEADLINE_RE =
  /(今天|今晚|明天|明晚|后天|大后天|本周[一二三四五六日天]|这周[一二三四五六日天]|下周[一二三四五六日天]|下个?月|下节课|下次课|下次实验课|上课前|课前|放学前|放假前|开学前|期末前|月底|月初)/;

/**
 * 截止/提交语境。**必须带 g**（nearestDistance 用 exec 逐个推进）。
 * 注意：
 *   - `交作业|交实验` 这类词太泛，靠 cued 的距离阈值兜底；
 *   - `前` 单字放最后，但 **不能少**：真实 OCR 文本
 *     `2026年10月20日 22:00 前提交到学习通`、`2027年1月8日 12:00 前答辩`、
 *     `2026年12月20日 23:00 前交给学习委员` 都靠它才算截止语境，
 *     少了它第三条候选的 DDL 会整条丢失（见 notice-07 回归测试）。
 */
const DEADLINE_CUE_RE =
  /(截止|deadline|ddl|前提交|提交截止|之前提交|前交|之前交|以前交|前完成|之前完成|完成时间|提交时间|提交到|上传到|交作业|交实验|交报告|最晚|due|前)/gi;

/**
 * 动作词：只用于「这一行值不值得当标题」，不参与截止时间判断
 * （「参加 / 考试 / 讲座」等普通动作不能证明某个时间是 DDL）。
 */
const ACTION_RE =
  /(提交|上交|交|完成|撰写|写|做|复习|预习|阅读|准备|参加|报名|打印|背诵|整理|上传|填|填写|组队|答辩|汇报|展示|考试|测验|投稿|问卷|确认|领取)/;

const SUBMIT_METHOD_RE =
  /(学习通|雨课堂|超星|钉钉|微信|QQ|邮箱|邮件|email|e-mail|教务系统|课程网站|在线平台|腾讯会议|百度网盘|小程序|问卷星|纸质|打印稿|手写|线下|当面|教务处|学习委员|班长|课代表|平台|系统|网站|链接)/i;

const SUBMIT_REQUIREMENT_RE = /(提交要求|要求)[：:]\s*([^\n。;；]{2,120})/;

/** 顺序即优先级：更具体的「课程设计」不能被泛化的「报告」抢走。 */
const TYPE_RULES = [
  { type: 'PROJECT', re: /(课程设计|大作业|项目|课设|作品)/ },
  { type: 'LAB', re: /(实验|lab)/i },
  { type: 'REPORT', re: /(报告|论文|文献综述|综述)/ },
  { type: 'EXAM', re: /(考试|测验|机考|笔试|口试|补考|随堂测)/ },
  { type: 'PRESENTATION', re: /(答辩|汇报|展示|演讲|presentation|路演)/i },
  { type: 'READING', re: /(阅读|读书|看论文|读论文|预习|复习|背诵|听力|网课)/ },
  { type: 'HOMEWORK', re: /(作业|习题|练习|homework)/i },
];

/** 序号行：`1.` `1、` `（2）` `①` `作业二：` `任务 3 -`。
 *  注意「第 8 周作业清单」这类**周次/章节标题不是序号条目**：
 *  「第 + 数字」后面必须跟量词（题/条/项/个）或分隔符，不能是「周/月/章/节」。 */
const SEGMENT_START_PATTERNS = [
  /^\s*(?:\(|（)?\d{1,2}(?:\)|）)?\s*[.、,，)）:：\-]\s*\S/,
  /^\s*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]\s*\S/,
  new RegExp(
    `^\\s*(?:(?:作业|任务)\\s*[0-9${ORDINAL}]{1,3}|第\\s*[0-9${ORDINAL}]{1,3}\\s*(?:题|条|项|个))\\s*[.、,，:：\\-)]?\\s*\\S`,
  ),
];

function collect(re, text, build) {
  const found = [];
  re.lastIndex = 0;
  let match = re.exec(text);
  while (match) {
    found.push(build(match));
    if (match.index === re.lastIndex) re.lastIndex += 1;
    match = re.exec(text);
  }
  return found;
}

export function validYmd(year, month, day) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 时辰前缀 → 24 小时制；前缀缺失或越界时返回 null，交给 valid 标记。 */
export function applyMeridiem(prefix, hour) {
  if (!Number.isInteger(hour)) return null;
  if (prefix === '下午' || prefix === '傍晚' || prefix === '晚上' || prefix === '今晚' || prefix === '明晚') {
    return hour < 12 ? hour + 12 : hour;
  }
  // 中文口语的「中午 1 点」是 13:00（午时约 11:00–13:00），不能当成 01:00
  if (prefix === '中午') return hour >= 1 && hour <= 5 ? hour + 12 : hour;
  if ((prefix === '凌晨' || prefix === '早上' || prefix === '上午') && hour === 12) return 0;
  return hour;
}

/**
 * 找出文本里所有日期、日期时间、时间片段（含不完整的）。
 * 每项：{ kind, index, length, raw, year, month, day, hour, minute, valid, hasYear, hasExplicitTime }
 */
export function findDateTimes(text) {
  const source = typeof text === 'string' ? text : '';
  const dates = [];
  for (const { name, re } of DATE_PATTERNS) {
    for (const { m } of collect(re, source, (match) => ({ m: match }))) {
      const raw = m[0];
      if (name === 'cn' || name === 'iso') {
        const year = Number(m[1]);
        const month = Number(m[2]);
        const day = Number(m[3]);
        dates.push({
          kind: 'date',
          pattern: name,
          index: m.index,
          length: raw.length,
          raw,
          year,
          month,
          day,
          hasYear: true,
          valid: validYmd(year, month, day),
        });
      } else if (name === 'md-cn') {
        const month = Number(m[1]);
        const day = Number(m[2]);
        dates.push({
          kind: 'date',
          pattern: name,
          index: m.index,
          length: raw.length,
          raw,
          year: null,
          month,
          day,
          hasYear: false,
          valid: validYmd(2000, month, day),
        });
      } else {
        const day = Number(m[1]);
        dates.push({
          kind: 'date',
          pattern: name,
          index: m.index,
          length: raw.length,
          raw,
          year: null,
          month: null,
          day,
          hasYear: false,
          valid: day >= 1 && day <= 31,
        });
      }
    }
  }

  const times = collect(TIME_RE, source, (m) => {
    const prefix = m[1] || '';
    const hour = applyMeridiem(prefix === '今晚' || prefix === '明晚' ? '晚上' : prefix, Number(m[2]));
    const minute = m[3] === undefined ? 0 : Number(m[3]);
    const valid = hour !== null && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
    return {
      kind: 'time',
      index: m.index,
      length: m[0].length,
      raw: m[0],
      prefix,
      hour: valid ? hour : null,
      minute: valid ? minute : null,
      valid,
    };
  });

  // 去掉被更长的日期片段完全包住的短匹配（`2026年10月8日` 里不能再出现一次 `10月8日`）
  const kept = [];
  for (const item of [...dates, ...times].sort((a, b) => a.index - b.index || b.length - a.length)) {
    const covered = kept.some(
      (other) => item.index >= other.index && item.index + item.length <= other.index + other.length,
    );
    if (!covered) kept.push(item);
  }
  return kept.sort((a, b) => a.index - b.index);
}

/**
 * 日期与时间之间允许出现的连接词。
 * **只允许空白、标点和少数虚词**（至/到/和/及/与），不能写成宽泛的 `\s` 或 CJK 范围，
 * 否则 `2026年10月20日 22:00 前提交到学习通` 里「前提交到学习通」会被当成连接词，
 * 让 DDL 的 raw/显示带上整句正文。
 */
const DATE_TIME_CONNECTOR_RE = /^[\s，,。;；、~～至到和及与\-—的]{0,8}$/;

/**
 * 把日期片段与紧随其后的时间片段合成候选截止时间。
 * 只合成「完整日期 + 完整时刻」，其余进 incomplete（保留原话由界面提示）。
 */
export function combineDateTimes(items, text = '') {
  const source = typeof text === 'string' ? text : '';
  const complete = [];
  const incomplete = [];
  const invalid = [];
  const consumed = new Set();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind !== 'date') continue;
    if (!item.valid) {
      invalid.push({ ...item, reason: 'invalid-date' });
      consumed.add(item);
      continue;
    }
    if (!item.hasYear) {
      incomplete.push({
        kind: item.month === null ? 'day' : 'monthDay',
        raw: item.raw,
        index: item.index,
        reason: 'no-year',
      });
      consumed.add(item);
      continue;
    }
    const next = items[i + 1];
    const between = next && next.kind === 'time' ? source.slice(item.index + item.length, next.index) : '';
    if (next && next.kind === 'time' && DATE_TIME_CONNECTOR_RE.test(between)) {
      consumed.add(item);
      consumed.add(next);
      if (next.valid) {
        complete.push({
          year: item.year,
          month: item.month,
          day: item.day,
          hour: next.hour,
          minute: next.minute,
          raw: `${item.raw}${between}${next.raw}`.trim(),
          index: item.index,
          end: next.index + next.length,
        });
      } else {
        invalid.push({ ...next, reason: 'invalid-time' });
        incomplete.push({ kind: 'date', raw: item.raw, index: item.index, reason: 'invalid-time' });
      }
      i += 1;
      continue;
    }
    consumed.add(item);
    incomplete.push({ kind: 'date', raw: item.raw, index: item.index, reason: 'no-time' });
  }

  for (const item of items) {
    if (item.kind !== 'time' || consumed.has(item)) continue;
    if (!item.valid) invalid.push({ ...item, reason: 'invalid-time' });
    else incomplete.push({ kind: 'time', raw: item.raw, index: item.index, reason: 'no-date' });
  }
  return { complete, incomplete, invalid };
}

/** 消息头（聊天发送时间）：`2026年10月8日 08:30 王老师：`、`2026-10-08 20:15 李老师：`、`通知时间：2026-10-08 08:30`。 */
export function isChatTimestamp(text, item) {
  const source = String(text);
  const before = source.slice(Math.max(0, item.index - 14), item.index);
  if (/(发送时间|消息时间|通知时间|发布时间|群公告|聊天记录)[：:]?\s*$/.test(before)) return true;
  // `end` 是「日期 + 时间」整段的结束位置；只有日期片段时退回 index + length
  const span = Number.isInteger(item.end) ? item.end : item.index + (item.length || 0);
  let after = source.slice(span, span + 26);
  // 同一组消息头里日期在时间前面：`2026年10月8日 08:30 王老师：` → 先吃掉紧跟的时间片段
  after = after.replace(
    /^\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*(?::|：|点|时)\s*(?:\d{1,2}\s*分?)?/,
    '',
  );
  // 后面直接跟「说话人：」→ 这组日期时间是消息头的发送时间，不是截止时间。
  // 注意用 `[^\S\n]`（空白但**不含换行**）：如果允许跨行，`… 08:30 王老师\n请下周一交作业`
  // 会把下一行开头的两个字加上冒号误当说话人，也可能反向漏判。
  return /^[^\S\n]*(?:周[一二三四五六日天][^\S\n]*)?[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_\-（）()·]{0,11}[^\S\n]*[：:]/.test(
    after,
  );
}

/**
 * 关键词离目标位置最近有多远。
 * 注意：
 *   - 正则必须带 g；零宽/短匹配必须手动推进 lastIndex，否则 exec 会在同一位置无限返回；
 *   - `前` 这种**边界词**必须算「零距离」：`22:00 前提交` 里 `前` 紧跟在时刻后面，
 *     如果按「匹配结束位置」算距离会白跑一段，把本该 cued 的截止时间漏掉。
 */
function nearestDistance(text, index, re) {
  re.lastIndex = 0;
  let best = Infinity;
  let match = re.exec(text);
  while (match) {
    const start = match.index;
    const end = match.index + match[0].length;
    const distance = index >= end ? index - end : Math.max(0, start - index);
    if (distance < best) best = distance;
    re.lastIndex = match[0].length === 0 ? match.index + 1 : end;
    if (re.lastIndex > text.length) break;
    match = re.exec(text);
  }
  re.lastIndex = 0;
  return best;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

/** 候选截止时间的统一格式：`YYYY-MM-DDTHH:mm`（业务时区墙上时间，不含偏移）。 */
export function formatWallClock({ year, month, day, hour, minute }) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/**
 * 从一段原文里挑出截止时间候选（**只有明确截止/提交语境才自动填入**）。
 *
 * 返回 { deadline, display, hints, options, chatTimesIgnored, incomplete, invalid }
 *   - deadline：`YYYY-MM-DDTHH:mm`（不含时区，保存时补 +08:00）或 ''
 *   - options：所有完整的「日期 + 时刻」，带 `cued`（是否临近截止/提交措辞）与 `display`；
 *     多组都带截止语境时交给用户选，不静默取一个。
 *   - 只要有一丝不确定就返回空串并给出 hints，绝不猜测。
 */
export function extractDeadline(rawText) {
  const text = typeof rawText === 'string' ? rawText : '';
  const items = findDateTimes(text);
  const { complete, incomplete, invalid } = combineDateTimes(items, text);
  const hints = [];

  const chatDates = items.filter((item) => item.kind === 'date' && isChatTimestamp(text, item)).length;
  const senderHeaderFlags = senderHeaderDateTimes(text);
  const chatTimesIgnored = chatDates > 0 || senderHeaderFlags.size > 0;
  if (invalid.length) hints.push(NOTICE_HINTS.deadlineInvalid);
  if (chatTimesIgnored) hints.push(NOTICE_HINTS.deadlineChatTime);

  // 说话人抬头里的日期时间（`2026年10月7日 21:10 实验员`）是发送时间，不是截止时间。
  // 用「起始位置:跨度」对比：跨度= 日期 + 紧跟的时刻（与 senderHeaderDateTimes 的算法一致）。
  const spanOf = (candidate) =>
    (candidate.end ?? candidate.index + String(candidate.raw).length) - candidate.index;
  const isSenderTime = (candidate) =>
    isChatTimestamp(text, candidate) || senderHeaderFlags.has(`${candidate.index}:${spanOf(candidate)}`);
  const scored = complete
    .map((candidate) => ({
      value: formatWallClock(candidate),
      display: candidate.raw,
      index: candidate.index,
      length: spanOf(candidate),
      chat: isSenderTime(candidate),
      distance: nearestDistance(text, candidate.index, DEADLINE_CUE_RE),
    }))
    .sort((a, b) => a.index - b.index)
    .map((candidate) => ({ ...candidate, cued: candidate.distance < 24 }));

  const options = scored.map(({ value, display, index, cued }) => ({ value, display, index, cued }));
  const usable = scored.filter((candidate) => !candidate.chat);
  const empty = (extra = []) => ({
    deadline: '',
    display: '',
    hints: unique([...hints, ...extra]),
    options,
    chatTimesIgnored,
    incomplete,
    invalid,
  });

  if (!usable.length) {
    if (incomplete.some((item) => item.reason === 'no-year')) hints.push(NOTICE_HINTS.deadlineNoYear);
    else if (incomplete.some((item) => item.reason === 'no-time')) hints.push(NOTICE_HINTS.deadlineNoTime);
    if (RELATIVE_DEADLINE_RE.test(text)) hints.push(NOTICE_HINTS.deadlineRelative);
    if (!hints.length) hints.push(NOTICE_HINTS.deadlineMissing);
    return empty();
  }

  // 只有明确带**截止/提交语境**的才自动填入。
  // 普通动作词（参加 / 考试 / 开始 / 讲座…）不能证明这是截止时间，所以不作依据；
  // 多组都带截止语境时留空让用户选，不静默挑一个。
  const cued = usable.filter((candidate) => candidate.cued);
  let picked = null;
  if (cued.length === 1) picked = cued[0];
  else if (cued.length > 1) hints.push(NOTICE_HINTS.deadlineAmbiguous);
  else if (usable.length === 1) hints.push(NOTICE_HINTS.deadlineNotClearlyDeadline);
  else hints.push(NOTICE_HINTS.deadlineAmbiguous);
  if (!picked && RELATIVE_DEADLINE_RE.test(text)) hints.push(NOTICE_HINTS.deadlineRelative);

  if (incomplete.some((item) => item.reason === 'no-time')) hints.push(NOTICE_HINTS.deadlineNoTime);
  if (!picked) return empty();
  return {
    deadline: picked.value,
    display: picked.display,
    hints: unique(hints),
    options,
    chatTimesIgnored,
    incomplete,
    invalid,
  };
}

/** `2026-10-15T22:00` → `2026-10-15T22:00:00+08:00`（业务时区固定 +08:00）。 */
export function toOffsetDateTime(localValue) {
  if (!localValue) return null;
  const value = String(localValue).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second = '00'] = timePart.split(':');
  if (!validYmd(year, month, day)) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return `${datePart}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(
    second,
  ).padStart(2, '0')}+08:00`;
}

/**
 * 明显没写完的结尾（折行信号）：介词/方位词，或「发送到 / 请在 / 交给」这类动补。
 * 只有命中这里的结尾才允许合并下一行 —— 宁可少合并，也不能把两条任务粘成一条。
 */
const CONTINUE_TAIL_RE =
  /(?:发送到|发送至|发到|提交到|上交到|交到|上传到|写到|发送|提交|上交|上传|截止|截至|请在|请于|请到|交给|学习|课|写着|见|联系|咨询|在|于|给|到|和|与|及|的|把|将|请|要|需|需要|按照|根据)\s*$/;
/** OCR 常见尾部噪声：群名后面多出来的单字（`教务通知让`、`班级群通知部`）或 1–3 个字母（`实验课群 wm`）。 */
const TRAILING_NOISE_RE = /[\s]*(?:[A-Za-z]{1,3}|[让部比][\s]*)$/;

/** 说话人身份后缀（群聊抬头里的「张老师 / 王班长 / 实验员」）。 */
const SPEAKER_ROLE = '老师|教授|讲师|助教|辅导员|班长|学委|课代表|实验员';

/** 抬头行里「时间后面紧跟说话人」的正则。
 *  写法要点：
 *   - 身份词可以**裸出现**（`实验员` / `班长`），也可以是「姓 + 身份」（`王老师`），
 *     姓名前缀 0–8 个汉字都必须允许（`王老师` 的「王」、`实验员` 的零前缀）；
 *   - 说话人后面**允许接正文**（`… 21:10 实验员下节课前…`）或行尾/换行；
 *   - 只认人头衔（老师/班长/实验员…），**不认机构**（教务处/学院），
 *     否则 `… 教务处教学评价请在…` 这种正文会被误判成抬头。 */
const SPEAKER_HEADER_RE = new RegExp(
  `^[^\\S\\n]*[\\u4e00-\\u9fa5A-Za-z]{0,8}(?:${SPEAKER_ROLE})[^\\S\\n]*(?=[：:]|[\\u4e00-\\u9fa5A-Za-z]|\\n|$)`,
);

/** 某个日期时间片段之后是不是说话人署名（群聊抬头）。 */
function isFollowedBySpeaker(source, item) {
  const after = source.slice(item.end ?? item.index + item.length);
  return SPEAKER_HEADER_RE.test(after);
}

/** 这一行是不是「日期时间 + 说话人」（以后面没有正文的抬头行结束）。 */
function endsWithSpeakerSignature(line) {
  const text = String(line ?? '').trim();
  const items = findDateTimes(text);
  if (!items.length) return false;
  const { complete } = combineDateTimes(items, text);
  if (!complete.length) return false;
  return isFollowedBySpeaker(text, complete[0]);
}

/**
 * 一段文字里，哪些「日期 + 时刻」属于**说话人抬头**（群头发送时间）。
 *
 * 真实 OCR 常把一条消息拆成「日期时间 + 实验员」一行、正文另起一行；
 * 也常见抬头与正文粘成一行（`2026年10月7日 21:10 实验员下节课前…`）。
 * 命中就说明这组日期时间是发送时间，不是截止时间（notice-02 / notice-06 的验收要求）。
 *
 * 键必须与 `extractDeadline` 中候选的 `index:length`（length = end - index）**完全同口径**，
 * 否则 Set 永远命中不了。
 */
function senderHeaderDateTimes(text) {
  const source = String(text ?? '');
  const flags = new Set();
  let offset = 0;
  for (const line of source.split('\n')) {
    const items = findDateTimes(line);
    const { complete } = combineDateTimes(items, line);
    for (const candidate of complete) {
      if (isFollowedBySpeaker(line, candidate)) {
        flags.add(`${offset + candidate.index}:${candidate.end - candidate.index}`);
      }
    }
    offset += line.length + 1;
  }
  return flags;
}

/**
 * 规范化 OCR 文本（只处理空格与换行，不改字、不删内容）：
 *   1. 去掉 Tesseract 在汉字/中文标点之间插的空格（`第 三 次 作业` → `第三次作业`）；
 *      邮箱与 URL 先遮罩，内部空格不会被误删。
 *   2. 折行合并**从严**：只有「上一行以介词/动补结尾（`…提交到学习`）」这种明显折断才合并；
 *      以 `。！？` 结尾、或下一行是序号条目（`1.` `2、`）时一律保留换行，
 *      绝不把两条任务粘成一条。
 *   3. 把聊天抬头（`2026年10月8日 08:30 张老师`）与紧跟的正文拆成两行。
 *   4. 同一行里出现「`。` + 序号」时补一个换行。
 */
export function normalizeOcrText(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const { masked, restore } = maskSensitive(source);
  const CJK = '\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
  const CJK_START_RE = new RegExp(`^[${CJK}]`);
  const cleaned = masked
    // 只在同一行内消除汉字之间的**空格/制表符**，绝不能用 `\s+`（那会把 OCR 换行也吃掉）。
    // `([CJK])[ \t]+(?=[CJK])` 不会碰「第 8 周」这种汉字—数字之间的空格，
    // 序号行的正则因此仍能识别「第 8 周」是标题行，而不是被并进任务段。
    .replace(new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '$1')
    .replace(new RegExp(`([${CJK}])[ \\t]+([，。、；：！？）】》”’])`, 'g'), '$1$2')
    .replace(new RegExp(`([（【《“‘])[ \\t]+([${CJK}])`, 'g'), '$1$2');

  const rawLines = restore(cleaned)
    .split('\n')
    .map((line) => line.trim())
    // 抬头与正文粘连时先拆行（如 `… 09:12 张老师各位同学：`）
    .flatMap((line) => splitChatHeaderLine(line).split('\n'))
    .map((line) => line.trim());

  const merged = [];
  for (const line of rawLines) {
    if (line === '') {
      if (merged.length && merged[merged.length - 1] !== '') merged.push('');
      continue;
    }
    // 只有抬头没有正文的行（`2026年10月7日 21:10 实验员`）直接丢掉：
    // 它带着群头发送时间，留在文本里会被当成截止时间。
    if (endsWithSpeakerSignature(line)) {
      if (merged.length && merged[merged.length - 1] !== '') merged.push('');
      continue;
    }
    // 找到上一条非空文本（中间可能有 OCR 误插的空行）
    let previousIndex = merged.length - 1;
    while (previousIndex >= 0 && merged[previousIndex] === '') previousIndex -= 1;
    const previous = previousIndex >= 0 ? merged[previousIndex] : undefined;
    if (
      previous !== undefined &&
      isSegmentStartLine(line) === false &&
      CJK_START_RE.test(line) &&
      // **只**在上一行明显没写完（`…提交到学习`）时合并。
      // 不能因为「上一行像抬头」就合并：那会把「2026年10月7日 21:10 实验员」和
      // 下一行正文粘成一行，群头时间就会跟着正文一起被当成截止时间。
      CONTINUE_TAIL_RE.test(previous)
    ) {
      merged[previousIndex] = `${previous}${line}`;
      merged.length = previousIndex + 1;
      continue;
    }
    merged.push(line);
  }

  return merged
    .join('\n')
    .replace(
      /([。；!！?？])\s*(?=(?:\d{1,2}[.、,，)）:：]|[(（]\d{1,2}[)）]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫])\s*\S)/g,
      '$1\n',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 抬头行：`2026年10月8日 08:30 张老师`、`2026-10-08 20:15 李老师：`。 */
export function looksLikeChatHeaderLine(line) {
  const text = String(line ?? '');
  const items = findDateTimes(text);
  if (!items.length) return false;
  const { complete } = combineDateTimes(items, text);
  if (!complete.length) return false;
  return isFollowedBySpeaker(text, complete[0]);
}

/**
 * 「这一行本身只是个抬头」：日期时间 + 姓名（没带正文）、短群名、或纯署名行。
 * 这类行必须与紧跟的正文并成一段，否则会变成没有任务信息的空候选。
 *
 * 注意：只有**明显是标题/抬头**的短行才算（`群聊`、`期末三项任务`、`XXX：`）。
 * `课程通知：…报告下周交` 这种带任务的句子不能被当成抬头丢掉。
 */
function isHeaderLikeLine(line) {
  const text = String(line ?? '').trim();
  if (!text || text.length > 24) return false;
  if (looksLikeChatHeaderLine(text)) return true;
  if (isSegmentStartLine(text)) return false;
  // 纯署名/群名行：没有任务名词、没有日期时间、也没有动作
  if (findDateTimes(text).length) return false;
  if (hasWorkNoun(text) || ACTION_RE.test(text)) return false;
  return /^[\u4e00-\u9fa5A-Za-z0-9\s（）()·]+[：:]?$/.test(text);
}

/**
 * 抬头行里「日期时间 + 姓名」的结束位置（没有抬头时返回 -1）。
 *
 * 姓名识别优先用常见身份后缀（老师 / 班长 / 教务处 / 辅导员…），其次是 2–4 个汉字，
 * 且姓名后面必须真的还有内容 —— 否则可能把正文当成名字切掉。
 */
export function chatHeaderEnd(text) {
  const source = String(text ?? '');
  const items = findDateTimes(source);
  if (!items.length) return -1;
  const first = items[0];
  const end = Number.isInteger(first.end) ? first.end : first.index + first.length;
  const after = source.slice(end);
  const timeMatch = /^\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*(?::|：|点|时)\s*(?:\d{1,2}\s*分?)?/.exec(after);
  const from = end + (timeMatch ? timeMatch[0].length : 0);
  const rest = source.slice(from);
  // 身份词可以单独出现（`实验员` / `班长`），也可以是「姓 + 身份」（`李老师`）。
  // 不能再用惰性 `{1,8}?`：那会贪掉「实验员」的「实验」，让没有姓的身份词匹配不上。
  const named =
    new RegExp(`^\\s*((?:${SPEAKER_ROLE})|[\\u4e00-\\u9fa5A-Za-z][\\u4e00-\\u9fa5A-Za-z]{0,7}(?:${SPEAKER_ROLE}))\\s*[：:]?`).exec(
      rest,
    ) ?? /^\s*([\u4e00-\u9fa5A-Za-z]{2,4})\s*[：:]/.exec(rest);
  if (!named) return -1;
  const nameEnd = from + named[0].length;
  const remainder = source.slice(nameEnd).replace(TRAILING_NOISE_RE, '');
  if (!remainder.trim()) return -1;
  return nameEnd;
}

/**
 * 把「聊天抬头 + 紧跟的正文」拆成两行（`2026年10月8日 09:12 张老师各位同学：`）。
 * 截图里抬头与正文常常被 OCR 连在一起，粘着会把抬头当成正文的一部分。
 */
function splitChatHeaderLine(line) {
  const end = chatHeaderEnd(line);
  if (end < 0) return line;
  const head = line.slice(0, end).trim();
  const rest = line.slice(end).trim();
  return rest ? `${head}\n${rest}` : head;
}

/**
 * 折行片段（`通，`、`质稿`）只有在**上一行没写完**时才接回上一行。
 * 上一行以句末标点收尾（`…提交到学习通，` 的下一段 `提交要求: …`）就是新的一段，不接。
 */
function shouldJoinWrapped(current, line) {
  if (!current || isSegmentStartLine(line)) return false;
  const continues = CONTINUE_TAIL_RE.test(current) || isLabelOnlyLine(current);
  if (!continues) return false;
  return (String(line).length <= 20 && !/[。！？!?]\s*$/.test(line)) || isLabelOnlyLine(current);
}

/**
 * 「附加信息」标签开头：`提交要求: …`、`要求：…`、`提交方式：…`、`附件：…`、`备注：…`、
 * `链接：…`、`邮箱：…`。这类段是对**上一条任务**的补充说明，本身不是新任务。
 *
 * 真实浏览器 OCR（`.supervision/notice-browser-ocr-raw.json` 的 notice-01-homework）里
 * `提交要求: 实验报告PDF，文件命名学号-姓名。` 被前面的空行切成独立块，
 * 曾因此多出一个没有截止时间的空候选；命中本标签的段要并回上一条任务。
 */
const AUXILIARY_LABEL_RE =
  /^(?:提交要求|提交方式|提交时间|提交说明|截止时间|截止|要求|说明|备注|附件|链接|网址|邮箱|邮件|命名|文件命名|主题|格式)[：:]/;

/** `提交要求: 实验报告PDF` / `截止时间：…`：标签开头，后面是折行正文而不是新条目。 */
function isLabelOnlyLine(line) {
  return AUXILIARY_LABEL_RE.test(String(line ?? '').trim());
}

/** 这一段是不是「附加信息」段：首行以附加信息标签开头（附件/备注/链接/邮箱…）。 */
function isAuxiliaryInfoSegment(text) {
  const first = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return first ? AUXILIARY_LABEL_RE.test(first) : false;
}

/** 这一行看起来是新的条目（序号行），折行合并时要保留换行。 */
function isSegmentStartLine(line) {
  return SEGMENT_START_PATTERNS.some((re) => re.test(line));
}

/** 邮箱 / URL / 带 `+` 的地址先替换成占位符，切分标点时不破坏它们。 */
export function maskSensitive(text) {
  const store = [];
  const masked = String(text ?? '')
    // URL 也兼容 OCR 把 `//` 识别成其他字符的情况（`https:WVexample.edu/eval?term=2026F`）
    .replace(/\bhttps?:[^\s，,。;；"'）)]*[A-Za-z0-9/][^\s，,。;；"'）)]*/gi, (value) => stash(value))
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (value) => stash(value));
  return { masked, restore: (value) => restoreAll(value) };

  function stash(value) {
    const token = `\u0000M${store.length}\u0000`;
    store.push(value);
    return token;
  }

  function restoreAll(value) {
    return String(value).replace(/\u0000M(\d+)\u0000/g, (_, index) => store[Number(index)] ?? '');
  }
}

/** 按行、按序号切分为「一条任务」，保留原始文本（去掉换行统一）。 */
export function splitSegments(rawText) {
  const text = String(rawText ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!text) return [];
  const { masked, restore } = maskSensitive(text);
  const lines = masked.split('\n');
  const groups = [];
  let current = null;
  for (const line of lines) {
    for (const piece of expandInline(line)) {
      if (current && piece.isStart) groups.push(current);
      if (piece.isStart) current = [piece.text];
      else if (current) current.push(piece.text);
      // 第一个序号行之前的说明（如「下面两件事都要做」）不另立候选
    }
  }
  if (current) groups.push(current);
  // 没有序号条目：按空行分段；没有空行时**只保留「抬头 + 正文」这一段**，
  // 群名/日期抬头/页脚不会各自变成空候选。
  if (!groups.length) return fallbackSegments(restore(text));
  // 第一个序号条目之前的**纯标题行**（`第 8 周作业清单`、`期末三项任务`）不是任务，
  // 并进第一条：既不必单独成为一个候选，也不会丢掉「本周/本期」的上下文。
  if (groups.length) {
    const heading = groups[0]
      .join('\n')
      .split('\n')
      .filter((line) => isShortHeadingLine(line));
    if (heading.length && !groups[0].some((line) => !isShortHeadingLine(line))) {
      const rest = groups.slice(1);
      if (rest.length) rest[0] = [...groups[0], ...rest[0]];
      groups.splice(0, groups.length, ...(rest.length ? rest : [groups[0]]));
    }
  }
  return groups.map((group, index) => ({
    id: `segment-${index + 1}`,
    index: index + 1,
    text: restore(group.join('\n').trim()),
  }));
}

/** 没有序号条目时的兜底分段：按空行分块，块内保留换行（抬头与正文在同一块里）。 */
function fallbackSegments(text) {
  const blocks = String(text ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const segments = [];
  blocks.forEach((block) => {
    // OCR 抬头（日期时间 + 说话人）常常和正文粘在一行（`… 15:40 李老师课程设计开题报告…`）：
    // 先在抬头结束处补一个换行，下面才能把它当抬头行处理，而不是把整行当正文。
    const lines = splitDateHeaderLine(block)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    // 抬头行（群名 / 日期 + 说话人署名）直接丢弃：它们没有任务信息，
    // 保留下来只会各自变成一个空候选（`实验课群 wm`、`2026年10月7日 21:10 实验员`）。
    const merged = [];
    for (const line of lines) {
      if (isFootnoteLine(line)) continue;
      if (isHeaderOnlyLine(line) || endsWithSpeakerSignature(line)) continue;
      // 块内折行：只在上一行明显没写完（`…提交到学习`+`通，`）时接上，绝不把两段并成一段。
      if (merged.length && CONTINUE_TAIL_RE.test(merged[merged.length - 1]) && !isSegmentStartLine(line)) {
        merged[merged.length - 1] = `${merged[merged.length - 1]}${line}`;
      } else {
        merged.push(line);
      }
    }
    if (merged.length) {
      const text = merged.join('\n');
      // OCR 空行把**同一个字段**断开时（`…前发送到` ／ 空行 ／ `a+b@example.edu.cn，主题写学号。`）
      // 再接回去；判定只看上一段的**最后一行**（`…提交到学习通，` 收尾就不并）。
      const previous = segments[segments.length - 1];
      const previousTail = previous ? previous.text.split('\n').pop() : '';
      // 「提交要求 / 附件 / 备注 / 链接 / 邮箱」这类附加信息段（真实浏览器 OCR notice-01）是对
      // **上一条任务**的补充说明，必须并回上一条，否则会被空行切成第二个没有截止时间的空候选；
      // 带明确序号（`1.` `2、`）的真实独立任务走上面的序号分支，不经过这里，不会被误并。
      if (previous && isAuxiliaryInfoSegment(text)) {
        previous.text = `${previous.text}\n${text}`;
      } else if (previous && CONTINUE_TAIL_RE.test(previousTail) && !isLabelOnlyLine(text)) {
        previous.text = `${previous.text}${text}`;
      } else {
        segments.push({ id: `segment-${segments.length + 1}`, index: segments.length + 1, text });
      }
    }
  });
  if (segments.length) return segments;
  return [{ id: 'segment-1', index: 1, text: String(text ?? '').trim() }];
}

/** 这一行是不是短标题行（`第 8 周作业清单`、`期末三项任务`）：块内合并时保持独立。 */
function isShortHeadingLine(line) {
  const text = String(line ?? '').trim();
  if (!text || text.length > 20) return false;
  if (findDateTimes(text).length) return false;
  if (ACTION_RE.test(text)) return false;
  return /^[\u4e00-\u9fa5A-Za-z0-9\s（）()·:：、.．第周年月日项个条]+$/.test(text);
}

/**
 * 以日期时间 + 说话人开头的行：在抬头结束后补一个换行。
 * `2026年10月9日 15:40 李老师课程设计开题报告…` → `…李老师\n课程设计开题报告…`。
 * 识别不出说话人时原样返回，绝不丢字。
 */
function splitDateHeaderLine(block) {
  const text = String(block ?? '');
  const first = findDateTimes(text)[0];
  if (!first) return text;
  const end = Number.isInteger(first.end) ? first.end : first.index + first.length;
  const after = text.slice(end);
  const speaker = /^\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*(?::|：|点|时)\s*(?:\d{1,2}\s*分?)?\s*([\u4e00-\u9fa5]{1,6}?(?:老师|教授|讲师|助教|辅导员|班长|学委|课代表|主任|实验员|管理员))/.exec(
    after,
  );
  if (!speaker) return text;
  const cut = end + speaker[0].length;
  const head = text.slice(0, cut).trim();
  const rest = text.slice(cut).replace(/^\s*[：:]\s*/, '').trim();
  return rest ? `${head}\n${rest}` : head;
}

/** 纯抬头行（群名 / 日期 + 姓名 / 署名），不含任务信息。 */
function isHeaderOnlyLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return true;
  if (isHeaderLikeLine(text)) return true;
  // OCR 常在群名后多带一两个噪声字符（`实验课群 wm`、`教务通知让`），去掉后再判断
  const denoised = dropTrailingNoise(text);
  if (!denoised) return true;
  if (/^[\u4e00-\u9fa5A-Za-z0-9\s（）()·]{1,24}$/.test(denoised) && !hasWorkNoun(denoised) && !ACTION_RE.test(denoised)) {
    return true;
  }
  // 去掉噪声后是**纯中文短名**（`实验课群 wm` → `实验课群`、`班级群通知部` → `班级群通知`）：
  // 这是群名/栏目名，不是任务，不能因为名字里带「实验」两个字就当成一条候选。
  if (/^[\u4e00-\u9fa5]{2,8}$/.test(denoised) && !ACTION_RE.test(denoised) && !findDateTimes(denoised).length) {
    return true;
  }
  return false;
}

/**
 * 去掉 OCR 在群名/署名后面多带出来的噪声字符：`实验课群 wm` → `实验课群`，
 * `教务通知让` → `教务通知`，`班级群通知部` → `班级群通知`。
 * 只在末尾删 1–3 个字母或单个「让/部/比」，不碰正文中间的字。
 */
function dropTrailingNoise(line) {
  return String(line ?? '').replace(TRAILING_NOISE_RE, '').trim();
}

/** 页脚/示例说明行。 */
function isFootnoteLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return true;
  if (/示例图|合成示例|不是真实聊天记录|仅供示例|示例文本/.test(text)) return true;
  return /^[（(【][^）)】]*[）)】]$/.test(text);
}

/**
 * 一行拆成 1..n 段：
 *   - 行首是「1. / 作业二：」这类序号 → 第一段是新的候选起点；
 *   - 句子中间还有「；作业二：」→ 那一截也各自成为新候选（同一行的两条任务）。
 */
function expandInline(line) {
  const headIsStart = SEGMENT_START_PATTERNS.some((re) => re.test(line));
  const parts = splitByInlineMarkers(line);
  if (!headIsStart && parts.length === 1) return [{ text: line, isStart: false }];
  return parts.map((part, index) => ({
    text: part,
    isStart: index === 0 ? headIsStart : SEGMENT_START_PATTERNS.some((re) => re.test(part)),
  }));
}

/**
 * 用行内序号标记切分（分隔标点留在前一段，序号留在后一段）。
 * 只认「；作业二：」「。任务3、」「；②」这几种明确写法，避免拆坏 URL 和普通句子。
 */
function splitByInlineMarkers(line) {
  const pattern = new RegExp(
    `([；;。])\\s*((?:作业|任务|第)\\s*[0-9${ORDINAL}]{1,3}\\s*[.、,，:：\\-)）]|[①②③④⑤⑥⑦⑧⑨⑩])`,
    'g',
  );
  const cuts = [];
  let match = pattern.exec(line);
  while (match) {
    cuts.push(match.index + match[1].length);
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    match = pattern.exec(line);
  }
  if (!cuts.length) return [line];
  const parts = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(line.slice(start, cut).trim());
    start = cut;
  }
  parts.push(line.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * 去掉开头的序号。
 *
 * 只认**列表序号**本身（数字 / 括号数字 / 圈码 / 「作业二：」「任务3、」）：
 *   - `1.` / `2、` / `（3）` / `①` → 去掉；
 *   - `作业二：` / `任务3、` → 去掉（序号本身就是标题的一部分）。
 * **不碰「第」**：`第三次作业` 是任务名的一部分，去掉「第」会变成「三次作业」，
 * 用户明确要求第三次作业不能变成次作业或空标题。
 */
function stripLeadingNumber(text) {
  const source = String(text ?? '');
  return source
    // 行首序号（`1.` / `2、` / `（3）` / `①`）去掉的前提是**后面真的还有文字**
    // （`1. ` 后面可以跟空白，但再往后必须有汉字/字母，否则整条只剩序号，要保留原样）。
    .replace(/^\s*(?:[(（]\d{1,2}[)）]|\d{1,2})\s*[.、,，:：\-)）](?=\s*[\u4e00-\u9fffA-Za-z])/, '')
    .replace(/^\s*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫]\s*/, '')
    .replace(/^\s*(?:作业|任务)\s*(?:\d{1,3}|[一二三四五六七八九十]{1,3})\s*[.、,，:：\-)]?\s*/, '')
    .trim();
}

/**
 * 从一段里取标题：优先取**含动作词/任务名词**的那一行（跳过聊天抬头、日期抬头），
 * 最多 60 字。取不到动作行时退回第一行有效内容。
 *
 * 已放弃「在日期处截断尾部」的写法：那会把日期后面的任务名词一起丢掉
 * （`1. 请于 2026年10月15日 22:00 前提交实验报告` → 只剩 `请于`）。
 * 现在只**逐个移除日期/时刻片段本身**，前后文字原样保留。
 *
 * 如果这一行是「主题：正文」结构（`高等数学作业册：2026年12月20日…提交`），
 * 冒号前那截通常就是任务名，优先用它。
 */
export function extractTitle(segmentText) {
  const { masked, restore } = maskSensitive(segmentText);
  const lines = masked
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  // 纯抬头行（`2026年10月8日 08:30 张老师`、`实验课群 wm`）没有任务信息，不拿来当标题
  const contentLines = lines.filter((line) => !isHeaderLikeLine(line));
  const pool = contentLines.length ? contentLines : lines;
  const chosen = pool.find((line) => ACTION_RE.test(line) || hasWorkNoun(line)) || pool[0] || '';

  const subject = subjectBeforeColon(chosen);
  if (subject) return restore(subject).slice(0, 60).trim();

  const cleaned = stripDateTimes(chosen)
    // 日期被删掉后残留的「截止 / 之前 / 前」不是任务内容：`…22:00 前提交` → `…提交`。
    .replace(/(截止|deadline|ddl|之前|以前)\s*/gi, '')
    .replace(/前(?=[\u4e00-\u9fff])/g, '')
    .replace(/^[，,。；;、:：\-\s]+/, '')
    .replace(/[，,。；;、:：\-\s]+$/, '')
    // 日期片段被拿走后留下的空格不属于正文：中文之间不留空格，
    // 中文与英文/数字之间保留一个（`完成课后习题 5.1-5.5`）。
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const withoutNumber = stripLeadingNumber(cleaned);
  const sentence = withoutNumber.split(/[。;；!！?？\n]/)[0].trim() || withoutNumber;
  return restore(sentence.replace(/[，,、\s]+$/, '').slice(0, 60)).trim();
}

/** 只把**日期/时刻片段本身**删掉，前后文字都保留（不做尾部截断、不插空格）。 */
function stripDateTimes(line) {
  const text = String(line ?? '');
  const spans = findDateTimes(text)
    .map((item) => [item.index, item.index + item.length])
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return text;
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    out += text.slice(cursor, start);
    cursor = end;
  }
  return `${out}${text.slice(cursor)}`;
}

/** 「作业 / 实验 / 报告」等任务名词，用于跳过聊天抬头行。 */
function hasWorkNoun(line) {
  return /(作业|习题|练习|实验|报告|论文|课程设计|课设|考试|测验|答辩|汇报|展示|阅读|预习|复习|提交|截止|要求)/.test(
    line,
  );
}

/**
 * 取「主题：正文」结构里的主题部分。
 * 只在这截真的像任务名（有任务名词、长度 4–40、不是日期时间/称呼）时才返回。
 */
function subjectBeforeColon(line) {
  const text = stripLeadingNumber(String(line ?? '').trim());
  const dateAt = findDateTimes(text).find((item) => item.kind === 'date');
  const scope = dateAt ? text.slice(0, dateAt.index) : text;
  const match = /^([^：:]{4,80})[：:]/.exec(scope);
  if (!match) return '';
  const subject = match[1].trim();
  if (!hasWorkNoun(subject)) return '';
  // 「提交要求 / 提交方式 / 通知」这类标签后面跟的是正文，整行才是标题，
  // 不能只取冒号前那截（`提交要求：实验报告 PDF` 取标题要保留后半句）。
  if (/(要求|说明|方式|通知|注意|备注|时间|地点)$/.test(subject)) return '';
  if (findDateTimes(subject).length) return '';
  if (/^(各位|同学|大家|老师|通知|注意|请|关于)/.test(subject) && subject.length < 8) return '';
  return subject;
}

export function guessTaskType(text) {
  const source = String(text ?? '');
  for (const rule of TYPE_RULES) {
    if (rule.re.test(source)) return rule.type;
  }
  return 'HOMEWORK';
}

/** 提交要求：只认「提交要求：/要求：」显式标签，不臆测。 */
export function extractSubmitRequirement(text) {
  const match = SUBMIT_REQUIREMENT_RE.exec(String(text ?? ''));
  if (!match) return { value: '', label: null };
  return { value: match[2].trim().slice(0, 500), label: match[1] };
}

/** 具体提交方式词（出现就优先取它，而不是「提交」这类泛化动作）。 */
const SUBMIT_SPECIFIC_RE =
  /学习通|雨课堂|超星|钉钉|腾讯会议|百度网盘|问卷星|小程序|纸质|打印稿|手写|线下|当面|学习委员|班长|课代表/i;

/**
 * 泛化容器词（平台/系统/网站/链接）：**不当作提交方式**。
 * 「提交到平台」「无任何平台线索」都没有信息量，返回空让用户自己填，
 * 也不会因为 `提交` 里的 `交` 抢先命中而把具体平台名（学习通/雨课堂）挤掉。
 */
const SUBMIT_GENERIC_RE = /平台|系统|网站|链接|邮箱|邮件|email|e-mail|微信|QQ|教务/i;

/**
 * 提交方式：只在出现平台/邮箱/纸质等明确词时给出。
 * 邮箱、URL、`a+b@example.edu.cn` 这样的地址保持原样，不会被标点切碎。
 * 只有泛化词（平台/系统/网站）而没有具体线索时返回空，避免给出没有信息量的「方式」。
 *
 * 一个坑（真实 OCR 会踩到）：不能用 `SUBMIT_METHOD_RE.exec()` 只取**第一个**命中，
 * `提交到学习通` 会先命中 `提交` 里的 `交`，于是「学习通」永远取不到。
 * 所以这里按「具体平台/纸质/邮箱地址」挑，泛化容器词不入选。
 */
export function extractSubmitMethod(text) {
  const source = String(text ?? '');
  const { masked, restore } = maskSensitive(source);
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(source);
  const fallback = email ? email[0] : '';

  const maskedRanges = masked ? [...masked.matchAll(/\u0000M\d+\u0000/g)].map((m) => [m.index, m.index + m[0].length]) : [];
  const isMasked = (index) => maskedRanges.some(([start, end]) => index >= start && index < end);

  const hits = [];
  for (const match of masked.matchAll(new RegExp(SUBMIT_METHOD_RE.source, 'gi'))) {
    if (isMasked(match.index)) continue;
    const raw = restore(match[0]).trim();
    if (!SUBMIT_SPECIFIC_RE.test(raw)) continue;
    hits.push({ raw, length: raw.length, index: match.index });
  }

  if (!hits.length) return fallback;
  hits.sort((a, b) => b.length - a.length || a.index - b.index);
  return hits[0].raw.slice(0, 128);
}

/** 课程名后允许跟的字符：句读、空格，或「作业 / 习题 / 第三次」这类任务后缀。 */
const COURSE_BOUNDARY_RE =
  /^[\s，,。;；、:：!！?？\-—()（）]|^(?:作业|习题|练习|课|课程|课设|老师|教师|期末|期中|随堂|第[0-9一二三四五六七八九十]|[0-9]+次)/;

/** 与已有课程做**完全一致**匹配（名称或代码），并检查名称边界，避免「高等数学实验」并进「高等数学」。 */
export function matchCourse(text, courses = []) {
  const source = String(text ?? '').replace(/\s+/g, '');
  if (!source) return null;
  const hits = [];
  for (const course of courses) {
    for (const key of [course?.name, course?.code]) {
      const normalized = String(key ?? '').replace(/\s+/g, '');
      if (normalized.length < 2) continue;
      let from = 0;
      for (;;) {
        const at = source.indexOf(normalized, from);
        if (at < 0) break;
        const next = source.slice(at + normalized.length, at + normalized.length + 4);
        // next 为空 = 课程名正好在结尾，同样算完全一致
        if (next === '' || COURSE_BOUNDARY_RE.test(next)) hits.push({ course, length: normalized.length });
        from = at + 1;
      }
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.length - a.length);
  const top = hits[0];
  const tied = hits.filter((hit) => hit.length === top.length && hit.course.id !== top.course.id);
  return tied.length ? null : top.course;
}

/**
 * 主入口：一段/多条通知文字 → 任务候选（纯函数，不发请求、不产生副作用）。
 *
 * @param {string} rawText 用户粘贴或 OCR 得到的原文
 * @param {object} options
 *   - courses: [{ id, name, code }]，只做完全一致匹配
 *   - sourceRef / sourceName：候选要保留的来源引用
 *   - maxTasks：最多返回多少条
 */
export function parseNoticeText(rawText, { courses = [], sourceRef = null, sourceName = '', maxTasks = 30 } = {}) {
  const text = typeof rawText === 'string' ? rawText : '';
  const segments = splitSegments(text).slice(0, Math.max(1, maxTasks));
  return segments
    .map((segment) => {
      const deadlineInfo = extractDeadline(segment.text);
      const course = matchCourse(segment.text, courses);
      const requirement = extractSubmitRequirement(segment.text);
      const method = extractSubmitMethod(segment.text);
      const title = extractTitle(segment.text);
      const hints = [...deadlineInfo.hints];
      if (!course) hints.push(NOTICE_HINTS.courseUnmatched);
      if (!title) hints.push('这段文字里没有提取到可用的任务标题：请手工填写标题。');
      return {
        segmentId: segment.id,
        segmentIndex: segment.index,
        rawText: segment.text,
        title,
        type: guessTaskType(segment.text),
        courseId: course?.id ?? null,
        courseName: course?.name ?? '',
        deadline: deadlineInfo.deadline,
        deadlineDisplay: deadlineInfo.display,
        /** 原文里所有完整的「日期 + 时刻」：界面用它让用户在模糊时自己选，而不是替用户猜。 */
        deadlineOptions: deadlineInfo.options ?? [],
        submitRequirement: requirement.value,
        submitMethod: method,
        hints: unique(hints),
        sourceRef,
        sourceName,
      };
    })
    // 群名、日期抬头、「（合成示例图…）」这类页脚不是任务，别生成空候选干扰用户
    .filter((candidate) => isMeaningfulCandidate(candidate, text));
}

/**
 * 一条片段是否值得变成候选：要么真的含任务线索（动作/任务名词），
 * 要么解析出了明确的截止时间。纯抬头/页脚/闲聊会被过滤掉。
 */
export function isMeaningfulCandidate(candidate, wholeText = '') {
  const segment = String(candidate.rawText ?? '');
  if (!segment.trim()) return false;
  if (candidate.deadline) return true;
  if (matchLooksLikeFootnote(segment)) return false;
  const hasTaskWord = hasWorkNoun(segment) || ACTION_RE.test(segment) || /截止|提交|交|作业|报告|实验|考试|答辩|课程设计/.test(segment);
  if (!hasTaskWord) return false;
  // 抬头行（日期时间 + 姓名，或纯群名）本身不是任务
  if (segment.length <= 40 && /^[\u4e00-\u9fa5A-Za-z0-9\s（）()·:：\-]*/.test(segment)) {
    const withoutHeader = segment.replace(
      /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2})(\s*(?:凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*(?::|：|点|时)\s*(?:\d{1,2}\s*分?)?)?/g,
      '',
    );
    if (!hasWorkNoun(withoutHeader) && !ACTION_RE.test(withoutHeader)) return false;
  }
  return true;
}

/** 页脚/说明行：括号包裹的示例说明、纯「（…）」、明显的免责声明。 */
function matchLooksLikeFootnote(segment) {
  const text = segment.trim();
  if (/^[（(【][^）)】]*[）)】]$/.test(text)) return true;
  if (/示例图|合成示例|不是真实聊天记录|仅供示例|示例文本/.test(text)) return true;
  return false;
}

/** 供界面提示：这段文字里有没有「需要用户核对」的时间线索。 */
export function hasRelativeTimeCue(text) {
  return RELATIVE_DEADLINE_RE.test(String(text ?? ''));
}

/** 供界面提示：这段文字是否包含动作/任务线索。 */
export function hasActionCue(text) {
  return ACTION_RE.test(String(text ?? ''));
}

/** 供测试与界面复用：只要「完整日期 + 时刻」（不含时区），返回第一个。 */
export function firstCompleteDeadline(text) {
  return extractDeadline(text).deadline || '';
}

export { ACTION_RE, RELATIVE_DEADLINE_RE, DEADLINE_CUE_RE, SEGMENT_START_PATTERNS };
