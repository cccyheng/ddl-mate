package com.ddlmate;

import static org.hamcrest.Matchers.hasItem;
import static org.hamcrest.Matchers.not;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** 月历接口：课程（按教学周规则）+ 任务 DDL 一起返回。 */
class ScheduleCalendarIT extends BaseIntegrationTest {

    private static final String SEMESTER_START = "2026-09-07";

    @Test
    @DisplayName("按月返回每一天的任务与课程，课程遵守单双周")
    void monthIncludesTasksAndFilteredSchedules() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                        ApiTestSupport.course("CS201", "数据结构")))
                .andExpect(status().isCreated()).andReturn());

        // 周一单周课：9/7（第 1 周）、9/21（第 3 周）上课
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", "教三 305", "ODD", SEMESTER_START, 1, 5)))
                .andExpect(status().isCreated());
        // 周二每周课：9/8、9/15、9/22、9/29 都上
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(2, "10:10", "11:50", "教二 108", "ALL", SEMESTER_START, 1, 5)))
                .andExpect(status().isCreated());
        // 9/9 有一个 DDL
        mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("九月九日作业", courseId, "2026-09-09T23:59:00+08:00", "HOMEWORK", 3, 60)))
                .andExpect(status().isCreated());

        mvc.perform(get("/api/calendar").param("year", "2026").param("month", "9"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.year").value(2026))
                .andExpect(jsonPath("$.month").value(9))
                .andExpect(jsonPath("$.days.length()").value(30))
                .andExpect(jsonPath("$.days[0].date").value("2026-09-01"))
                // 9/7 周一：单周课在
                .andExpect(jsonPath("$.days[6].date").value("2026-09-07"))
                .andExpect(jsonPath("$.days[6].schedules.length()").value(1))
                // 9/8 周二：每周课在
                .andExpect(jsonPath("$.days[7].schedules.length()").value(1))
                // 9/9 有 DDL、没有课
                .andExpect(jsonPath("$.days[8].tasks.length()").value(1))
                .andExpect(jsonPath("$.days[8].tasks[0].title").value("九月九日作业"))
                .andExpect(jsonPath("$.days[8].schedules.length()").value(0))
                // 9/14 周一第 2 周（偶数）→ 单周课不在
                .andExpect(jsonPath("$.days[13].schedules.length()").value(0))
                // 9/21 周一第 3 周 → 单周课在
                .andExpect(jsonPath("$.days[20].schedules.length()").value(1));
    }

    @Test
    @DisplayName("没有课表的月份也能正常返回（每天为空数组）")
    void emptyMonth() throws Exception {
        mvc.perform(get("/api/calendar").param("year", "2026").param("month", "11"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.days.length()").value(30))
                .andExpect(jsonPath("$.days[0].schedules.length()").value(0))
                .andExpect(jsonPath("$.days[0].tasks.length()").value(0));
    }

    @Test
    @DisplayName("非法月份 / 年份 → 400")
    void invalidMonth() throws Exception {
        mvc.perform(get("/api/calendar").param("year", "2026").param("month", "13"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
        mvc.perform(get("/api/calendar").param("year", "1900").param("month", "5"))
                .andExpect(status().isBadRequest());
    }

    @Test
    @DisplayName("日期详情：按日期查询课程与任务（原有 /api/tasks/by-date 保持不变）")
    void dayDetailSources() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                        ApiTestSupport.course("MA102", "线性代数")))
                .andExpect(status().isCreated()).andReturn());
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(4, "10:10", "11:50", "教二 108", "ALL", SEMESTER_START, 1, 5)))
                .andExpect(status().isCreated());
        mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("线代作业", courseId, "2026-09-10T10:00:00+08:00", "HOMEWORK", 4, 40)))
                .andExpect(status().isCreated());

        // 2026-09-10 是周四：有课也有 DDL
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-09-10"))
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].courseName").value("线性代数"));
        mvc.perform(get("/api/tasks/by-date").param("date", "2026-09-10"))
                .andExpect(jsonPath("$[*].title", hasItem("线代作业")));

        // 2026-09-11 周五：都没有
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-09-11"))
                .andExpect(jsonPath("$.length()").value(0));
        mvc.perform(get("/api/tasks/by-date").param("date", "2026-09-11"))
                .andExpect(jsonPath("$[*].title", not(hasItem("线代作业"))));
    }
}
