package com.ddlmate.service;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.ResourceInUseException;
import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.Course;
import com.ddlmate.domain.CourseSchedule;
import com.ddlmate.domain.WeekPattern;
import com.ddlmate.repository.CourseRepository;
import com.ddlmate.repository.CourseScheduleRepository;
import com.ddlmate.web.dto.CourseScheduleRequest;
import com.ddlmate.web.dto.CourseScheduleResponse;
import com.ddlmate.web.dto.ScheduleImportRequest;
import com.ddlmate.web.dto.ScheduleImportResponse;

@Service
public class ScheduleService {

    private final CourseScheduleRepository repository;

    private final CourseRepository courseRepository;

    private final QuotaService quotaService;

    public ScheduleService(CourseScheduleRepository repository, CourseRepository courseRepository,
            QuotaService quotaService) {
        this.quotaService = quotaService;
        this.repository = repository;
        this.courseRepository = courseRepository;
    }

    // ------------------------------------------------------------------ 查询

    @Transactional(readOnly = true)
    public List<CourseScheduleResponse> listByCourse(Long courseId) {
        requireCourse(courseId);
        return toResponses(repository.findByCourseIdOrdered(courseId));
    }

    /**
     * 课表列表。
     *
     * @param weekday 可选，按星期过滤（1=周一 … 7=周日）
     * @param date    可选，按"该日期是否上课"过滤（含教学周与单双周规则）
     */
    @Transactional(readOnly = true)
    public List<CourseScheduleResponse> list(Integer weekday, LocalDate date) {
        if (weekday != null && (weekday < 1 || weekday > 7)) {
            throw new InvalidRequestException("weekday", "星期取值范围是 1（周一）到 7（周日）");
        }
        List<CourseSchedule> schedules = weekday == null
                ? repository.findAllOrdered()
                : repository.findByWeekdayOrdered(weekday);
        if (date != null) {
            schedules = schedules.stream().filter(schedule -> ScheduleRules.occursOn(schedule, date)).toList();
        }
        return toResponses(schedules);
    }

    /** 指定日期实际要上的课（教学周 + 单双周规则生效），按开始时间排序。 */
    @Transactional(readOnly = true)
    public List<CourseScheduleResponse> occurringOn(LocalDate date) {
        if (date == null) {
            throw new InvalidRequestException("date", "日期不能为空");
        }
        List<CourseSchedule> hit = repository.findAllOrdered().stream()
                .filter(schedule -> ScheduleRules.occursOn(schedule, date))
                .toList();
        return toResponses(hit);
    }

    /** 今日课程（按业务时区取"今天"）。 */
    @Transactional(readOnly = true)
    public List<CourseScheduleResponse> today() {
        return occurringOn(LocalDate.now(TimeZones.zone()));
    }

    /**
     * 一个日期区间内每天实际要上的课（月历用）。只查一次课表，再按规则逐日过滤，避免逐日查库。
     *
     * @param from        起始日期（含）
     * @param toExclusive 结束日期（不含）
     */
    @Transactional(readOnly = true)
    public Map<LocalDate, List<CourseScheduleResponse>> occurrencesInRange(LocalDate from, LocalDate toExclusive) {
        List<CourseSchedule> all = repository.findAllOrdered();
        Map<LocalDate, List<CourseScheduleResponse>> result = new LinkedHashMap<>();
        for (LocalDate date = from; date.isBefore(toExclusive); date = date.plusDays(1)) {
            List<CourseScheduleResponse> hit = new ArrayList<>();
            for (CourseSchedule schedule : all) {
                if (ScheduleRules.occursOn(schedule, date)) {
                    hit.add(ApiMapper.schedule(schedule));
                }
            }
            if (!hit.isEmpty()) {
                result.put(date, hit);
            }
        }
        return result;
    }

    // ------------------------------------------------------------------ 单条写入

    @Transactional
    public CourseScheduleResponse create(Long courseId, CourseScheduleRequest request) {
        Course course = requireCourse(courseId);
        WeekSettings settings = validate(request);
        CourseSchedule schedule = new CourseSchedule(course, request.weekday(), request.startTime(), request.endTime());
        apply(schedule, request, settings);
        return ApiMapper.schedule(repository.save(schedule));
    }

    @Transactional
    public CourseScheduleResponse update(Long courseId, Long scheduleId, CourseScheduleRequest request) {
        requireCourse(courseId);
        CourseSchedule schedule = repository.findById(scheduleId)
                .orElseThrow(() -> new ResourceNotFoundException("课表", scheduleId));
        if (schedule.getCourse() == null || !schedule.getCourse().getId().equals(courseId)) {
            throw new ResourceNotFoundException("该课程下的课表", scheduleId);
        }
        WeekSettings settings = validate(request);
        schedule.setWeekday(request.weekday());
        schedule.setStartTime(request.startTime());
        schedule.setEndTime(request.endTime());
        apply(schedule, request, settings);
        return ApiMapper.schedule(repository.save(schedule));
    }

