package com.ddlmate.service;

import java.time.DateTimeException;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 自然语言**简短时间短语** → 确定性的「日期 + 时刻」（纯函数）。
 *
 * <p>边界（与 docs/v1.2-time-assistant.md 一一对应）：</p>
 * <ol>
 *   <li>这是**规则解析**，不是大模型语义理解；只接受很短的时间短语，不解析整段通知。</li>
 *   <li>日历语义固定：星期从周一算起，日期由调用方传入的参考自然日推导（业务时区固定 Asia/Shanghai）。</li>
 *   <li><strong>整句覆盖</strong>：产生 RESOLVED / COURSE_WINDOW 之前，会确认规范化后的整句话
 *       只由「已识别的日期 / 时刻 token」+「有定义且不改变语义的包装词（前 / 之前 / 截止 / 提交…）」
 *       组成。任何多余字符（`之后`、`开始`、`两小时`、多余数字、被截断的 `下下`）都会被保守拒绝，
 *       因此不靠无限否定词黑名单也能挡住 `明天18:000`、`明天123:00`、`下下周五18:00` 这类误判。</li>
 *   <li>信息不足就返回 {@code NEEDS_INFO}：只有日期、只有时刻、今晚、尽快、周末、范围、多重时间，
 *       **绝不补 23:59**，也绝不取第一个静默成功。</li>
 *   <li>否定 / 延期 / 更改 / 「…以前」/ 需要校历的说法返回 {@code UNSUPPORTED}。</li>
 *   <li>不带「本周 / 下周」的「周X」按**本周**理解；这一天已经过去时**不自动跳周**，而是要求写清楚。</li>
 *   <li>课程说法只认**精确**的通用短语（下节课前 / 下次课前 / 下次上课前 / 本周五上课前 / 下周这门课前…），
 *       带课程名或类型限定（「下次数学课前」「下周实验课前」）一律拒绝并提示明确选择课程或写明确时间；
 *       具体是哪节课由 {@link TimeResolveService} 复用 {@link ScheduleRules#occursOn} 查真实课表。</li>
 * </ol>
 */
public final class TimePhraseParser {

    private TimePhraseParser() {
    }

    /** 解析结果的大类。 */
    public enum Outcome { RESOLVED, NEEDS_INFO, UNSUPPORTED, COURSE_WINDOW }

    /** 课程边界说法的检索窗口。 */
    public enum WindowScope {
        /** 限定到某一天（本周五上课前 / 下周五上课前）。 */
        DAY,
        /** 限定到一个自然周（下周这门课前 = 下周一整周；本周这门课前 = 本周剩余几天）。 */
        WEEK,
        /** 参考时间之后的最近一次课（下节课前 / 下次课前），最多搜 366 天。 */
        NEXT
    }

    /** 一条解析出的时间（LocalDateTime 是上海墙上时间）。 */
    public record ResolvedTime(LocalDateTime dateTime, String reason, List<String> hints) {
    }

    /** 课表匹配用的时间窗口：{@code [start, endExclusive)} 闭开区间。 */
    public record Window(WindowScope scope, LocalDate start, LocalDate endExclusive, String phrase) {
    }

    /** 解析结论：要么是可用的时间/窗口，要么是可解释的拒绝理由。 */
    public record Parsed(Outcome outcome, String message, List<String> hints, List<ResolvedTime> times,
            Window window, String phrase) {

        static Parsed resolved(String phrase, List<ResolvedTime> times, List<String> hints) {
            return new Parsed(Outcome.RESOLVED, "已解析出候选时间", hints, times, null, phrase);
        }

        static Parsed needsInfo(String message, List<String> hints) {
            return new Parsed(Outcome.NEEDS_INFO, message, hints, List.of(), null, null);
        }

        static Parsed unsupported(String message, List<String> hints) {
            return new Parsed(Outcome.UNSUPPORTED, message, hints, List.of(), null, null);
        }

        static Parsed courseWindow(Window window, String phrase) {
            return new Parsed(Outcome.COURSE_WINDOW, "按课程边界解析", List.of(), List.of(), window, phrase);
        }
    }

    /** 解析过程中发现"信息不够"时抛出，由 {@link #parse} 统一转成 NEEDS_INFO。 */
    private static final class NeedInfo extends RuntimeException {
        NeedInfo(String message) {
            super(message);
        }
    }

    private static final String MERIDIEM = "凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|今晚|明晚";
    private static final String[] WEEKDAY_CN = { "周一", "周二", "周三", "周四", "周五", "周六", "周日" };

    /** 否定 / 延期 / 更改：保守拒绝，不猜。 */
    private static final Pattern UNSAFE_COMPLEX = Pattern.compile(
            "取消|不用|不需要|不必|无需|勿|别交|延期|推迟|延后|改期|更改|改成|改为|改到|不是|并非|过期|算了|"
                    + "不交|不做|不参加|没有确定|未定|待定|待确认|不确定");

    /** 「三天以前 / 两周之前」这类相对过去的说法：助手只解析将来，直接拒绝。 */
    private static final Pattern PAST_RELATIVE = Pattern.compile(
            "[0-9一二三四五六七八九十两]\\s*(?:天|日|周|星期|个?月|年)\\s*(?:以前|之前)");

    /** 需要校历才能算的说法。 */
    private static final Pattern CALENDAR_DEPENDENT = Pattern.compile(
            "国庆|寒假|暑假|开学|期末周|考试周|校历|放假|节假日|假期|调休");

    /**
     * 范围太宽 / 不够具体的说法。顺序即优先级，命中即返回 NEEDS_INFO。
     * 注意「下周」单独出现不在这里处理：它要区分「下周X」和「下周」两种写法。
     */
    private static final List<GranularityHint> GRANULARITY_HINTS = List.of(
            new GranularityHint(Pattern.compile("尽快|随时|有空|抽空|稍后|以后|接下来"),
                    "「尽快 / 随时 / 以后」不是确定时刻：请写明确的一天与时刻（例如「明天 18:00」）。"),
            new GranularityHint(Pattern.compile("每(?:天|日|周|星期|月|年)"),
                    "这是重复发生的时间，不是一次性的截止时间：请写具体哪一天（例如「本周五 18:00」）。"),
            new GranularityHint(Pattern.compile("周末"),
                    "「周末」是一整段范围：请具体到周六或周日（例如「本周六 12:00」）。"),
            new GranularityHint(Pattern.compile("月底|月初|中旬|上旬|下旬|下个月|下月|本月|这个月"),
                    "这是「月」级别的范围：请具体到某一天与时刻（例如「10 月 20 日 22:00」）。"));

    /**
     * 精确支持的**周限定**课程短语：只允许「本周 / 这周 / 下周 + 可选星期 + 可选这门 + 上课前」，
     * 中间不允许插入课程名或类型词（实验 / 上机 / 数学…）。
     */
    private static final Pattern COURSE_WINDOW = Pattern.compile(
            "(本周|这周|下周|下个星期|本星期|这个星期|这星期)"
                    + "(?:[一二三四五六日天1-7])?"
                    + "(?:这|那)?门?"
                    + "(?:的)?"
                    + "(?:上)?课"
                    + "(?:之)?前");

    /**
     * 精确支持的**次/节限定**课程短语：下节课前 / 下次课前 / 下次上课前 / 下一节课之前。
     * 中间不允许任何其它字，`下次数学课前` 因此不会被当成「下次课前」。
     */
    private static final Pattern NEXT_CLASS = Pattern.compile(
            "(?:下(?:一)?次|下(?:一)?节)(?:的)?(?:上)?课(?:之)?前");

    /**
     * 宽口径的「课前」短语探测：只用于**计数与提示**（多个条件 / 带课程名或类型限定的说法），
     * 绝不用于产出候选。允许 0–8 个限定字，因此 `下次数学课前`、`下周实验课前` 都能被认出来并拒绝。
     */
    private static final Pattern COURSE_PHRASE_ANY = Pattern.compile(
            "(?:下(?:一)?(?:次|节)|(?:本|这|下)(?:个)?(?:周|星期))"
                    + "[^，,。；;！？、\\s]{0,8}?"
                    + "(?:上课|上机|实验|课)"
                    + "(?:之)?前");

    /** 连「下 / 本 / 这」都没有的「课前」，如「上课前」「课前」：提示写清楚。 */
    private static final Pattern BARE_COURSE_PHRASE = Pattern.compile("(?:上)?课(?:之)?前");

    private static final Pattern ABS_DATE = Pattern.compile(
            "(\\d{4})\\s*[-/.年]\\s*(\\d{1,2})\\s*[-/.月]\\s*(\\d{1,2})\\s*[日号]?");
    private static final Pattern MONTH_DAY = Pattern.compile("(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*[日号]");
    private static final Pattern DAY_ONLY = Pattern.compile("(\\d{1,2})\\s*[日号]");
    private static final Pattern REL_DAY = Pattern.compile("大后天|今天|今日|今晚|明天|明日|明晚|后天|后日");
    private static final Pattern WEEKDAY = Pattern.compile("(本|这|下个|下)?(?:周|星期)([一二三四五六日天1-7])");
    private static final Pattern WEEK_ONLY = Pattern.compile("下周|下个星期|本周|这周|本星期|这个星期|这星期");

    /** 时刻：`22:00`、`22点`、`22点30`、`晚上8点`、`下午3点半`。 */
    private static final Pattern TIME = Pattern.compile(
            "(?:(?<prefix>" + MERIDIEM + ")\\s*)?"
                    + "(?<h>\\d{1,2})\\s*"
                    + "(?:(?<colon>:)\\s*(?<cm>\\d{1,2})"
                    + "|(?<cn>[点时])(?:(?<half>半|一刻|三刻)|(?<nm>\\d{1,2})\\s*分?)?)");

    /**
     * 允许出现在日期 / 时刻 token 之外、且**不改变语义**的包装词。
     * 采用「有限白名单 + 全句覆盖」的策略：不在这里的词一律拒绝，避免靠否定词黑名单漏判。
     */
    private static final Pattern FILLER_TOKENS = Pattern.compile(
            "之前|截止|截至|提交到|提交|上交|上传|发送|完成|需要|务必|请在|请于|请|于|在|的|要|需|前|交|到|至|和|及|与|给");

    /** 包装词之间允许的空白与标点。 */
    private static final Pattern FILLER_PUNCT = Pattern.compile("[\\s，,。；;、:：~～\\-—()（）\\[\\]【】\"'“”‘’]+");

    private enum DateKind { ABS, MONTH_DAY, DAY_ONLY, REL, WEEKDAY }

    private record DateToken(int start, int end, String raw, DateKind kind, int year, int month, int day,
            String weekPrefix, int weekday) {
    }

    private record TimeToken(int start, int end, String raw, String prefix, int hour, int minute) {
    }

    private record GranularityHint(Pattern pattern, String message) {
    }

    // ------------------------------------------------------------------ 入口

    /**
     * @param rawText       用户输入的简短时间短语
     * @param referenceDate 参考时间的**业务时区自然日**（Asia/Shanghai），「今天 / 本周」都以它为准
     */
    public static Parsed parse(String rawText, LocalDate referenceDate) {
        String text = normalize(rawText);
        if (text.isEmpty()) {
            return Parsed.needsInfo("请写一个简短的时间短语，例如「明天 22:00」「本周五 18:00」或「下周五上课前」。", List.of());
        }
        if (referenceDate == null) {
            throw new IllegalArgumentException("参考日期不能为空");
        }
        if (UNSAFE_COMPLEX.matcher(text).find()) {
            return Parsed.unsupported(
                    "这句话里有否定 / 延期 / 更改一类说法，时间助手不做推测：请直接写清楚目标时间（例如「下周五 18:00」）。",
                    List.of("助手只解析简短的时间短语，不处理「取消 / 延期 / 改到」这类复杂句。"));
        }
        if (PAST_RELATIVE.matcher(text).find()) {
            return Parsed.unsupported(
                    "「…以前」是相对过去的说法，助手只解析将来的明确时间：请写「今天 22:00」这样的明确写法。",
                    List.of());
        }
        if (CALENDAR_DEPENDENT.matcher(text).find()) {
            return Parsed.unsupported(
                    "这句话要靠校历（假期 / 开学 / 考试周）才能算，目前没有校历数据，助手不做推测。",
                    List.of("可以改写成本周 / 下周 + 星期几，例如「下周五 18:00」。"));
        }

        // ---------- 课程边界说法：先精确匹配，再对宽口径命中做保守拒绝 ----------
        int broadCourseCount = countMatches(COURSE_PHRASE_ANY, text);
        Matcher weekCourse = COURSE_WINDOW.matcher(text);
        boolean exactWeek = weekCourse.find();
        Matcher nextClass = NEXT_CLASS.matcher(text);
        boolean exactNext = !exactWeek && nextClass.find();
        if (broadCourseCount >= 2) {
            return Parsed.needsInfo(
                    "这句话里有多个「课前」条件（例如「…或…」「…和…」），助手不能只取第一个：请只保留一个条件。",
                    List.of("例如只写「下周五上课前」。"));
        }
        if (exactWeek || exactNext) {
            int start = exactWeek ? weekCourse.start() : nextClass.start();
            int end = exactWeek ? weekCourse.end() : nextClass.end();
            String matched = exactWeek ? weekCourse.group() : nextClass.group();
            String leftover = stripSpan(text, start, end);
            if (hasConcreteDateOrTime(leftover)) {
                return Parsed.needsInfo(
                        "同一句话里既有「课前」又有具体日期 / 时刻，无法确定以哪个为准：请只保留一种说法。",
                        List.of("例如只写「下周五上课前」，或只写「下周五 18:00」。"));
            }
            if (!isAllowedFiller(leftover)) {
                return Parsed.needsInfo(
                        "「" + matched + "」外面还有助手无法识别的内容「" + leftover.trim()
                                + "」：请只保留一个「课前」短语（例如「下周五上课前」）。",
                        List.of("「课前两小时」「课前或…」这类修饰暂不支持，避免替你猜时间。"));
            }
            if (exactWeek) {
                return Parsed.courseWindow(weekWindow(weekCourse, referenceDate), matched);
            }
            return Parsed.courseWindow(new Window(WindowScope.NEXT, referenceDate, referenceDate.plusDays(366),
                    matched), matched);
        }
        if (broadCourseCount >= 1 || BARE_COURSE_PHRASE.matcher(text).find()) {
            return Parsed.needsInfo(
                    "带课程名或类型限定的「课前」说法暂不支持：请先明确选择那门课的课表，"
                            + "或直接写明确时间（例如「下周五 18:00」）。",
                    List.of("可以用的课前说法只有：「下节课前 / 下次课前 / 下次上课前 / 本周五上课前 / 下周这门课前」。",
                            "「下次数学课前」「下周实验课前」这类限定不会替你猜是哪一节。"));
        }

        // ---------- 普通时间短语 ----------
        for (GranularityHint hint : GRANULARITY_HINTS) {
            if (hint.pattern().matcher(text).find()) {
                return Parsed.needsInfo(hint.message(), List.of());
            }
        }

        List<DateToken> dates = dedupeOverlaps(collectDates(text));
        List<TimeToken> times = collectTimes(text);

        if (dates.size() > 1) {
            return Parsed.needsInfo(
                    "这句话里有多个日期（" + join(dates.stream().map(DateToken::raw).toList())
                            + "），助手不能只取第一个：请分开写，或只保留一个日期。",
                    List.of("一次只解析一个时间点。"));
        }
        if (times.size() > 1) {
            return Parsed.needsInfo(
                    "这句话里有多个时刻（" + join(times.stream().map(TimeToken::raw).toList())
                            + "），助手不能只取第一个：请分开写，或只保留一个时刻。",
                    List.of("一次只解析一个时间点。"));
        }
        if (dates.isEmpty() && times.isEmpty()) {
            if (WEEK_ONLY.matcher(text).find()) {
                return Parsed.needsInfo("「下周 / 本周」还需要具体到某一天与时刻：请写「下周五 18:00」。",
                        List.of("也可以写「下周五上课前」，助手会去课表里找那门课的下一节。"));
            }
            return Parsed.needsInfo(
                    "没有认出可用的时间说法。助手支持：今天 / 明天 / 后天 / 本周X / 这周X / 下周X + 明确时刻，"
                            + "精确日期 YYYY-MM-DD HH:mm，以及「下节课前」这类课程说法。",
                    List.of("示例：「明天 22:00」「本周五 18:00」「2026-10-20 23:00」「下周五上课前」。"));
        }
        if (dates.isEmpty()) {
            return Parsed.needsInfo(
                    "只有时刻「" + times.get(0).raw() + "」，没有日期：请补上哪一天（例如「明天 " + times.get(0).raw() + "」）。",
                    List.of("助手不会默认按今天算，也不会补 23:59。"));
        }
        if (times.isEmpty()) {
            return Parsed.needsInfo(
                    "只有日期「" + dates.get(0).raw() + "」，没有具体时刻：请补上几点几分（例如「" + dates.get(0).raw()
                            + " 22:00」）。",
                    List.of("助手不会默认按当天 23:59 处理。"));
        }

        // 全句覆盖：日期 / 时刻 token 之外的字符必须只是允许的包装词，
        // 否则 `下下周五18:00`（残留「下」）、`明天18:000`（残留「0」）、
        // `明天123:00`（残留「1」）、`明天18:00之后`（残留「之后」）都会被保守拒绝。
        String leftover = stripSpans(text, dateSpans(dates), timeSpans(times));
        if (!isAllowedFiller(leftover)) {
            return Parsed.needsInfo(
                    "这句话里还有助手无法识别的内容「" + leftover.trim() + "」：请只保留一个确定的时间点"
                            + "（例如「明天 18:00」）。",
                    List.of("不支持的写法（例如「之后」「开始」「18:000」）不会被截断后静默采用。"));
        }

        List<String> hints = new ArrayList<>();
        try {
            LocalDate date = resolveDate(dates.get(0), referenceDate, hints);
            LocalTime time = resolveTime(times.get(0), hints);
            String reason = "“" + text + "” → " + date + "（" + weekdayLabel(date) + "）"
                    + String.format("%02d:%02d", time.getHour(), time.getMinute()) + "（北京时间 +08:00）";
            return Parsed.resolved(text, List.of(new ResolvedTime(LocalDateTime.of(date, time), reason, List.copyOf(hints))),
                    List.copyOf(hints));
        } catch (NeedInfo needInfo) {
            return Parsed.needsInfo(needInfo.getMessage(), List.of());
        }
    }

    // ------------------------------------------------------------------ 课程窗口

    private static Window weekWindow(Matcher matcher, LocalDate referenceDate) {
        String whole = matcher.group();
        String week = matcher.group(1);
        String afterWeek = whole.substring(week.length());
        Character dayChar = afterWeek.isEmpty() || !isWeekdayChar(afterWeek.charAt(0)) ? null : afterWeek.charAt(0);
        boolean nextWeek = week.startsWith("下");
        LocalDate thisMonday = mondayOf(referenceDate);
        LocalDate targetMonday = nextWeek ? thisMonday.plusWeeks(1) : thisMonday;
        if (dayChar != null) {
            LocalDate date = targetMonday.plusDays(weekdayNumber(String.valueOf(dayChar)) - 1);
            return new Window(WindowScope.DAY, date, date.plusDays(1), whole);
        }
        if (nextWeek) {
            // 下周严格是下一个自然周：没有课也不越周去更远的周找
            return new Window(WindowScope.WEEK, targetMonday, targetMonday.plusWeeks(1), whole);
        }
        // 本周：只考虑参考时间当天及之后剩下的日子
        return new Window(WindowScope.WEEK, referenceDate, thisMonday.plusWeeks(1), whole);
    }

    // ------------------------------------------------------------------ 日期

    private static LocalDate resolveDate(DateToken token, LocalDate referenceDate, List<String> hints) {
        switch (token.kind()) {
            case ABS -> {
                try {
                    return LocalDate.of(token.year(), token.month(), token.day());
                } catch (DateTimeException ex) {
                    throw new NeedInfo("日期不存在：「" + token.raw() + "」，请核对后重写。");
                }
            }
            case MONTH_DAY -> throw new NeedInfo("「" + token.raw() + "」只有月日没有年份，无法确定是哪一年：请写完整日期"
                    + "（例如 " + referenceDate.getYear() + "-" + pad(token.month()) + "-" + pad(token.day()) + "）。");
            case DAY_ONLY -> throw new NeedInfo("「" + token.raw() + "」只有几号：请写完整日期，或「明天 / 本周五」这样的写法。");
            case REL -> {
                return switch (token.raw()) {
                    case "今天", "今日", "今晚" -> referenceDate;
                    case "明天", "明日", "明晚" -> referenceDate.plusDays(1);
                    case "后天", "后日" -> referenceDate.plusDays(2);
                    case "大后天" -> referenceDate.plusDays(3);
                    default -> throw new NeedInfo("没有认出日期「" + token.raw() + "」。");
                };
            }
            case WEEKDAY -> {
                String prefix = token.weekPrefix() == null ? "" : token.weekPrefix();
                boolean next = prefix.startsWith("下");
                LocalDate monday = mondayOf(referenceDate).plusWeeks(next ? 1 : 0);
                LocalDate date = monday.plusDays(token.weekday() - 1);
                if (prefix.isEmpty()) {
                    if (date.isBefore(referenceDate)) {
                        throw new NeedInfo("「" + weekdayLabel(date) + "」在本周已经过去，助手不会自动跳到下周："
                                + "请写「下周" + weekdayLabel(date).substring(1) + "」或具体日期。");
                    }
                    hints.add("没有写「本周 / 下周」，按本周的「" + weekdayLabel(date) + "」理解；已经过去的日子不会被自动跳到下周。");
                }
                return date;
            }
            default -> throw new NeedInfo("没有认出日期「" + token.raw() + "」。");
        }
    }

    // ------------------------------------------------------------------ 时刻

    private static LocalTime resolveTime(TimeToken token, List<String> hints) {
        int hour = token.hour();
        int minute = token.minute();
        if (hour > 23 || minute > 59) {
            throw new NeedInfo("时刻不存在：「" + token.raw() + "」（小时 0-23、分钟 0-59）。");
        }
        String prefix = token.prefix() == null ? "" : token.prefix();
        switch (prefix) {
            case "凌晨", "早上", "早晨", "上午" -> {
                if (hour == 12) {
                    throw new NeedInfo("「" + prefix + "12点」是正午还是零点不明确：请写 12:00 或 00:00。");
                }
                if (hour > 12) {
                    throw new NeedInfo("「" + prefix + hour + "点」不是有效写法（" + prefix + "是上午）：请改写。");
                }
                hints.add("按「" + prefix + "」理解，解析为 " + String.format("%02d:%02d", hour, minute) + "。");
            }
            case "中午" -> {
                if (hour > 12) {
                    throw new NeedInfo("「中午" + hour + "点」不是有效写法：请写 12:00 或明确的 24 小时时刻。");
                }
                if (hour >= 1 && hour <= 5) {
                    hour += 12;
                    hints.add("按口语习惯，把「中午" + token.hour() + "点」理解为 " + String.format("%02d:%02d", hour, minute) + "。");
                }
            }
            case "下午", "傍晚", "晚上", "今晚", "明晚" -> {
                if (hour == 0) {
                    throw new NeedInfo("「" + prefix + "0点」含义不明确：请写 00:00。");
                }
                if (hour == 12) {
                    throw new NeedInfo("「" + prefix + "12点」是正午还是午夜不明确：请写 12:00 或 00:00。");
                }
                if (hour > 12) {
                    throw new NeedInfo("「" + prefix + hour + "点」不是有效写法（" + prefix + "已经是下午）：请改写。");
                }
                hour += 12;
            }
            default -> {
                if (hour >= 1 && hour <= 11) {
                    hints.add("「" + token.raw() + "」按 24 小时制理解为 " + String.format("%02d:%02d", hour, minute)
                            + "；如果指下午，请写「下午" + token.raw() + "」或「" + (hour + 12) + ":" + pad(minute) + "」。");
                }
            }
        }
        return LocalTime.of(hour, minute);
    }

    // ------------------------------------------------------------------ 词法收集

    private static List<DateToken> collectDates(String text) {
        List<DateToken> tokens = new ArrayList<>();
        for (Matcher m = ABS_DATE.matcher(text); m.find(); ) {
            tokens.add(new DateToken(m.start(), m.end(), m.group(), DateKind.ABS, num(m.group(1)), num(m.group(2)),
                    num(m.group(3)), null, 0));
        }
        for (Matcher m = MONTH_DAY.matcher(text); m.find(); ) {
            tokens.add(new DateToken(m.start(), m.end(), m.group(), DateKind.MONTH_DAY, 0, num(m.group(1)),
                    num(m.group(2)), null, 0));
        }
        for (Matcher m = DAY_ONLY.matcher(text); m.find(); ) {
            tokens.add(new DateToken(m.start(), m.end(), m.group(), DateKind.DAY_ONLY, 0, 0, num(m.group(1)), null, 0));
        }
        for (Matcher m = REL_DAY.matcher(text); m.find(); ) {
            tokens.add(new DateToken(m.start(), m.end(), m.group(), DateKind.REL, 0, 0, 0, null, 0));
        }
        for (Matcher m = WEEKDAY.matcher(text); m.find(); ) {
            tokens.add(new DateToken(m.start(), m.end(), m.group(), DateKind.WEEKDAY, 0, 0, 0, m.group(1),
                    weekdayNumber(m.group(2))));
        }
        return tokens;
    }

    private static List<TimeToken> collectTimes(String text) {
        List<TimeToken> tokens = new ArrayList<>();
        for (Matcher m = TIME.matcher(text); m.find(); ) {
            int minute;
            if (m.group("cm") != null) {
                minute = num(m.group("cm"));
            } else if (m.group("half") != null) {
                minute = switch (m.group("half")) {
                    case "半" -> 30;
                    case "一刻" -> 15;
                    case "三刻" -> 45;
                    default -> 0;
                };
            } else if (m.group("nm") != null) {
                minute = num(m.group("nm"));
            } else {
                minute = 0;
            }
            tokens.add(new TimeToken(m.start(), m.end(), m.group(), m.group("prefix"), num(m.group("h")), minute));
        }
        return tokens;
    }

    /** 丢掉被更长匹配完全包住的短匹配（`2026年10月8日` 里不再单独算一次 `10月8日` / `8日`）。 */
    private static List<DateToken> dedupeOverlaps(List<DateToken> tokens) {
        List<DateToken> sorted = new ArrayList<>(tokens);
        sorted.sort(Comparator.comparingInt(DateToken::start)
                .thenComparing((left, right) -> Integer.compare(right.end(), left.end())));
        List<DateToken> kept = new ArrayList<>();
        for (DateToken token : sorted) {
            boolean covered = kept.stream()
                    .anyMatch(other -> token.start() >= other.start() && token.end() <= other.end());
            if (!covered) {
                kept.add(token);
            }
        }
        kept.sort(Comparator.comparingInt(DateToken::start));
        return kept;
    }

    // ------------------------------------------------------------------ 全句覆盖

    /** 移除某个片段后的剩余文本。 */
    private static String stripSpan(String text, int start, int end) {
        return text.substring(0, start) + text.substring(end);
    }

    /**
     * 依次移除多个片段，返回剩下的文本。
     *
     * <p>必须先**合并重叠片段**再移除：`今晚8点` 的日期 token 是 `今晚`、时刻 token 是 `今晚8点`
     * （时刻 token 带半日前缀，从同一个下标开始），如果按起点倒序逐个删，后一个片段会因为
     * 下标越界被跳过，留下 `8点` 被误判成"无法识别的内容"。</p>
     */
    private static String stripSpans(String text, List<int[]> dateSpans, List<int[]> timeSpans) {
        List<int[]> spans = new ArrayList<>(dateSpans);
        spans.addAll(timeSpans);
        spans.sort(Comparator.comparingInt((int[] span) -> span[0]).thenComparingInt(span -> span[1]));
        List<int[]> merged = new ArrayList<>();
        for (int[] span : spans) {
            if (span[0] < 0 || span[1] > text.length() || span[0] >= span[1]) {
                continue;
            }
            if (!merged.isEmpty() && span[0] <= merged.get(merged.size() - 1)[1]) {
                int[] last = merged.get(merged.size() - 1);
                last[1] = Math.max(last[1], span[1]);
            } else {
                merged.add(new int[] { span[0], span[1] });
            }
        }
        StringBuilder out = new StringBuilder(text.length());
        int cursor = 0;
        for (int[] span : merged) {
            out.append(text, cursor, span[0]);
            cursor = span[1];
        }
        out.append(text, cursor, text.length());
        return out.toString();
    }

    private static List<int[]> dateSpans(List<DateToken> tokens) {
        List<int[]> spans = new ArrayList<>();
        for (DateToken token : tokens) {
            spans.add(new int[] { token.start(), token.end() });
        }
        return spans;
    }

    private static List<int[]> timeSpans(List<TimeToken> tokens) {
        List<int[]> spans = new ArrayList<>();
        for (TimeToken token : tokens) {
            spans.add(new int[] { token.start(), token.end() });
        }
        return spans;
    }

    /** 剩余文本里是否还有"具体日期 / 时刻"（课程短语外面不允许再写一个明确时间）。 */
    private static boolean hasConcreteDateOrTime(String text) {
        return TIME.matcher(text).find()
                || ABS_DATE.matcher(text).find()
                || MONTH_DAY.matcher(text).find()
                || DAY_ONLY.matcher(text).find()
                || REL_DAY.matcher(text).find();
    }

    /**
     * 剩余文本是否只是允许的包装词（空白 / 标点 / 前 / 之前 / 截止 / 提交…）。
     * 任何未定义的字符都会让整句被保守拒绝。
     */
    private static boolean isAllowedFiller(String leftover) {
        if (leftover == null || leftover.isEmpty()) {
            return true;
        }
        String stripped = FILLER_PUNCT.matcher(leftover).replaceAll("");
        String previous;
        do {
            previous = stripped;
            stripped = FILLER_TOKENS.matcher(stripped).replaceAll("");
        } while (!stripped.equals(previous));
        return stripped.isEmpty();
    }

    /** 统计一个模式在文本里出现了几次（本类用到的模式都至少匹配 1 个字符，不存在零宽循环）。 */
    private static int countMatches(Pattern pattern, String text) {
        int count = 0;
        Matcher matcher = pattern.matcher(text);
        while (matcher.find()) {
            count += 1;
        }
        return count;
    }

    private static boolean isWeekdayChar(char ch) {
        return (ch >= '一' && ch <= '六') || ch == '日' || ch == '天' || (ch >= '1' && ch <= '7');
    }

    // ------------------------------------------------------------------ 小工具

    /** 全角数字 / 全角冒号 / 全角空格归一化，不改动任何文字内容。 */
    static String normalize(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(raw.length());
        for (char ch : raw.trim().toCharArray()) {
            if (ch >= '０' && ch <= '９') {
                out.append((char) ('0' + (ch - '０')));
            } else if (ch == '：') {
                out.append(':');
            } else if (ch == '　') {
                out.append(' ');
            } else if (ch == '／') {
                out.append('/');
            } else {
                out.append(ch);
            }
        }
        return out.toString().trim();
    }

    static LocalDate mondayOf(LocalDate date) {
        return date.minusDays(date.getDayOfWeek().getValue() - (long) DayOfWeek.MONDAY.getValue());
    }

    static int weekdayNumber(String value) {
        return switch (value) {
            case "一", "1" -> 1;
            case "二", "2" -> 2;
            case "三", "3" -> 3;
            case "四", "4" -> 4;
            case "五", "5" -> 5;
            case "六", "6" -> 6;
            case "日", "天", "7" -> 7;
            default -> throw new IllegalArgumentException("无法识别的星期：" + value);
        };
    }

    static String weekdayLabel(LocalDate date) {
        return WEEKDAY_CN[date.getDayOfWeek().getValue() - 1];
    }

    private static int num(String value) {
        return value == null || value.isBlank() ? 0 : Integer.parseInt(value);
    }

    private static String pad(int value) {
        return String.format("%02d", value);
    }

    private static String join(List<String> values) {
        return String.join("、", values);
    }
}
