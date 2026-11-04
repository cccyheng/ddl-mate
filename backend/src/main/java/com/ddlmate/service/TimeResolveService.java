package com.ddlmate.service;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.domain.Course;
import com.ddlmate.domain.CourseSchedule;
import com.ddlmate.repository.CourseRepository;
import com.ddlmate.repository.CourseScheduleRepository;
import com.ddlmate.web.dto.ResolveTimeRequest;
import com.ddlmate.web.dto.ResolveTimeResponse;

/**
 * V1.2 时间助手：把简短时间短语解析成明确时间，并在需要时用**真实课表**匹配"下节课前"这类说法。
 *
 * <p>本服务是**只读**的：只查课程与课表，绝不写库、不改任务。所有规则都走
 * {@link TimePhraseParser}（纯函数）与 {@link ScheduleRules#occursOn}（全站唯一的教学周判定），
 * 因此结果可解释、可固定参考时间复现。</p>
 *
 * <p><strong>时区契约</strong>：时间助手固定按 {@code Asia/Shanghai} 计算与输出，
 * 不跟随 {@code DDLMATE_TIME_ZONE} 环境变量，也不会因为响应里写别的时区而让界面按本机时区换算。</p>
 */
@Service
public class TimeResolveService {

    private static final DateTimeFormatter ISO_OFFSET = DateTimeFormatter.ISO_OFFSET_DATE_TIME;
    /** 时间助手固定北京时间：与前端「+08:00」的展示契约一致。 */
    private static final ZoneId SHANGHAI = ZoneId.of("Asia/Shanghai");
    /** 参考时间可接受的年份范围：保证 +366 天等推演不会越界（越界返回 400 而不是 500）。 */
    private static final int MIN_YEAR = 1900;
    private static final int MAX_YEAR = 2199;
    /** 「下节课前」最多向后找 366 天（要求见任务说明 §3）。 */
    private static final int MAX_LOOKAHEAD_DAYS = 366;

    private final CourseRepository courseRepository;

    private final CourseScheduleRepository scheduleRepository;

    public TimeResolveService(CourseRepository courseRepository, CourseScheduleRepository scheduleRepository) {
        this.courseRepository = courseRepository;
        this.scheduleRepository = scheduleRepository;
    }

    @Transactional(readOnly = true)
    public ResolveTimeResponse resolve(ResolveTimeRequest request) {
        OffsetDateTime referenceAt = parseReferenceAt(request.referenceAt());
        ZonedDateTime referenceShanghai = referenceAt.atZoneSameInstant(SHANGHAI);
        LocalDate referenceDate = referenceShanghai.toLocalDate();
        String referenceLocal = referenceDate + " "
                + String.format("%02d:%02d", referenceShanghai.getHour(), referenceShanghai.getMinute())
                + " " + TimePhraseParser.weekdayLabel(referenceDate);

        TimePhraseParser.Parsed parsed = TimePhraseParser.parse(request.text(), referenceDate);
        return switch (parsed.outcome()) {
            case NEEDS_INFO -> build(ResolveTimeResponse.STATUS_NEEDS_INFO, parsed.message(), parsed.hints(),
                    referenceAt, referenceLocal, List.of());
            case UNSUPPORTED -> build(ResolveTimeResponse.STATUS_UNSUPPORTED, parsed.message(), parsed.hints(),
                    referenceAt, referenceLocal, List.of());
            case RESOLVED -> resolved(parsed, referenceAt, referenceLocal);
            case COURSE_WINDOW -> courseBoundary(request, parsed, referenceAt, referenceLocal);
        };
    }

    // ------------------------------------------------------------------ 普通时间短语

    private ResolveTimeResponse resolved(TimePhraseParser.Parsed parsed, OffsetDateTime referenceAt,
            String referenceLocal) {
        List<ResolveTimeResponse.Candidate> candidates = new ArrayList<>();
        List<String> hints = new ArrayList<>(parsed.hints());
        for (TimePhraseParser.ResolvedTime time : parsed.times()) {
            OffsetDateTime deadline = ZonedDateTime.of(time.dateTime(), SHANGHAI).toOffsetDateTime();
            boolean past = deadline.toInstant().isBefore(referenceAt.toInstant());
            if (past && !hints.contains("这个时间在参考时间之前。")) {
                hints.add("这个时间在参考时间之前：如果需要将来的时间，请改写短语。");
            }
            candidates.add(new ResolveTimeResponse.Candidate(
                    deadline.format(ISO_OFFSET),
                    time.reason(),
                    "TIME_PHRASE",
                    past,
                    false,
                    null, null, null, null, null, null, null,
                    "确认后才会填入表单；填进去之后仍然可以手工修改。"));
        }
        return build(ResolveTimeResponse.STATUS_RESOLVED,
                parsed.message(), hints, referenceAt, referenceLocal, candidates);
    }