    @Transactional
    public void delete(Long courseId, Long scheduleId) {
        requireCourse(courseId);
        CourseSchedule schedule = repository.findById(scheduleId)
                .orElseThrow(() -> new ResourceNotFoundException("课表", scheduleId));
        if (schedule.getCourse() == null || !schedule.getCourse().getId().equals(courseId)) {
            throw new ResourceNotFoundException("该课程下的课表", scheduleId);
        }
        repository.delete(schedule);
    }

    // ------------------------------------------------------------------ 批量导入

    /**
     * 批量导入课表：新建课程 + 课表在**同一个事务**内完成。
     *
     * <p>流程：先逐行做与单条入口完全相同的校验（含枚举、教学周、时间、节次），再只创建"被引用"的新课程，
     * 最后逐行判定"完全相同 → 跳过"或"真实冲突 → 报错"。任何异常都会让整个事务回滚，不留部分数据。</p>
     */
    @Transactional
    public ScheduleImportResponse importBatch(ScheduleImportRequest request) {
        List<ScheduleImportRequest.ImportCourse> newCourses = request.courses() == null ? List.of()
                : request.courses();
        List<ScheduleImportRequest.ImportSchedule> rows = request.schedules();
        quotaService.checkNewCourses(newCourses.size());

        // ---------- 第 1 步：逐行校验（不写库），记录哪些新课程真的被引用 ----------
        List<PreparedRow> prepared = new ArrayList<>();
        Set<String> usedRefs = new LinkedHashSet<>();
        Set<String> requestFingerprints = new LinkedHashSet<>();
        for (ScheduleImportRequest.ImportSchedule row : rows) {
            if (row == null) {
                throw new InvalidRequestException("schedules", "课表列表里存在空项，请检查导入内容");
            }
            boolean hasId = row.courseId() != null;
            boolean hasRef = row.courseRef() != null && !row.courseRef().isBlank();
            if (hasId == hasRef) {
                throw new InvalidRequestException("courseId",
                        "每条课表必须且只能指定已有课程（courseId）或本次新建课程（courseRef）之一");
            }
            String ref = hasRef ? row.courseRef().trim() : null;
            CourseScheduleRequest normalized = new CourseScheduleRequest(row.weekday(), row.startTime(),
                    row.endTime(), row.location(), row.periodStart(), row.periodEnd(), row.weekRange(),
                    row.semesterStartDate(), row.startWeek(), row.endWeek(), row.weekPattern());
            WeekSettings settings = validate(normalized);
            if (ref != null) {
                usedRefs.add(ref);
            }
            String fingerprint = fingerprint(row.courseId(), ref, normalized, settings);
            if (!requestFingerprints.add(fingerprint)) {
                throw new InvalidRequestException("schedules",
                        "导入内容里存在完全相同的课表（同一门课、同一时间、同样的周次与地点）："
                                + Enums.weekdayLabel(row.weekday()) + " " + row.startTime());
            }
            prepared.add(new PreparedRow(row, normalized, settings, ref, row.courseId()));
        }

        // ---------- 第 2 步：只创建被引用的新课程 ----------
        Map<String, Course> refToCourse = new HashMap<>();
        Set<String> requestCodes = new HashSet<>();
        List<String> notices = new ArrayList<>();
        for (ScheduleImportRequest.ImportCourse item : newCourses) {
            if (item == null) {
                throw new InvalidRequestException("courses", "课程列表里存在空项，请检查导入内容");
            }
            String ref = item.ref().trim();
            if (!usedRefs.contains(ref)) {
                notices.add("已忽略没有被任何课表引用的新课程：" + item.name().trim() + "（" + ref + "）");
                continue;
            }
            String code = item.code().trim();
            if (refToCourse.containsKey(ref)) {
                throw new InvalidRequestException("courses", "导入内容里课程标识重复：" + ref);
            }
            if (!requestCodes.add(code.toLowerCase())) {
                throw new InvalidRequestException("courses", "导入内容里课程代码重复：" + code);
            }
            if (courseRepository.existsByCodeIgnoreCase(code)) {
                throw new ResourceInUseException("课程代码已存在，请改用已有课程或换一个代码：" + code);
            }
            Course course = new Course(code, item.name().trim());
            course.setInstructor(blankToNull(item.instructor()));
            course.setSemester(blankToNull(item.semester()));
            course.setColor(blankToNull(item.color()));
            refToCourse.put(ref, courseRepository.save(course));
        }
        for (String ref : usedRefs) {
            if (!refToCourse.containsKey(ref)) {
                throw new InvalidRequestException("courseRef", "找不到本次导入中的课程标识：" + ref);
            }
        }

        // ---------- 第 3 步：解析课程，跳过完全重复，拒绝真实冲突 ----------
        List<CourseSchedule> pending = new ArrayList<>();
        List<PreparedRow> accepted = new ArrayList<>();
        int skipped = 0;
        for (PreparedRow item : prepared) {
            Course course = item.courseId() != null
                    ? requireCourse(item.courseId())
                    : refToCourse.get(item.ref());

            Set<String> existingFingerprints = new HashSet<>();
            for (CourseSchedule existing : repository.findByCourseIdOrdered(course.getId())) {
                existingFingerprints.add(fingerprint(existing));
            }
            String fingerprint = fingerprint(item.courseId(), item.ref(), item.request(), item.settings());
            if (existingFingerprints.contains(fingerprint)) {
                skipped++;
                notices.add(String.format("已跳过重复课表：%s %s %s（数据库中已存在相同记录）",
                        course.getName(), Enums.weekdayLabel(item.row().weekday()), item.row().startTime()));
                continue;
            }
            CourseSchedule conflict = findConflict(course, item);
            if (conflict != null) {
                throw new ResourceInUseException(String.format(
                        "课表冲突：%s %s %s-%s 与已有安排（%s %s-%s%s）同一天时间重叠且周次无法共存，"
                                + "请修改时间/周次，或先编辑已有课表",
                        course.getName(), Enums.weekdayLabel(item.row().weekday()), item.row().startTime(),
                        item.row().endTime(), Enums.weekdayLabel(conflict.getWeekday()), conflict.getStartTime(),
                        conflict.getEndTime(),
                        conflict.getLocation() == null ? "" : " " + conflict.getLocation()));
            }
            PreparedRow requestConflict = findRequestConflict(accepted, course, item);
            if (requestConflict != null) {
                throw new ResourceInUseException(String.format(
                        "本次导入内容自相冲突：%s %s %s-%s 与同一批里的 %s-%s 时间重叠且周次无法共存",
                        course.getName(), Enums.weekdayLabel(item.row().weekday()), item.row().startTime(),
                        item.row().endTime(), requestConflict.row().startTime(), requestConflict.row().endTime()));
            }

            CourseSchedule schedule = new CourseSchedule(course, item.row().weekday(), item.row().startTime(),
                    item.row().endTime());
            apply(schedule, item.request(), item.settings());
            pending.add(schedule);
            accepted.add(item);
        }

        List<CourseSchedule> saved = repository.saveAll(pending);
        repository.flush();

        List<CourseScheduleResponse> responses = new ArrayList<>(saved.size());
        for (CourseSchedule schedule : saved) {
            responses.add(ApiMapper.schedule(schedule));
        }
        if (skipped > 0) {
            notices.add("共跳过 " + skipped + " 条与已有课表完全相同的记录（重复提交不会产生重复数据）");
        }
        return new ScheduleImportResponse(refToCourse.size(), responses.size(), skipped, responses, notices);
    }

