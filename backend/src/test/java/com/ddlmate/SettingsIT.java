package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** 键值设置：白名单、乐观并发、按任务清理。 */
class SettingsIT extends BaseIntegrationTest {

    private static String body(String value, long expectedRevision) {
        return """
                {"value":%s,"expectedRevision":%d}
                """.formatted(new com.fasterxml.jackson.databind.ObjectMapper().valueToTree(value).toString(),
                expectedRevision);
    }

    @Test
    @DisplayName("从未写过的键返回 value=null、revision=0")
    void missingKeyIsEmpty() throws Exception {
        mvc.perform(get("/api/settings/{key}", "focus.sessions.v1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.key").value("focus.sessions.v1"))
                .andExpect(jsonPath("$.value").doesNotExist())
                .andExpect(jsonPath("$.revision").value(0));
    }

    @Test
    @DisplayName("写入后版本号递增，取值原样返回（含中文与 JSON）")
    void putAndReadBack() throws Exception {
        String json = "{\"version\":1,\"records\":[{\"note\":\"复习第三章\"}]}";
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "focus.sessions.v1"), body(json, 0)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.revision").value(1));
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "focus.sessions.v1"), body(json + " ", 1)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.revision").value(2));
        mvc.perform(get("/api/settings/{key}", "focus.sessions.v1"))
                .andExpect(jsonPath("$.value").value(json + " "))
                .andExpect(jsonPath("$.revision").value(2));
    }

    @Test
    @DisplayName("版本号过期返回 409 SETTING_CONFLICT，旧值不被覆盖")
    void staleRevisionConflicts() throws Exception {
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "daily_plan.today"), body("A", 0)))
                .andExpect(status().isOk());
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "daily_plan.today"), body("B", 0)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("SETTING_CONFLICT"));
        mvc.perform(get("/api/settings/{key}", "daily_plan.today"))
                .andExpect(jsonPath("$.value").value("A"));
    }

    @Test
    @DisplayName("不在白名单的键返回 400；按任务的键只接受正整数 id")
    void unknownKeysRejected() throws Exception {
        mvc.perform(get("/api/settings/{key}", "photo_ocr.companion_endpoint"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "task_steps.abc"), body("x", 0)))
                .andExpect(status().isBadRequest());
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "task_steps.0"), body("x", 0)))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/settings").param("prefix", "focus."))
                .andExpect(status().isBadRequest());
    }

    @Test
    @DisplayName("缺少版本号返回 400 VALIDATION_FAILED")
    void missingRevision() throws Exception {
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "task_templates.v1"), "{\"value\":\"x\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    @Test
    @DisplayName("按前缀列出任务步骤；删除任务时它的步骤与提醒一并删除")
    void perTaskSettingsFollowTask() throws Exception {
        long taskId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("实验报告", null, null, "LAB", 3, 60)))
                .andExpect(status().isCreated()).andReturn());
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "task_steps." + taskId), body("[]", 0)))
                .andExpect(status().isOk());
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "task_reminder." + taskId), body("{}", 0)))
                .andExpect(status().isOk());

        mvc.perform(get("/api/settings").param("prefix", "task_steps."))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].key").value("task_steps." + taskId));

        mvc.perform(delete("/api/tasks/{id}", taskId)).andExpect(status().isNoContent());
        assertThat(settingRepository.count()).isZero();
    }

    @Test
    @DisplayName("删除设置返回 204，之后读到空值")
    void deleteSetting() throws Exception {
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "class_reminder.v1"), body("{}", 0)))
                .andExpect(status().isOk());
        mvc.perform(delete("/api/settings/{key}", "class_reminder.v1")).andExpect(status().isNoContent());
        mvc.perform(get("/api/settings/{key}", "class_reminder.v1"))
                .andExpect(jsonPath("$.revision").value(0));
    }
}
