package com.ddlmate;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** 输入校验与统一错误响应。 */
class ValidationErrorIT extends BaseIntegrationTest {

    @Test
    @DisplayName("任务缺标题 → 400 且 fieldErrors 含 title")
    void taskWithoutTitle() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/tasks"), """
                        {"description":"没有标题","type":"HOMEWORK"}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.status").value(400))
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"))
                .andExpect(jsonPath("$.path").value("/api/tasks"))
                .andExpect(jsonPath("$.timestamp").exists())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("title"))
                .andExpect(jsonPath("$.fieldErrors[0].message").value("任务标题不能为空"));
    }

    @Test
    @DisplayName("任务标题超长 → 400")
    void taskTitleTooLong() throws Exception {
        String longTitle = "长".repeat(201);
        mvc.perform(ApiTestSupport.json(post("/api/tasks"), ApiTestSupport.task(longTitle, null,
                        "2026-10-15T10:10:00+08:00", "HOMEWORK", 3, 60)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    @Test
    @DisplayName("优先级越界 → 400")
    void taskPriorityOutOfRange() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("优先级越界", null, "2026-10-15T10:10:00+08:00", "HOMEWORK", 9, 60)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("priority"));
    }

    @Test
    @DisplayName("非法任务类型 → 400")
    void taskTypeInvalid() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("类型非法", null, "2026-10-15T10:10:00+08:00", "NOT_A_TYPE", 3, 60)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
    }

    @Test
    @DisplayName("截止时间格式非法 → 400")
    void deadlineMalformed() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/tasks"), """
                        {"title":"时间格式错误","deadline":"2026/10/15 10:10"}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
    }

    @Test
    @DisplayName("不存在的任务 ID → 404 标准错误体")
    void unknownTaskId() throws Exception {
        mvc.perform(get("/api/tasks/{id}", 999999))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.status").value(404))
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"))
                .andExpect(jsonPath("$.path").value("/api/tasks/999999"));
    }

    @Test
    @DisplayName("不存在的课程 ID → 404")
    void unknownCourseId() throws Exception {
        mvc.perform(get("/api/courses/{id}", 424242))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));
    }

    @Test
    @DisplayName("课表开始时间晚于结束时间 → 400")
    void scheduleInvalidTimeRange() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(
                        ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("PH101", "大学物理")))
                .andExpect(status().isCreated()).andReturn());

        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId), """
                        {"weekday":1,"startTime":"14:00","endTime":"12:00"}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"))
                .andExpect(jsonPath("$.fieldErrors[0].field").value("startTime"));
    }

    @Test
    @DisplayName("课表星期越界 → 400")
    void scheduleWeekdayOutOfRange() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(
                        ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("PH102", "大学物理")))
                .andExpect(status().isCreated()).andReturn());

        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId), """
                        {"weekday":8,"startTime":"08:00","endTime":"09:40"}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("weekday"));
    }

    @Test
    @DisplayName("任务绑定不存在的课程 → 404")
    void taskWithUnknownCourse() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("课程不存在", 987654L, "2026-10-15T10:10:00+08:00", "HOMEWORK", 3, 60)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));
    }

    @Test
    @DisplayName("课程缺名称 → 400")
    void courseWithoutName() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/courses"), """
                        {"code":"XX999"}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("name"));
    }

    @Test
    @DisplayName("请求体不是合法 JSON → 400")
    void malformedJson() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/tasks"), "{not json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
    }

    @Test
    @DisplayName("不存在的接口返回 404 JSON，而不是前端页面")
    void unknownApiPath() throws Exception {
        mvc.perform(get("/api/does-not-exist"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));
    }

    @Test
    @DisplayName("PUT 全量更新时缺标题同样返回 400")
    void putWithoutTitle() throws Exception {
        long taskId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("待更新", null, "2026-10-15T10:10:00+08:00", "HOMEWORK", 3, 60)))
                .andExpect(status().isCreated()).andReturn());

        mvc.perform(ApiTestSupport.json(put("/api/tasks/{id}", taskId), """
                        {"description":"没有标题"}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("title"));
    }
}