    // ------------------------------------------------------------------ 校验

    /**
     * 校验单条课表请求并解析教学周设置。
     * 单条新增/编辑与批量导入都走这里，保证两个入口规则完全一致。
     */
    private WeekSettings validate(CourseScheduleRequest request) {
        if (request == null) {
            throw new InvalidRequestException("request", "课表内容不能为空");
        }
        if (request.weekday() == null) {
            throw new InvalidRequestException("weekday", "星期不能为空");
        }
        if (request.weekday() < 1 || request.weekday() > 7) {
            throw new InvalidRequestException("weekday", "星期取值范围是 1（周一）到 7（周日）");
        }
        if (request.startTime() == null || request.endTime() == null) {
            throw new InvalidRequestException("startTime/endTime", "开始时间与结束时间不能为空");
        }
        if (!request.startTime().isBefore(request.endTime())) {
            throw new InvalidRequestException("startTime",
                    "开始时间必须早于结束时间，实际：" + request.startTime() + " → " + request.endTime());
        }
        if (request.periodStart() != null && (request.periodStart() < 1 || request.periodStart() > 12)) {
            throw new InvalidRequestException("periodStart", "起始节次取值范围是 1-12");
        }
        if (request.periodEnd() != null && (request.periodEnd() < 1 || request.periodEnd() > 12)) {
            throw new InvalidRequestException("periodEnd", "结束节次取值范围是 1-12");
        }
        if (request.periodStart() != null && request.periodEnd() != null
                && request.periodStart() > request.periodEnd()) {
            throw new InvalidRequestException("periodStart", "起始节次不能大于结束节次");
        }

        WeekPattern pattern;
        try {
            pattern = WeekPattern.fromNullable(request.weekPattern());
        } catch (IllegalArgumentException ex) {
            throw new InvalidRequestException("weekPattern", ex.getMessage());
        }

        LocalDate semesterStart = request.semesterStartDate();
        Integer startWeek = request.startWeek();
        Integer endWeek = request.endWeek();

        if ((startWeek == null) != (endWeek == null)) {
            throw new InvalidRequestException("startWeek", "起始周与结束周必须同时填写");
        }
        if (semesterStart != null && !ScheduleRules.isMonday(semesterStart)) {
            throw new InvalidRequestException("semesterStartDate",
                    "学期第一周周一必须是周一，实际是：" + semesterStart + "（" + semesterStart.getDayOfWeek() + "）");
        }
        if (semesterStart != null && startWeek == null) {
            throw new InvalidRequestException("startWeek", "填写了学期第一周周一，还需要填写起止教学周");
        }
        if (startWeek != null) {
            if (semesterStart == null) {
                throw new InvalidRequestException("semesterStartDate",
                        "设置了教学周范围时，必须填写学期第一周周一（用于判断教学周与单双周）");
            }
            if (startWeek < 1 || endWeek > 53 || startWeek > endWeek) {
                throw new InvalidRequestException("startWeek",
                        "教学周范围非法：" + startWeek + "-" + endWeek + "（要求 1 ≤ 起始周 ≤ 结束周 ≤ 53）");
            }
        }
        if (pattern != WeekPattern.ALL) {
            if (semesterStart == null) {
                throw new InvalidRequestException("weekPattern",
                        pattern.getLabel() + "需要先填写学期第一周周一（教学周起点）");
            }
            if (startWeek == null) {
                throw new InvalidRequestException("startWeek",
                        pattern.getLabel() + "需要填写起止教学周，否则无法判断哪些周上课");
            }
        }
        return new WeekSettings(pattern, semesterStart, startWeek, endWeek);
    }

