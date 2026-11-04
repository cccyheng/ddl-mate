package com.ddlmate;

import static org.hamcrest.Matchers.contains;
import static org.hamcrest.Matchers.containsInAnyOrder;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.LocalDate;
import java.time.ZoneId;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.ddlmate.common.TimeZones;

/** 任务列表的排序、筛选、按月/按日查询与今日任务。 */
class TaskQueryIT extends BaseIntegrationTest {

    private long courseId;

    private long otherCourseId;

    @BeforeEach
    void prepareTasks() throws Exception {
        courseId = ApiTestSupport.idOf(mvc.perform(
                        ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("CS201", "数据结构")))
                .andExpect(status().isCreated()).andReturn());
        otherCourseId = ApiTestSupport.idOf(mvc.perform(
                        ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("MA102", "线性代数")))
                .andExpect(status().isCreated()).andReturn());

        // 故意打乱创建顺序，验证排序是按 DDL 而不是按创建时间
        createTask("实验三", courseId, "2026-10-20T23:59:00+08:00", "LAB", 3);
        createTask("作业一", courseId, "2026-10-05T10:00:00+08:00", "HOMEWORK", 5);
        createTask("线代作业", otherCourseId, "2026-10-12T10:00:00+08:00", "HOMEWORK", 4);
        createTask("没有DDL的任务", null, null, "OTHER", 2);
    }

    @Test
    @DisplayName("DDL 列表按截止时间升序，且不包含没有 DDL 的任务")
    void deadlinesSortedAscending() throws Exception {
        mvc.perform(get("/api/tasks/deadlines"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(3))
                .andExpect(jsonPath("$[*].title", contains("作业一", "线代作业", "实验三")));
    }

    @Test
    @DisplayName("DDL 列表可按优先级排序")
    void deadlinesSortedByPriority() throws Exception {
        mvc.perform(get("/api/tasks/deadlines").param("sort", "priority").param("direction", "desc"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].title").value("作业一"));
    }

    @Test
    @DisplayName("DDL 列表 direction=desc 时按截止时间倒序")
    void deadlinesDescending() throws Exception {
        mvc.perform(get("/api/tasks/deadlines").param("sort", "deadline").param("direction", "desc"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[*].title", contains("实验三", "线代作业", "作业一")));
    }

    @Test
    @DisplayName("DDL 列表 includeDone=true 时包含已完成任务")
    void deadlinesIncludeDone() throws Exception {
        long taskId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("已完成但要看得到", courseId, "2026-10-01T09:00:00+08:00", "HOMEWORK", 3, 30)))
                .andExpect(status().isCreated()).andReturn());
        mvc.perform(ApiTestSupport.json(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .patch("/api/tasks/{id}/status", taskId),
                        """
                                {"status":"DONE"}
                                """))
                .andExpect(status().isOk());

        mvc.perform(get("/api/tasks/deadlines"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[*].title",
                        org.hamcrest.Matchers.not(org.hamcrest.Matchers.hasItem("已完成但要看得到"))));

        mvc.perform(get("/api/tasks/deadlines").param("includeDone", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[*].title", org.hamcrest.Matchers.hasItem("已完成但要看得到")));
    }

    @Test
    @DisplayName("DDL 列表按课程过滤，且始终排除没有 DDL 的任务")
    void deadlinesFilteredByCourse() throws Exception {
        mvc.perform(get("/api/tasks/deadlines").param("courseId", String.valueOf(otherCourseId)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].title").value("线代作业"));

        mvc.perform(get("/api/tasks/deadlines"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[*].title",
                        org.hamcrest.Matchers.not(org.hamcrest.Matchers.hasItem("没有DDL的任务"))));
    }

    @Test
    @DisplayName("DDL 列表非法排序字段 → 400")
    void deadlinesInvalidSort() throws Exception {
        mvc.perform(get("/api/tasks/deadlines").param("sort", "no_such_field"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
    }

    @Test
    @DisplayName("按课程筛选只返回该课程任务")
    void filterByCourse() throws Exception {
        mvc.perform(get("/api/tasks").param("courseId", String.valueOf(otherCourseId)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalElements").value(1))
                .andExpect(jsonPath("$.content[0].title").value("线代作业"));
    }

    @Test
    @DisplayName("按状态与类型筛选生效")
    void filterByStatusAndType() throws Exception {
        mvc.perform(get("/api/tasks").param("type", "LAB"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalElements").value(1))
                .andExpect(jsonPath("$.content[0].title").value("实验三"));

        mvc.perform(get("/api/tasks").param("status", "TODO"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalElements").value(4));
    }

    @Test
    @DisplayName("关键词搜索命中标题与提交要求")
    void searchByKeyword() throws Exception {
        mvc.perform(get("/api/tasks").param("keyword", "线代"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalElements").value(1))
                .andExpect(jsonPath("$.content[0].title").value("线代作业"));
    }

    @Test
    @DisplayName("时间窗口筛选 dueFrom/dueTo")
    void filterByDueWindow() throws Exception {
        mvc.perform(get("/api/tasks")
                        .param("dueFrom", "2026-10-01T00:00:00+08:00")
                        .param("dueTo", "2026-10-15T00:00:00+08:00"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalElements").value(2))
                .andExpect(jsonPath("$.content[*].title", containsInAnyOrder("作业一", "线代作业")));
    }

    @Test
    @DisplayName("分页参数生效，默认按 DDL 升序")
    void pagination() throws Exception {
        mvc.perform(get("/api/tasks").param("size", "2").param("page", "0"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.size").value(2))
                .andExpect(jsonPath("$.totalElements").value(4))
                .andExpect(jsonPath("$.totalPages").value(2))
                .andExpect(jsonPath("$.content.length()").value(2))
                .andExpect(jsonPath("$.content[0].title").value("作业一"));
    }

    @Test
    @DisplayName("非法排序字段 → 400")
    void invalidSort() throws Exception {
        mvc.perform(get("/api/tasks").param("sort", "drop table"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
    }

    @Test
    @DisplayName("按月查询返回按日期分组的任务")
    void calendarByMonth() throws Exception {
        mvc.perform(get("/api/tasks/calendar").param("year", "2026").param("month", "10"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.year").value(2026))
                .andExpect(jsonPath("$.month").value(10))
                .andExpect(jsonPath("$.days.length()").value(3))
                .andExpect(jsonPath("$.days[0].date").value("2026-10-05"))
                .andExpect(jsonPath("$.days[0].tasks[0].title").value("作业一"));
    }

    @Test
    @DisplayName("非法月份 → 400")
    void calendarInvalidMonth() throws Exception {
        mvc.perform(get("/api/tasks/calendar").param("year", "2026").param("month", "13"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
    }

    @Test
    @DisplayName("按日期查询只返回当天截止的任务")
    void byDate() throws Exception {
        mvc.perform(get("/api/tasks/by-date").param("date", "2026-10-12"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].title").value("线代作业"));
    }

    @Test
    @DisplayName("日期参数格式非法 → 400")
    void byDateMalformed() throws Exception {
        mvc.perform(get("/api/tasks/by-date").param("date", "2026/10/12"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
    }

    @Test
    @DisplayName("今日任务包含今天截止的任务")
    void todayIncludesTaskDueToday() throws Exception {
        ZoneId zone = TimeZones.zone();
        String todayNoon = LocalDate.now(zone).atTime(12, 0).atZone(zone).toOffsetDateTime().toString();
        createTask("今天中午截止", courseId, todayNoon, "HOMEWORK", 3);

        mvc.perform(get("/api/tasks/today"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.title=='今天中午截止')]").exists());
    }

    @Test
    @DisplayName("includeDone=false 时已完成任务不出现在 DDL 列表")
    void doneTaskHiddenByDefault() throws Exception {
        long taskId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("已完成任务", courseId, "2026-10-01T10:00:00+08:00", "HOMEWORK", 3, 30)))
                .andExpect(status().isCreated()).andReturn());

        mvc.perform(ApiTestSupport.json(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .patch("/api/tasks/{id}/status", taskId),
                        """
                                {"status":"DONE"}
                                """))
                .andExpect(status().isOk());

        mvc.perform(get("/api/tasks/deadlines"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[*].title", org.hamcrest.Matchers.not(org.hamcrest.Matchers.hasItem("已完成任务"))));

        mvc.perform(get("/api/tasks/deadlines").param("includeDone", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[?(@.title=='已完成任务')]").exists());
    }

    private void createTask(String title, Long course, String deadline, String type, int priority) throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task(title, course, deadline, type, priority, 60)))
                .andExpect(status().isCreated());
    }
}
