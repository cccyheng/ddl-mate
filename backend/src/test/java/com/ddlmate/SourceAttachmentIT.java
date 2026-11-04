package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MvcResult;

/** 原通知（M 功能）：文字 + 来源名 + 图片附件的上传、留存与下载。 */
class SourceAttachmentIT extends BaseIntegrationTest {

    @Test
    @DisplayName("原通知保存文字与来源名，列表可读")
    void createSourceSavesTextAndName() throws Exception {
        long taskId = createTask();

        mvc.perform(ApiTestSupport.json(post("/api/tasks/{id}/sources", taskId),
                        ApiTestSupport.source("数据结构课程群", "实验二本周日晚十二点之前上传，要求源代码和实验报告一起打包。")))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").exists())
                .andExpect(jsonPath("$.taskId").value(taskId))
                .andExpect(jsonPath("$.sourceName").value("数据结构课程群"))
                .andExpect(jsonPath("$.sourceType").value("WECHAT_GROUP"))
                .andExpect(jsonPath("$.capturedAt").value("2026-10-05T20:31:00+08:00"))
                .andExpect(jsonPath("$.attachments.length()").value(0));

        mvc.perform(get("/api/tasks/{id}/sources", taskId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1));

        mvc.perform(get("/api/tasks/{id}", taskId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sourceCount").value(1));
    }

    @Test
    @DisplayName("上传 PNG 附件：真实落盘、元数据可查、下载字节一致")
    void uploadAndDownloadAttachment() throws Exception {
        long sourceId = createSource();
        byte[] png = tinyPng();

        MvcResult uploaded = mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "群消息截图.png", "image/png", png)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].originalName").value("群消息截图.png"))
                .andExpect(jsonPath("$[0].contentType").value("image/png"))
                .andExpect(jsonPath("$[0].sizeBytes").value(png.length))
                .andExpect(jsonPath("$[0].sourceId").value(sourceId))
                .andReturn();

        long attachmentId = ApiTestSupport.body(uploaded).get(0).get("id").asLong();

        // 数据库里有记录
        var stored = attachmentRepository.findById(attachmentId).orElseThrow();
        assertThat(stored.getStoredName()).endsWith(".png");
        assertThat(stored.getStoredName()).doesNotContain("..").doesNotContain("/");

        // 磁盘上真的有这个文件，且内容一致
        Path onDisk = UPLOAD_DIR.resolve(stored.getRelativePath());
        assertThat(Files.exists(onDisk)).isTrue();
        assertThat(Files.readAllBytes(onDisk)).isEqualTo(png);

        MvcResult downloaded = mvc.perform(get("/api/attachments/{id}", attachmentId))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(downloaded.getResponse().getContentAsByteArray()).isEqualTo(png);
        assertThat(downloaded.getResponse().getContentType()).isEqualTo("image/png");
        assertThat(downloaded.getResponse().getHeader("Content-Disposition")).contains("inline");
    }