    private void apply(CourseSchedule schedule, CourseScheduleRequest request, WeekSettings settings) {
        schedule.setLocation(blankToNull(request.location()));
        schedule.setPeriodStart(request.periodStart());
        schedule.setPeriodEnd(request.periodEnd());
        schedule.setWeekRange(blankToNull(request.weekRange()));
        schedule.setSemesterStartDate(settings.semesterStartDate());
        schedule.setStartWeek(settings.startWeek());
        schedule.setEndWeek(settings.endWeek());
        schedule.setWeekPattern(settings.pattern());
    }

    // ------------------------------------------------------------------ 重复与冲突判定

    /** 影响"是否同一条课表"的全部字段指纹。 */
    private String fingerprint(Long courseId, String ref, CourseScheduleRequest request, WeekSettings settings) {
        return String.join("|",
                courseId == null ? "ref:" + ref : "id:" + courseId,
                String.valueOf(request.weekday()),
                String.valueOf(request.startTime()),
                String.valueOf(request.endTime()),
                String.valueOf(blankToNull(request.location())),
                String.valueOf(request.periodStart()),
                String.valueOf(request.periodEnd()),
                String.valueOf(blankToNull(request.weekRange())),
                String.valueOf(settings.semesterStartDate()),
                String.valueOf(settings.startWeek()),
                String.valueOf(settings.endWeek()),
                settings.pattern().name());
    }

    private String fingerprint(CourseSchedule existing) {
        WeekPattern pattern = existing.getWeekPattern() == null ? WeekPattern.ALL : existing.getWeekPattern();
        return String.join("|",
                "id:" + existing.getCourse().getId(),
                String.valueOf(existing.getWeekday()),
                String.valueOf(existing.getStartTime()),
                String.valueOf(existing.getEndTime()),
                String.valueOf(blankToNull(existing.getLocation())),
                String.valueOf(existing.getPeriodStart()),
                String.valueOf(existing.getPeriodEnd()),
                String.valueOf(blankToNull(existing.getWeekRange())),
                String.valueOf(existing.getSemesterStartDate()),
                String.valueOf(existing.getStartWeek()),
                String.valueOf(existing.getEndWeek()),
                pattern.name());
    }