    // ------------------------------------------------------------------ 课程边界

    private ResolveTimeResponse courseBoundary(ResolveTimeRequest request, TimePhraseParser.Parsed parsed,
            OffsetDateTime referenceAt, String referenceLocal) {
        String phrase = parsed.phrase();
        if (request.courseId() == null) {
            return build(ResolveTimeResponse.STATUS_NEEDS_INFO,
                    "「" + phrase + "」需要先明确选择课程：请先选好这门课，再点解析。",
                    List.of("课程必须由你明确选择，助手不会从文字里替你挑一门课。"),
                    referenceAt, referenceLocal, List.of());
        }
        Course course = courseRepository.findById(request.courseId())
                .orElseThrow(() -> new ResourceNotFoundException("课程", request.courseId()));

        String mentioned = findMentionedOtherCourse(request.text(), course);
        if (mentioned != null) {
            return build(ResolveTimeResponse.STATUS_NEEDS_INFO,
                    "文字里提到的是「" + mentioned + "」，与你选择的「" + course.getName()
                            + "」不是同一门课：请选择对应的课程，或改写短语。",
                    List.of("助手不会忽略文字里的另一门课，直接按当前选择的课程算。"),
                    referenceAt, referenceLocal, List.of());
        }

        List<CourseSchedule> schedules = scheduleRepository.findByCourseIdOrdered(course.getId());
        if (schedules.isEmpty()) {
            return build(ResolveTimeResponse.STATUS_NO_COURSE_MATCH,
                    "「" + course.getName() + "」还没有课表，无法按「课前」推算：请先补上课表，或改用明确时间。",
                    List.of("可以写「下周五 18:00」这样的明确时间。"),
                    referenceAt, referenceLocal, List.of());
        }

        TimePhraseParser.Window window = parsed.window();
        List<Match> matches = collectMatches(schedules, window, referenceAt);
        if (matches.isEmpty()) {
            return build(ResolveTimeResponse.STATUS_NO_COURSE_MATCH, explainNoMatch(course, window),
                    List.of("助手只按约定窗口查找，不会越周去更远的地方找课。",
                            "可以改用明确时间，例如「下周五 18:00」。",
                            "也可以检查课表里这门课的星期 / 起止教学周 / 单双周设置。"),
                    referenceAt, referenceLocal, List.of());
        }

        Match first = matches.get(0);
        CourseSchedule schedule = first.schedule();
        OffsetDateTime deadline = first.start();
        String clock = String.format("%02d:%02d", schedule.getStartTime().getHour(), schedule.getStartTime().getMinute());
        String note = "课前完成：按开课时间作为截止边界，助手不会提前扣分钟。";
        if (matches.size() > 1) {
            Match second = matches.get(1);
            note += "该窗口内还有 " + (matches.size() - 1) + " 节更晚的课（下一节 "
                    + second.date() + " " + second.schedule().getStartTime() + "），按「课前」取最早的一节。";
        }
        String reason = "“" + phrase + "” → " + course.getName() + " " + first.date()
                + "（" + TimePhraseParser.weekdayLabel(first.date()) + "）" + clock + " 上课前（北京时间 +08:00）";
        ResolveTimeResponse.Candidate candidate = new ResolveTimeResponse.Candidate(
                deadline.format(ISO_OFFSET),
                reason,
                "COURSE_BOUNDARY",
                false,
                true,
                course.getId(),
                course.getName(),
                schedule.getId(),
                first.date().toString(),
                clock,
                Enums.weekdayLabel(schedule.getWeekday()),
                schedule.getLocation(),
                note);
        String message = "已按课表匹配到「" + course.getName() + "」的下一节：" + first.date()
                + " " + TimePhraseParser.weekdayLabel(first.date()) + " " + clock + "。";
        return build(ResolveTimeResponse.STATUS_RESOLVED, message, List.of(), referenceAt, referenceLocal,
                List.of(candidate));
    }