    @Test
    @DisplayName("?download=true 时使用 attachment 且保留中文文件名")
    void downloadWithAttachmentDisposition() throws Exception {
        long sourceId = createSource();
        MvcResult uploaded = mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "通知.png", "image/png", tinyPng())))
                .andExpect(status().isCreated()).andReturn();
        long attachmentId = ApiTestSupport.body(uploaded).get(0).get("id").asLong();

        MvcResult result = mvc.perform(get("/api/attachments/{id}", attachmentId).param("download", "true"))
                .andExpect(status().isOk())
                .andReturn();
        String disposition = result.getResponse().getHeader("Content-Disposition");
        assertThat(disposition).contains("attachment");
        assertThat(disposition).contains("filename*=");
    }

    @Test
    @DisplayName("上传响应必须带真实附件 ID，并且能立刻 GET 到原图")
    void uploadResponseIdIsImmediatelyDownloadable() throws Exception {
        long sourceId = createSource();
        byte[] png = tinyPng();

        MvcResult uploaded = mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "立刻可读.png", "image/png", png)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$[0].id").isNumber())
                .andExpect(jsonPath("$[0].sourceId").value(sourceId))
                .andExpect(jsonPath("$[0].viewUrl").value(org.hamcrest.Matchers.containsString("/api/attachments/")))
                .andReturn();

        long attachmentId = ApiTestSupport.body(uploaded).get(0).get("id").asLong();
        assertThat(attachmentId).isPositive();

        MvcResult downloaded = mvc.perform(get("/api/attachments/{id}", attachmentId))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(downloaded.getResponse().getContentAsByteArray()).isEqualTo(png);
    }

    @Test
    @DisplayName("HTML 伪装成 image/png 也必须被拒绝 → 415（只看文件头魔数）")
    void rejectHtmlPretendingToBePng() throws Exception {
        long sourceId = createSource();
        byte[] html = "<!DOCTYPE html><html><body>not an image</body></html>".getBytes(java.nio.charset.StandardCharsets.UTF_8);

        mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "fake.png", "image/png", html)))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"));

        assertThat(attachmentRepository.count()).isZero();
    }

    @Test
    @DisplayName("PNG 魔数不完整（只有前 4 字节）同样被拒绝 → 415")
    void rejectTruncatedPngSignature() throws Exception {
        long sourceId = createSource();
        byte[] truncated = new byte[] {(byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x00, 0x01, 0x02, 0x03};

        mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "half.png", "image/png", truncated)))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"));
    }

    @Test
    @DisplayName("一次上传多张图片，全部留存")
    void uploadMultipleFiles() throws Exception {
        long sourceId = createSource();
        byte[] jpeg = new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0x00, 0x10, 0x4A, 0x46,
                0x49, 0x46, 0x00, 0x01};

        mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "a.png", "image/png", tinyPng()))
                        .file(new MockMultipartFile("file", "b.jpg", "image/jpeg", jpeg)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].contentType").value("image/png"))
                .andExpect(jsonPath("$[1].contentType").value("image/jpeg"));

        assertThat(attachmentRepository.count()).isEqualTo(2);
    }

    @Test
    @DisplayName("非图片类型被拒绝 → 415")
    void rejectNonImage() throws Exception {
        long sourceId = createSource();

        mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "作业.txt", "text/plain", "不是图片".getBytes())))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"));

        assertThat(attachmentRepository.count()).isZero();
    }

    @Test
    @DisplayName("伪造 Content-Type 的文本文件仍被拒绝（按文件头嗅探）→ 415")
    void rejectFakeImageContentType() throws Exception {
        long sourceId = createSource();
        byte[] text = "这不是图片，只是把 Content-Type 写成了 image/png".getBytes(java.nio.charset.StandardCharsets.UTF_8);

        mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "fake.png", "image/png", text)))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"));

        // 没有落库，也没有留下任何文件
        assertThat(attachmentRepository.count()).isZero();
    }

    @Test
    @DisplayName("超过 5MB 的附件被拒绝 → 413")
    void rejectOversizedFile() throws Exception {
        long sourceId = createSource();
        byte[] big = new byte[5 * 1024 * 1024 + 1];
        big[0] = (byte) 0x89;
        big[1] = 0x50;
        big[2] = 0x4E;
        big[3] = 0x47;

        mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "huge.png", "image/png", big)))
                .andExpect(status().isPayloadTooLarge())
                .andExpect(jsonPath("$.code").value("FILE_TOO_LARGE"));
    }

    @Test
    @DisplayName("带路径的文件名被净化，不会写出上传目录之外")
    void pathTraversalFilenameIsSanitized() throws Exception {
        long sourceId = createSource();

        MvcResult result = mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "../../../evil.png", "image/png", tinyPng())))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$[0].originalName").value("evil.png"))
                .andReturn();

        long attachmentId = ApiTestSupport.body(result).get(0).get("id").asLong();
        var stored = attachmentRepository.findById(attachmentId).orElseThrow();
        Path onDisk = UPLOAD_DIR.resolve(stored.getRelativePath()).normalize();
        assertThat(onDisk.startsWith(UPLOAD_DIR)).isTrue();
        assertThat(Files.exists(onDisk)).isTrue();
        assertThat(Files.exists(UPLOAD_DIR.getParent().resolve("evil.png"))).isFalse();
    }

    @Test
    @DisplayName("删除附件：数据库记录与磁盘文件都消失")
    void deleteAttachment() throws Exception {
        long sourceId = createSource();
        MvcResult uploaded = mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "c.png", "image/png", tinyPng())))
                .andExpect(status().isCreated()).andReturn();
        long attachmentId = ApiTestSupport.body(uploaded).get(0).get("id").asLong();
        var stored = attachmentRepository.findById(attachmentId).orElseThrow();
        Path onDisk = UPLOAD_DIR.resolve(stored.getRelativePath());

        mvc.perform(delete("/api/attachments/{id}", attachmentId)).andExpect(status().isNoContent());

        assertThat(attachmentRepository.findById(attachmentId)).isEmpty();
        assertThat(Files.exists(onDisk)).isFalse();
        mvc.perform(get("/api/attachments/{id}", attachmentId)).andExpect(status().isNotFound());
    }

    @Test
    @DisplayName("给不存在的原通知上传附件 → 404")
    void uploadToUnknownSource() throws Exception {
        mvc.perform(multipart("/api/sources/{id}/attachments", 999999)
                        .file(new MockMultipartFile("file", "x.png", "image/png", tinyPng())))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));
    }

    @Test
    @DisplayName("删除只有原通知（无附件）的任务")
    void deletingTaskWithoutAttachment() throws Exception {
        long taskId = createTask();
        mvc.perform(ApiTestSupport.json(post("/api/tasks/{id}/sources", taskId),
                        ApiTestSupport.source("QQ群", "没有附件的通知")))
                .andExpect(status().isCreated());

        mvc.perform(delete("/api/tasks/{id}", taskId)).andExpect(status().isNoContent());
        assertThat(taskRepository.count()).isZero();
        assertThat(sourceRepository.count()).isZero();
    }

    @Test
    @DisplayName("删除任务时原通知与附件一并清理（含磁盘文件）")
    void deletingTaskCascadesSources() throws Exception {
        long taskId = createTask();
        long sourceId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(
                        post("/api/tasks/{id}/sources", taskId), ApiTestSupport.source("QQ群", "通知原文")))
                .andExpect(status().isCreated()).andReturn());
        mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "d.png", "image/png", tinyPng())))
                .andExpect(status().isCreated());

        // 直接从附件仓储读取落盘路径：TaskSource.attachments 是懒加载集合，
        // 在测试方法（事务之外）里访问会抛 LazyInitializationException。
        List<Path> files = attachmentRepository.findAll().stream()
                .map(attachment -> UPLOAD_DIR.resolve(attachment.getRelativePath()))
                .toList();
        assertThat(files).isNotEmpty();
        assertThat(files).allMatch(Files::exists);

        mvc.perform(delete("/api/tasks/{id}", taskId)).andExpect(status().isNoContent());

        assertThat(taskRepository.count()).isZero();
        assertThat(sourceRepository.count()).isZero();
        assertThat(attachmentRepository.count()).isZero();
        // JPA 级联只删数据库行，磁盘文件必须由服务层在事务提交后清理
        assertThat(files).noneMatch(Files::exists);
    }

    @Test
    @DisplayName("删除原通知时数据库记录与磁盘文件一起清理")
    void deletingSourceRemovesFiles() throws Exception {
        long sourceId = createSource();
        MvcResult uploaded = mvc.perform(multipart("/api/sources/{id}/attachments", sourceId)
                        .file(new MockMultipartFile("file", "e.png", "image/png", tinyPng())))
                .andExpect(status().isCreated()).andReturn();
        long attachmentId = ApiTestSupport.body(uploaded).get(0).get("id").asLong();
        Path onDisk = UPLOAD_DIR.resolve(attachmentRepository.findById(attachmentId).orElseThrow().getRelativePath());
        assertThat(Files.exists(onDisk)).isTrue();

        mvc.perform(delete("/api/sources/{id}", sourceId)).andExpect(status().isNoContent());

        assertThat(sourceRepository.count()).isZero();
        assertThat(attachmentRepository.count()).isZero();
        assertThat(Files.exists(onDisk)).isFalse();
    }

    private long createTask() throws Exception {
        return ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task("数据结构实验二", null, "2026-10-15T10:10:00+08:00", "LAB", 4, 180)))
                .andExpect(status().isCreated()).andReturn());
    }

    private long createSource() throws Exception {
        long taskId = createTask();
        return ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks/{id}/sources", taskId),
                        ApiTestSupport.source("数据结构课程群", "实验二本周日晚十二点之前上传。")))
                .andExpect(status().isCreated()).andReturn());
    }
}