    /** 找出与本次导入行"真正冲突"的已有课表（同一天、时间重叠、周次无法共存）。 */
    private CourseSchedule findConflict(Course course, PreparedRow item) {
        for (CourseSchedule existing : repository.findByCourseIdOrdered(course.getId())) {
            if (!Objects.equals(existing.getWeekday(), item.row().weekday())) {
                continue;
            }
            boolean timeOverlap = item.row().startTime().isBefore(existing.getEndTime())
                    && existing.getStartTime().isBefore(item.row().endTime());
            if (!timeOverlap) {
                continue;
            }
            WeekPattern existingPattern = existing.getWeekPattern() == null ? WeekPattern.ALL : existing.getWeekPattern();
            // 单周 + 双周可以并存（互不重叠），其余情况视为冲突
            if (mutuallyExclusive(existingPattern, item.settings().pattern())) {
                continue;
            }
            if (!weeksOverlap(existing, item.settings())) {
                continue;
            }
            return existing;
        }
        return null;
    }

    private boolean mutuallyExclusive(WeekPattern a, WeekPattern b) {
        return (a == WeekPattern.ODD && b == WeekPattern.EVEN) || (a == WeekPattern.EVEN && b == WeekPattern.ODD);
    }

    /** 同一批导入内部是否自相冲突（同一门课、同一天、时间重叠且周次无法共存）。 */
    private PreparedRow findRequestConflict(List<PreparedRow> accepted, Course course, PreparedRow item) {
        for (PreparedRow other : accepted) {
            boolean sameCourse = item.courseId() != null
                    ? item.courseId().equals(other.courseId())
                    : (other.courseId() == null && Objects.equals(item.ref(), other.ref()));
            if (!sameCourse) {
                continue;
            }
            if (!Objects.equals(other.row().weekday(), item.row().weekday())) {
                continue;
            }
            boolean timeOverlap = item.row().startTime().isBefore(other.row().endTime())
                    && other.row().startTime().isBefore(item.row().endTime());
            if (!timeOverlap) {
                continue;
            }
            if (mutuallyExclusive(other.settings().pattern(), item.settings().pattern())) {
                continue;
            }
            if (!weeksOverlap(other.settings(), item.settings())) {
                continue;
            }
            return other;
        }
        return null;
    }

    private boolean weeksOverlap(WeekSettings a, WeekSettings b) {
        if (a.semesterStartDate() == null || a.startWeek() == null || a.endWeek() == null
                || b.semesterStartDate() == null || b.startWeek() == null || b.endWeek() == null) {
            return true;
        }
        if (!a.semesterStartDate().equals(b.semesterStartDate())) {
            return false;
        }
        return a.startWeek() <= b.endWeek() && b.startWeek() <= a.endWeek();
    }

    /** 两段教学周是否有交集；任一方未配置教学周时视为"每周都上"，与任何周次都有交集。 */
    private boolean weeksOverlap(CourseSchedule existing, WeekSettings settings) {
        if (existing.getSemesterStartDate() == null || existing.getStartWeek() == null || existing.getEndWeek() == null
                || settings.semesterStartDate() == null || settings.startWeek() == null
                || settings.endWeek() == null) {
            return true;
        }
        if (!existing.getSemesterStartDate().equals(settings.semesterStartDate())) {
            // 学期起点不同（例如不同学期）→ 视为不同学期的安排，不判冲突
            return false;
        }
        return existing.getStartWeek() <= settings.endWeek() && settings.startWeek() <= existing.getEndWeek();
    }

    // ------------------------------------------------------------------ 其它

    private String blankToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private Course requireCourse(Long courseId) {
        return courseRepository.findById(courseId)
                .orElseThrow(() -> new ResourceNotFoundException("课程", courseId));
    }

    private List<CourseScheduleResponse> toResponses(List<CourseSchedule> schedules) {
        List<CourseScheduleResponse> result = new ArrayList<>(schedules.size());
        for (CourseSchedule schedule : schedules) {
            result.add(ApiMapper.schedule(schedule));
        }
        return result;
    }

    /** 校验通过后解析出的教学周设置。 */
    private record WeekSettings(WeekPattern pattern, LocalDate semesterStartDate, Integer startWeek, Integer endWeek) {
    }

    /** 批量导入中已通过校验的一行。 */
    private record PreparedRow(
            ScheduleImportRequest.ImportSchedule row,
            CourseScheduleRequest request,
            WeekSettings settings,
            String ref,
            Long courseId) {
    }

    /** 按开始时间排序用的访问器（供其它服务/测试复用）。 */
    static LocalTime startTimeOf(CourseSchedule schedule) {
        return schedule.getStartTime();
    }
}
