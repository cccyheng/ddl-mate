package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** 整库备份：导出 → 改动 → 预览 → 恢复，原 id、时间、附件、设置全部回到导出时。 */
class BackupIT extends BaseIntegrationTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    @DisplayName("导出后改动数据，恢复回到导出时：id、截止时间、课表时刻、附件字节、设置都一致")
    void exportRestoreRoundTrip() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                ApiTestSupport.course("CS201", "数据结构"))).andExpect(status().isCreated()).andReturn());
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId), """
                {"weekday":3,"startTime":"14:00","endTime":"15:40","location":"教二 108"}
                """)).andExpect(status().isCreated());
        long taskId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                ApiTestSupport.task("实验报告", courseId, "2026-11-07T23:59:00+08:00", "LAB", 4, 90)))
                .andExpect(status().isCreated()).andReturn());
        long sourceId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks/{id}/sources", taskId),
                ApiTestSupport.source("课程群", "周日前交"))).andExpect(status().isCreated()).andReturn());
        mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                .file(new MockMultipartFile("file", "截图.png", "image/png", tinyPng())))
                .andExpect(status().isCreated());
        mvc.perform(ApiTestSupport.json(put("/api/settings/{key}", "task_steps." + taskId),
                "{\"value\":\"[1,2]\",\"expectedRevision\":0}")).andExpect(status().isOk());

        String backup = ApiTestSupport.utf8(mvc.perform(get("/api/backup/export"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.format").value("ddlmate.web-backup"))
                .andExpect(jsonPath("$.counts.tasks").value(1))
                .andExpect(jsonPath("$.counts.attachments").value(1))
                .andReturn());
        String relativePath = attachmentRepository.findAll().get(0).getRelativePath();

        // 改动：删任务（连带原通知、附件、步骤）、再新建一个
        mvc.perform(delete("/api/tasks/{id}", taskId)).andExpect(status().isNoContent());
        mvc.perform(ApiTestSupport.json(post("/api/tasks"), ApiTestSupport.task("新任务", null, null, "OTHER", 3, null)))
                .andExpect(status().isCreated());

        mvc.perform(ApiTestSupport.json(post("/api/backup/preview"), backup))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.counts.tasks").value(1))
                .andExpect(jsonPath("$.currentCounts.tasks").value(1))
                .andExpect(jsonPath("$.fileCount").value(1));

        JsonNode restored = ApiTestSupport.body(mvc.perform(ApiTestSupport.json(post("/api/backup/restore"), backup))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.counts.tasks").value(1))
                .andReturn());
        assertThat(Files.exists(Path.of(restored.get("safetyCopy").asText()))).isTrue();

        mvc.perform(get("/api/tasks/{id}", taskId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("实验报告"))
                .andExpect(jsonPath("$.deadline").value("2026-11-07T23:59:00+08:00"))
                .andExpect(jsonPath("$.course.id").value(courseId))
                .andExpect(jsonPath("$.sourceCount").value(1));
        mvc.perform(get("/api/courses/{id}/schedules", courseId))
                .andExpect(jsonPath("$[0].startTime").value("14:00:00"));
        mvc.perform(get("/api/settings/{key}", "task_steps." + taskId))
                .andExpect(jsonPath("$.value").value("[1,2]"));
        assertThat(Files.readAllBytes(UPLOAD_DIR.resolve(relativePath))).isEqualTo(tinyPng());

        // 恢复后新建不会撞到保留下来的 id
        long next = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                ApiTestSupport.task("恢复后新建", null, null, "OTHER", 3, null))).andExpect(status().isCreated()).andReturn());
        assertThat(next).isGreaterThan(taskId);
    }

    @Test
    @DisplayName("不是备份文件、引用错位、缺附件文件都返回 400，原数据不变")
    void invalidBackupRejected() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("MA102", "线性代数")))
                .andExpect(status().isCreated());
        String backup = ApiTestSupport.utf8(mvc.perform(get("/api/backup/export")).andReturn());

        mvc.perform(ApiTestSupport.json(post("/api/backup/restore"), "{\"format\":\"other\"}"))
                .andExpect(status().isBadRequest());

        ObjectNode broken = (ObjectNode) MAPPER.readTree(backup);
        ObjectNode schedule = MAPPER.createObjectNode().put("id", 1).put("course_id", 999).put("weekday", 1);
        ((com.fasterxml.jackson.databind.node.ArrayNode) broken.path("tables").path("course_schedules")).add(schedule);
        mvc.perform(ApiTestSupport.json(post("/api/backup/restore"), broken.toString()))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("课表引用了不存在的课程。"));

        ObjectNode badKey = (ObjectNode) MAPPER.readTree(backup);
        ((com.fasterxml.jackson.databind.node.ArrayNode) badKey.path("tables").path("app_settings"))
                .add(MAPPER.createObjectNode().put("setting_key", "photo_ocr.companion_endpoint").put("setting_value", "x"));
        mvc.perform(ApiTestSupport.json(post("/api/backup/preview"), badKey.toString()))
                .andExpect(status().isBadRequest());

        assertThat(courseRepository.count()).isEqualTo(1);
    }
}
