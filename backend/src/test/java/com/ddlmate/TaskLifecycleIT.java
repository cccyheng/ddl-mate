package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;

import com.fasterxml.jackson.databind.JsonNode;

/** 核心闭环：建课程 → 建课表 → 建任务 → 切状态 → 详情与统计。 */
class TaskLifecycleIT extends BaseIntegrationTest {

    @Test
    @DisplayName("创建课程返回 201 + Location，并能按 id 查询")
    void createCourse() throws Exception {
        MvcResult created = mvc.perform(ApiTestSupport.json(post("/api/courses"),
                        ApiTestSupport.course("CS201", "数据结构")))
                .andExpect(status().isCreated())
                .andExpect(header().string("Location", containsString("/api/courses/")))
                .andExpect(jsonPath("$.code").value("CS201"))
                .andExpect(jsonPath("$.name").value("数据结构"))
                .andExpect(jsonPath("$.taskCount").value(0))
                .andReturn();

        long id = ApiTestSupport.idOf(created);
        mvc.perform(get("/api/courses/{id}", id))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(id));
    }

    @Test
    @DisplayName("重复课程代码返回 409，而不是 500")
    void duplicateCourseCode() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("CS201", "数据结构")))
                .andExpect(status().isCreated());
        mvc.perform(ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("cs201", "数据结构（重复）")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("RESOURCE_IN_USE"));
    }

    @Test
    @DisplayName("课表创建成功，且响应带中文学期标签")
    void createSchedule() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(
                        ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("MA102", "线性代数")))
                .andExpect(status().isCreated()).andReturn());

        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId), """
                        {"weekday":4,"startTime":"10:10","endTime":"11:50","location":"教二 108",
                         "periodStart":3,"periodEnd":4,"weekRange":"1-16"}
                        """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.weekday").value(4))
                .andExpect(jsonPath("$.weekdayLabel").value("周四"))
                .andExpect(jsonPath("$.startTime").value("10:10:00"))
                .andExpect(jsonPath("$.location").value("教二 108"));

        mvc.perform(get("/api/courses/{id}/schedules", courseId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1));

        mvc.perform(get("/api/schedules").param("weekday", "4"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1));
    }

    @Test
    @DisplayName("任务创建 → 详情 → 状态切换 → 统计更新")
    void taskLifecycle() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(
                        ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("CS201", "数据结构")))
                .andExpect(status().isCreated()).andReturn());

        MvcResult created = mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("数据结构实验二", courseId, "2026-10-15T10:10:00+08:00", "LAB", 4, 180)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.title").value("数据结构实验二"))
                .andExpect(jsonPath("$.course.id").value(courseId))
                .andExpect(jsonPath("$.typeLabel").value("实验"))
                .andExpect(jsonPath("$.status").value("TODO"))
                .andExpect(jsonPath("$.statusLabel").value("未开始"))
                .andExpect(jsonPath("$.priority").value(4))
                .andExpect(jsonPath("$.deadline").value("2026-10-15T10:10:00+08:00"))
                .andReturn();
        long taskId = ApiTestSupport.idOf(created);

        mvc.perform(get("/api/tasks/{id}", taskId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.estimatedMinutes").value(180))
                .andExpect(jsonPath("$.submitMethod").value("学习通"))
                .andExpect(jsonPath("$.sourceCount").value(0));

        mvc.perform(ApiTestSupport.json(patch("/api/tasks/{id}/status", taskId), """
                        {"status":"DOING"}
                        """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("DOING"))
                .andExpect(jsonPath("$.completedAt").doesNotExist());

        mvc.perform(ApiTestSupport.json(patch("/api/tasks/{id}/status", taskId), """
                        {"status":"DONE"}
                        """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("DONE"))
                .andExpect(jsonPath("$.completedAt").exists());

        mvc.perform(get("/api/tasks/stats"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.completed").value(1))
                .andExpect(jsonPath("$.open").value(0));
    }

    @Test
    @DisplayName("PATCH 局部更新只改传入字段，clearDeadline 能清空截止时间")
    void patchTask() throws Exception {
        long taskId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("英语作文", null, "2026-10-20T22:00:00+08:00", "HOMEWORK", 3, 120)))
                .andExpect(status().isCreated()).andReturn());

        mvc.perform(ApiTestSupport.json(patch("/api/tasks/{id}", taskId), """
                        {"title":"英语作文 Draft 2","submitMethod":"邮箱"}
                        """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("英语作文 Draft 2"))
                .andExpect(jsonPath("$.submitMethod").value("邮箱"))
                .andExpect(jsonPath("$.type").value("HOMEWORK"))
                .andExpect(jsonPath("$.deadline").value("2026-10-20T22:00:00+08:00"));

        mvc.perform(ApiTestSupport.json(patch("/api/tasks/{id}", taskId), """
                        {"clearDeadline":true}
                        """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.deadline").doesNotExist());
    }

    @Test
    @DisplayName("PUT 全量更新任务，DELETE 后查询返回 404")
    void updateAndDeleteTask() throws Exception {
        long taskId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("旧标题", null, "2026-11-01T23:59:00+08:00", "REPORT", 2, 60)))
                .andExpect(status().isCreated()).andReturn());

        mvc.perform(ApiTestSupport.json(put("/api/tasks/{id}", taskId),
                        ApiTestSupport.task("新标题", null, "2026-11-02T23:59:00+08:00", "PROJECT", 5, 300)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("新标题"))
                .andExpect(jsonPath("$.type").value("PROJECT"))
                .andExpect(jsonPath("$.priority").value(5));

        mvc.perform(delete("/api/tasks/{id}", taskId)).andExpect(status().isNoContent());
        mvc.perform(get("/api/tasks/{id}", taskId)).andExpect(status().isNotFound());
        assertThat(taskRepository.count()).isZero();
    }

    @Test
    @DisplayName("元数据接口返回枚举与时间格式说明")
    void meta() throws Exception {
        MvcResult result = mvc.perform(get("/api/meta/enums"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.timeZone").value("Asia/Shanghai"))
                .andReturn();
        JsonNode node = ApiTestSupport.body(result);
        assertThat(node.get("taskTypes").size()).isGreaterThanOrEqualTo(8);
        assertThat(node.get("taskStatuses").size()).isEqualTo(4);
        assertThat(node.get("priorities").size()).isEqualTo(5);
    }

    @Test
    @DisplayName("本地用户资料存在且明确标注未启用鉴权")
    void profile() throws Exception {
        mvc.perform(get("/api/profile"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.username").value("local"))
                .andExpect(jsonPath("$.timeZone").value("Asia/Shanghai"))
                .andExpect(jsonPath("$.authenticationEnabled").value(false));
    }
}
