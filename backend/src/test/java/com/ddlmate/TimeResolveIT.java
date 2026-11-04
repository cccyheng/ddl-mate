package com.ddlmate;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * V1.2 时间助手接口：{@code POST /api/tasks/resolve-time}。
 *
 * <p>覆盖：固定参考时间下的相对日期 / 时区换算、缺偏移量的 400、缺课程与不存在课程、
 * 真实课表匹配（教学周 / 单双周 / 学期终止 / 正在上的课不算下一次 / 下周不越周）、
 * 多节取最早与同一时刻去重，以及「只读不写库」。</p>
 */
class TimeResolveIT extends BaseIntegrationTest {

    private static final String REF_SATURDAY = "2026-10-10T12:00:00+08:00";
    private static final String SEMESTER_START = "2026-09-07";

    private static String body(String text, String referenceAt, Long courseId) {
        return """
                {"text":"%s","referenceAt":"%s","courseId":%s}
                """.formatted(text, referenceAt, courseId == null ? "null" : courseId);
    }

    private long createCourse(String code, String name) throws Exception {
        return ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                        ApiTestSupport.course(code, name)))
                .andExpect(status().isCreated()).andReturn());
    }

    private void createSchedule(long courseId, String json) throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId), json))
                .andExpect(status().isCreated());
    }

    private org.springframework.test.web.servlet.ResultActions resolve(String text, String referenceAt, Long courseId)
            throws Exception {
        return mvc.perform(ApiTestSupport.json(post("/api/tasks/resolve-time"), body(text, referenceAt, courseId)))
                .andExpect(status().isOk());
    }

    // ------------------------------------------------------------------ 基本解析与只读

    @Test
    @DisplayName("明天 22:00 + 明确偏移量 → 候选带 +08:00 的 deadline，且不写库")
    void resolvesRelativePhrase() throws Exception {
        // 先建一门课与一条课表，用来证明解析过程不会碰任何数据
        long courseId = createCourse("CS201", "数据结构");
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(5, "08:00", "09:40", "教三 305",
                "ALL", SEMESTER_START, 1, 16));

        resolve("明天 22:00", REF_SATURDAY, null)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.timeZone").value("Asia/Shanghai"))
                .andExpect(jsonPath("$.referenceAt").value("2026-10-10T12:00:00+08:00"))
                .andExpect(jsonPath("$.referenceLocal").value("2026-10-10 12:00 周六"))
                .andExpect(jsonPath("$.candidates.length()").value(1))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-11T22:00:00+08:00"))
                .andExpect(jsonPath("$.candidates[0].past").value(false))
                .andExpect(jsonPath("$.candidates[0].courseBoundary").value(false))
                .andExpect(jsonPath("$.candidates[0].reason").value(containsString("北京时间")));

        // 只读：任务仍是 0，课程与课表数量不变
        org.assertj.core.api.Assertions.assertThat(taskRepository.count()).isZero();
        org.assertj.core.api.Assertions.assertThat(courseRepository.count()).isEqualTo(1);
        org.assertj.core.api.Assertions.assertThat(scheduleRepository.count()).isEqualTo(1);
    }

    @Test
    @DisplayName("参考时间带别的偏移量时，先换算成上海自然日再算「今天 / 明天」")
    void convertsReferenceOffsetToShanghaiDay() throws Exception {
        // 2026-10-09T20:00-04:00 = 2026-10-10T00:00Z = 上海 2026-10-10 08:00
        resolve("今天 22:00", "2026-10-09T20:00:00-04:00", null)
                .andExpect(jsonPath("$.referenceAt").value("2026-10-10T08:00:00+08:00"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-10T22:00:00+08:00"));
        // UTC 参考时间同理
        resolve("明天 09:00", "2026-10-09T16:30:00Z", null)
                .andExpect(jsonPath("$.referenceLocal").value("2026-10-10 00:30 周六"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-11T09:00:00+08:00"));
    }

    @Test
    @DisplayName("过去的明确日期给出候选并标 past，绝不偷偷滚到下一周")
    void pastExplicitDateIsKeptWithFlag() throws Exception {
        resolve("2026-10-08 10:00", REF_SATURDAY, null)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-08T10:00:00+08:00"))
                .andExpect(jsonPath("$.candidates[0].past").value(true))
                .andExpect(jsonPath("$.hints").value(org.hamcrest.Matchers.hasItem(containsString("参考时间之前"))));
        resolve("周五 18:00", REF_SATURDAY, null)
                .andExpect(jsonPath("$.status").value("NEEDS_INFO"))
                .andExpect(jsonPath("$.candidates.length()").value(0));
    }

    @Test
    @DisplayName("需补信息 / 保守拒绝 / 重复时间：状态区分清楚且没有候选")
    void needsInfoAndUnsupported() throws Exception {
        resolve("今晚", REF_SATURDAY, null)
                .andExpect(jsonPath("$.status").value("NEEDS_INFO"))
                .andExpect(jsonPath("$.candidates.length()").value(0))
                .andExpect(jsonPath("$.message").value(containsString("没有具体时刻")));
        resolve("取消明天的作业", REF_SATURDAY, null)
                .andExpect(jsonPath("$.status").value("UNSUPPORTED"))
                .andExpect(jsonPath("$.candidates.length()").value(0));
        resolve("明天 10:00，后天 12:00", REF_SATURDAY, null)
                .andExpect(jsonPath("$.status").value("NEEDS_INFO"))
                .andExpect(jsonPath("$.message").value(containsString("多个日期")));
    }

    // ------------------------------------------------------------------ 请求校验

    @Test
    @DisplayName("参考时间必须带偏移量：不带 → 400 且给出可读提示")
    void referenceWithoutOffsetRejected() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/tasks/resolve-time"),
                        body("明天 22:00", "2026-10-10T12:00:00", null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"))
                .andExpect(jsonPath("$.message").value(containsString("偏移量")));
        mvc.perform(ApiTestSupport.json(post("/api/tasks/resolve-time"),
                        body("明天 22:00", "不是时间", null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
    }

    @Test
    @DisplayName("text 为空 / 超过 500 字 → 400 校验失败")
    void textValidation() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/tasks/resolve-time"), body("", REF_SATURDAY, null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
        mvc.perform(ApiTestSupport.json(post("/api/tasks/resolve-time"),
                        body("啊".repeat(501), REF_SATURDAY, null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    // ------------------------------------------------------------------ 课程边界

    @Test
    @DisplayName("下周五上课前：按真实课表给出上课开始边界，不做提前扣减")
    void matchesNextClassOnGivenDay() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(5, "08:00", "09:40", "教三 305",
                "ALL", SEMESTER_START, 1, 16));

        resolve("下周五上课前", REF_SATURDAY, courseId)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.candidates.length()").value(1))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-16T08:00:00+08:00"))
                .andExpect(jsonPath("$.candidates[0].kind").value("COURSE_BOUNDARY"))
                .andExpect(jsonPath("$.candidates[0].courseName").value("数据结构"))
                .andExpect(jsonPath("$.candidates[0].scheduleDate").value("2026-10-16"))
                .andExpect(jsonPath("$.candidates[0].scheduleStartTime").value("08:00"))
                .andExpect(jsonPath("$.candidates[0].scheduleWeekday").value("周五"))
                .andExpect(jsonPath("$.candidates[0].scheduleLocation").value("教三 305"))
                .andExpect(jsonPath("$.candidates[0].note").value(containsString("按开课时间作为截止边界")));
    }

    @Test
    @DisplayName("正在上的那节课不算下一次：参考时间在课中时，下一次是下一周同一节")
    void inProgressClassIsNotNext() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(5, "08:00", "09:40", "教三 305",
                "ALL", SEMESTER_START, 1, 16));

        resolve("下节课前", "2026-10-16T08:30:00+08:00", courseId)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-23T08:00:00+08:00"));
    }

    @Test
    @DisplayName("旧课表（没有教学周信息）按每周处理")
    void legacyScheduleTreatedWeekly() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        createSchedule(courseId, ApiTestSupport.schedule(5, "08:00", "09:40", null));

        resolve("下周五上课前", REF_SATURDAY, courseId)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-16T08:00:00+08:00"));
    }

    @Test
    @DisplayName("单双周 + 起止教学周生效：单周课在偶数教学周的下周没有匹配")
    void oddPatternAndSemesterEndRespected() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        // 周一单周，第 1-16 周
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", null,
                "ODD", SEMESTER_START, 1, 16));

        // 参考时间 2026-10-10 在第 5 周；「下周」是第 6 周（偶数）→ 单周课不上
        resolve("下周这门课前", REF_SATURDAY, courseId)
                .andExpect(jsonPath("$.status").value("NO_COURSE_MATCH"))
                .andExpect(jsonPath("$.candidates.length()").value(0))
                .andExpect(jsonPath("$.message").value(containsString("不会越周")));

        // 换到第 4 周的参考时间（2026-10-03 周六）：「下周」是第 5 周（奇数）→ 命中
        resolve("下周这门课前", "2026-10-03T12:00:00+08:00", courseId)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-05T08:00:00+08:00"));

        // 学期终止：第 1-2 周结束之后再问「下节课前」→ 未来 366 天都没有课
        long endedCourse = createCourse("CS202", "数据结构实验");
        createSchedule(endedCourse, ApiTestSupport.scheduleWithWeeks(5, "08:00", "09:40", null,
                "ALL", SEMESTER_START, 1, 2));
        resolve("下节课前", REF_SATURDAY, endedCourse)
                .andExpect(jsonPath("$.status").value("NO_COURSE_MATCH"))
                .andExpect(jsonPath("$.message").value(containsString("366")));
    }

    @Test
    @DisplayName("下周严格是下一个自然周，没有课不越周；限定日与整周窗口结果不同")
    void nextWeekWindowDoesNotCrossWeeks() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        // 只有周三的课（第 1-16 周，每周）
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(3, "10:00", "11:40", null,
                "ALL", SEMESTER_START, 1, 16));

        // 下周的周五没有课 → 不越周去找
        resolve("下周五上课前", REF_SATURDAY, courseId)
                .andExpect(jsonPath("$.status").value("NO_COURSE_MATCH"))
                .andExpect(jsonPath("$.message").value(containsString("当天没有课")));
        // 下周整周里有周三的课 → 命中
        resolve("下周这门课前", REF_SATURDAY, courseId)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-14T10:00:00+08:00"));
    }

    @Test
    @DisplayName("一个窗口内多节取最早，并在 note 里说明；同一时刻重复课表去重")
    void earliestClassChosenAndDuplicatesDeduped() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(5, "08:00", "09:40", null,
                "ALL", SEMESTER_START, 1, 16));
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(5, "14:00", "15:40", null,
                "ALL", SEMESTER_START, 1, 16));
        // 与第一条完全相同的课表：服务层按「日期 + 开始时间」去重，不能给出重复候选
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(5, "08:00", "09:40", null,
                "ALL", SEMESTER_START, 1, 16));

        resolve("下周五上课前", REF_SATURDAY, courseId)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.candidates.length()").value(1))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-16T08:00:00+08:00"))
                .andExpect(jsonPath("$.candidates[0].note").value(containsString("取最早的一节")));
    }

    @Test
    @DisplayName("缺课程 / 不存在课程 / 文字提到另一门课：分别给出可读结果")
    void courseSelectionGuards() throws Exception {
        long mathId = createCourse("MA101", "高等数学");
        long csId = createCourse("CS201", "数据结构");
        createSchedule(csId, ApiTestSupport.scheduleWithWeeks(5, "08:00", "09:40", null,
                "ALL", SEMESTER_START, 1, 16));

        // 缺课程 → 需补信息（不是 500、也不是静默按某门课算）
        resolve("下节课前", REF_SATURDAY, null)
                .andExpect(jsonPath("$.status").value("NEEDS_INFO"))
                .andExpect(jsonPath("$.message").value(containsString("需要先明确选择课程")));

        // 不存在的课程 → 404
        mvc.perform(ApiTestSupport.json(post("/api/tasks/resolve-time"), body("下节课前", REF_SATURDAY, 999999L)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));

        // 文字里提到了另一门课：不能忽略后缀、直接按当前选择的课程算
        resolve("数据结构下周这门课前", REF_SATURDAY, mathId)
                .andExpect(jsonPath("$.status").value("NEEDS_INFO"))
                .andExpect(jsonPath("$.message").value(containsString("数据结构")));
    }

    @Test
    @DisplayName("没有课表的课程：明确解释，不硬凑")
    void courseWithoutSchedules() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        resolve("下节课前", REF_SATURDAY, courseId)
                .andExpect(jsonPath("$.status").value("NO_COURSE_MATCH"))
                .andExpect(jsonPath("$.message").value(containsString("还没有课表")));
    }

    @Test
    @DisplayName("未来 366 天内都没有课：给出解释而不是空结果")
    void noClassWithinLookahead() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        // 学期第 1-2 周（都已在参考时间之前）
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(5, "08:00", "09:40", null,
                "ALL", SEMESTER_START, 1, 2));
        resolve("下节课前", REF_SATURDAY, courseId)
                .andExpect(jsonPath("$.status").value("NO_COURSE_MATCH"))
                .andExpect(jsonPath("$.message").value(containsString("366")));
    }

    @Test
    @DisplayName("Codex Round 1 反例在接口层同样被保守拒绝（没有候选）")
    void codexRound1CounterexamplesRejected() throws Exception {
        for (String text : new String[] {
                "下下周五18:00", "明天18:000", "明天123:00", "下节课前或下周五上课前",
                "下周五上课前或下周一上课前", "下节课前两小时", "明天18:00之后", "明天18点开始",
                "下次数学课前", "下次实验课前", "下周实验课前" }) {
            resolve(text, REF_SATURDAY, null)
                    .andExpect(jsonPath("$.status").value("NEEDS_INFO"))
                    .andExpect(jsonPath("$.candidates.length()").value(0));
        }
        // 正常短语不受影响
        resolve("明天18:00", REF_SATURDAY, null)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-11T18:00:00+08:00"));
    }

    @Test
    @DisplayName("参考时间极端年份 → 400（不是 500），固定时区契约不随环境变量改变")
    void referenceYearOutOfRange() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/tasks/resolve-time"),
                        body("明天 22:00", "9999-12-31T23:59:00+08:00", null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"))
                .andExpect(jsonPath("$.message").value(containsString("超出支持范围")));
        mvc.perform(ApiTestSupport.json(post("/api/tasks/resolve-time"),
                        body("明天 22:00", "12026-10-10T12:00:00+08:00", null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
        // 契约：固定 Asia/Shanghai，deadline 一律 +08:00
        resolve("明天 22:00", "2026-10-10T04:00:00Z", null)
                .andExpect(jsonPath("$.timeZone").value("Asia/Shanghai"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-11T22:00:00+08:00"));
    }

    @Test
    @DisplayName("验收计划实例：单周 08:00 / 双周 10:00 的周一课，正在上的课不算下一次")
    void acceptancePlanOddEvenLookup() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", null,
                "ODD", SEMESTER_START, 1, 16));
        createSchedule(courseId, ApiTestSupport.scheduleWithWeeks(1, "10:00", "11:40", null,
                "EVEN", SEMESTER_START, 1, 16));

        // 2026-10-09（周五，第 5 周）查下节课前 → 第 6 周 10/12 周一 10:00（双周）
        resolve("下节课前", "2026-10-09T12:00:00+08:00", courseId)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-12T10:00:00+08:00"))
                .andExpect(jsonPath("$.candidates[0].scheduleDate").value("2026-10-12"));
        // 2026-10-12T10:00 正好在上课边界上（已开始）→ 取第 7 周 10/19 周一 08:00（单周）
        resolve("下节课前", "2026-10-12T10:00:00+08:00", courseId)
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.candidates[0].deadline").value("2026-10-19T08:00:00+08:00"));
    }
}