    /** 在窗口内按真实课表找"参考时间之后开始"的课，按开始时间升序，同一时刻去重。 */
    private List<Match> collectMatches(List<CourseSchedule> schedules, TimePhraseParser.Window window,
            OffsetDateTime referenceAt) {
        LocalDate start = window.start();
        LocalDate end = window.endExclusive();
        if (ChronoUnit.DAYS.between(start, end) > MAX_LOOKAHEAD_DAYS) {
            end = start.plusDays(MAX_LOOKAHEAD_DAYS);
        }
        List<Match> matches = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (LocalDate date = start; date.isBefore(end); date = date.plusDays(1)) {
            for (CourseSchedule schedule : schedules) {
                if (!ScheduleRules.occursOn(schedule, date)) {
                    continue;
                }
                OffsetDateTime classStart = ZonedDateTime.of(date, schedule.getStartTime(), SHANGHAI)
                        .toOffsetDateTime();
                // 参考时间之后才开始的课才算"下一次"：正在上的那节不算
                if (!classStart.toInstant().isAfter(referenceAt.toInstant())) {
                    continue;
                }
                String key = date + "T" + schedule.getStartTime();
                if (!seen.add(key)) {
                    continue;
                }
                matches.add(new Match(schedule, date, classStart));
            }
        }
        matches.sort(Comparator.comparing(Match::start));
        return matches;
    }

    private String explainNoMatch(Course course, TimePhraseParser.Window window) {
        String range = window.start() + " ~ " + window.endExclusive().minusDays(1);
        return switch (window.scope()) {
            case DAY -> "「" + window.phrase() + "」对应 " + window.start() + "（"
                    + TimePhraseParser.weekdayLabel(window.start()) + "），但课表里「" + course.getName()
                    + "」当天没有课（已按学期起点 / 起止教学周 / 单双周过滤，正在上的课不算下一次）。";
            case WEEK -> "「" + window.phrase() + "」限定的时间窗口（" + range + "）里没有「" + course.getName()
                    + "」的课：助手不会越周到更远的周去找。";
            case NEXT -> "从参考时间起最多 " + MAX_LOOKAHEAD_DAYS + " 天（" + range + "）内都没有「" + course.getName()
                    + "」的课（已按学期起点 / 起止教学周 / 单双周过滤）。";
        };
    }

    /** 文字里是否提到了**另一门**已有课程（名称或代码完全一致）；提到就要求用户先澄清。 */
    private String findMentionedOtherCourse(String text, Course selected) {
        String normalized = text == null ? "" : text.replace(" ", "");
        List<String> others = new ArrayList<>();
        for (Course course : courseRepository.findAll()) {
            if (course.getId().equals(selected.getId())) {
                continue;
            }
            for (String key : List.of(course.getName() == null ? "" : course.getName(),
                    course.getCode() == null ? "" : course.getCode())) {
                String candidate = key.replace(" ", "");
                if (candidate.length() >= 2 && normalized.contains(candidate)) {
                    others.add(course.getName());
                    break;
                }
            }
        }
        return others.isEmpty() ? null : String.join("、", others);
    }

    // ------------------------------------------------------------------ 参考时间与响应

    /** 参考时间必须带明确偏移量，否则"今天"可能被算到另一个自然日。 */
    static OffsetDateTime parseReferenceAt(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            throw new InvalidRequestException("referenceAt", "参考时间不能为空");
        }
        if (!value.matches(".*(?:[zZ]|[+-]\\d{2}:?\\d{2})$")) {
            throw new InvalidRequestException("referenceAt",
                    "参考时间必须带时区偏移量（例如 2026-10-10T12:00:00+08:00）");
        }
        try {
            OffsetDateTime parsed = OffsetDateTime.parse(value);
            int year = parsed.atZoneSameInstant(SHANGHAI).getYear();
            if (year < MIN_YEAR || year > MAX_YEAR) {
                throw new InvalidRequestException("referenceAt",
                        "参考时间超出支持范围（" + MIN_YEAR + "–" + MAX_YEAR + " 年）：请换一个合理的参考时间。");
            }
            return parsed;
        } catch (DateTimeParseException ex) {
            throw new InvalidRequestException("referenceAt", "参考时间格式非法：" + value);
        }
    }

    private ResolveTimeResponse build(String status, String message, List<String> hints, OffsetDateTime referenceAt,
            String referenceLocal, List<ResolveTimeResponse.Candidate> candidates) {
        return new ResolveTimeResponse(
                status,
                message,
                hints == null ? List.of() : List.copyOf(hints),
                referenceAt.atZoneSameInstant(SHANGHAI).toOffsetDateTime().format(ISO_OFFSET),
                referenceLocal,
                SHANGHAI.getId(),
                candidates == null ? List.of() : List.copyOf(candidates));
    }

    private record Match(CourseSchedule schedule, LocalDate date, OffsetDateTime start) {
    }
}
