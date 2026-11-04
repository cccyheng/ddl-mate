package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * 「通知截图 / 文字 → 待办」批量导入接口（{@code POST /api/tasks/import-notices}）：
 * 事务、引用校验、图片真实字节、安全校验、未选中不写库与文件清理。
 *
 * <p>上传目录是测试类共享的静态临时目录，因此每个用例开始前除了清库还要把磁盘上的
 * 残留文件清空，否则"落盘文件数"的断言会被上一个用例的残留影响。</p>
 */
class NoticeImportIT extends BaseIntegrationTest {

    @BeforeEach
    void cleanUploadDir() throws IOException {
        if (!Files.exists(UPLOAD_DIR)) {
            return;
        }
        try (Stream<Path> files = Files.walk(UPLOAD_DIR)) {
            for (Path path : files.filter(Files::isRegularFile).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }

    // ------------------------------------------------------------------ 用例

    @Test
    @DisplayName("批量成功：多来源 + 多图片 + 多条任务在同一个事务里写入，原图可下载且字节一致")
    void importCreatesTasksSourcesAndAttachments() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        byte[] png = tinyPng();

        String body = """
                {
                  "sources":[
                    {"sourceRef":"s1","sourceName":"数据结构课程群","sourceType":"WECHAT_GROUP",
                     "rawText":"作业二：10月20日 23:00 前提交实验报告，学习通提交","attachmentIndexes":[0]},
                    {"sourceRef":"s2","sourceName":"教学通知截图","sourceType":"IMAGE",
                     "rawText":"11月3日 14:00 前交课程设计开题报告","attachmentIndexes":[1]},
                    {"sourceRef":"s3","sourceName":"粘贴的文字通知","rawText":"12月1日前完成阅读任务"}
                  ],
                  "attachments":[
                    {"fileIndex":0,"originalName":"通知截图1.png"},
                    {"fileIndex":1,"originalName":"通知截图2.png"}
                  ],
                  "tasks":[
                    {"title":"实验报告二","description":"实验二数据与结论","courseId":%d,"type":"LAB",
                     "deadline":"2026-10-20T23:00:00+08:00","submitRequirement":"实验报告 PDF",
                     "submitMethod":"学习通","sourceRefs":["s1"]},
                    {"title":"课程设计开题报告","courseId":%d,"type":"PROJECT",
                     "deadline":"2026-11-03T14:00:00+08:00","sourceRefs":["s1","s2"]},
                    {"title":"阅读任务","sourceRefs":["s3"]}
                  ]
                }
                """.formatted(courseId, courseId);

        MockMultipartHttpServletRequestBuilder request = multipart("/api/tasks/import-notices");
        request.file(new MockMultipartFile("notice", "", MediaType.APPLICATION_JSON_VALUE,
                body.getBytes(StandardCharsets.UTF_8)));
        request.file(new MockMultipartFile("files", "通知截图1.png", MediaType.IMAGE_PNG_VALUE, png));
        request.file(new MockMultipartFile("files", "通知截图2.png", MediaType.IMAGE_PNG_VALUE, png));

        JsonNode response = ApiTestSupport.body(mvc.perform(request)
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdTasks").value(3))
                // 第二条任务引用 s1 与 s2，而每条任务各自持有一份来源记录 → 共 4 条来源
                .andExpect(jsonPath("$.createdSources").value(4))
                .andExpect(jsonPath("$.createdAttachments").value(3))
                .andExpect(jsonPath("$.tasks.length()").value(3))
                .andExpect(jsonPath("$.tasks[0].title").value("实验报告二"))
                .andExpect(jsonPath("$.tasks[0].type").value("LAB"))
                .andExpect(jsonPath("$.tasks[0].course.name").value("数据结构"))
                .andExpect(jsonPath("$.tasks[0].deadline").value("2026-10-20T23:00:00+08:00"))
                .andExpect(jsonPath("$.tasks[0].sourceCount").value(1))
                .andExpect(jsonPath("$.tasks[1].sourceCount").value(2))
                .andExpect(jsonPath("$.tasks[2].course").doesNotExist())
                .andExpect(jsonPath("$.tasks[2].deadline").doesNotExist())
                .andExpect(jsonPath("$.attachments[0].sizeBytes").value(png.length))
                .andExpect(jsonPath("$.attachments[0].contentType").value("image/png"))
                .andExpect(jsonPath("$.notices.length()").value(0))
                .andReturn());

        assertThat(taskRepository.count()).isEqualTo(3);
        assertThat(sourceRepository.count()).isEqualTo(4);
        assertThat(attachmentRepository.count()).isEqualTo(3);
        // 每个 (任务, 来源) 组合各落一份独立文件：任务1→s1、任务2→s1、任务2→s2 → 3 个文件
        assertThat(storedFileCount()).isEqualTo(3);

        long firstTaskId = response.get("createdTaskIds").get(0).asLong();
        long firstAttachmentId = response.get("tasks").get(0).get("attachments").get(0).get("id").asLong();

        // 任务详情能看到原文与原图（前端"任务详情可查看原文/下载原图"依赖这两条）
        mvc.perform(get("/api/tasks/{id}", firstTaskId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sourceCount").value(1))
                .andExpect(jsonPath("$.attachments[0].id").value(firstAttachmentId));
        mvc.perform(get("/api/tasks/{id}/sources", firstTaskId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].sourceName").value("数据结构课程群"))
                .andExpect(jsonPath("$[0].rawText", org.hamcrest.Matchers.containsString("10月20日")));

        // 原图真实字节保存并可下载：响应体必须与上传的 PNG 逐字节一致
        byte[] downloaded = mvc.perform(get("/api/attachments/{id}", firstAttachmentId).param("download", "true"))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.IMAGE_PNG))
                .andReturn().getResponse().getContentAsByteArray();
        assertThat(downloaded).isEqualTo(png);

        // DDL 与日历都看得到
        mvc.perform(get("/api/tasks/deadlines"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2));
        mvc.perform(get("/api/tasks/calendar").param("year", "2026").param("month", "10"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.days.length()").value(1))
                .andExpect(jsonPath("$.days[0].date").value("2026-10-20"));
    }

    @Test
    @DisplayName("验证失败整体回滚：第二条候选引用不存在的课程 → 404，任务/来源/附件都不落库，磁盘也不留文件")
    void invalidCandidateRollsBackEverything() throws Exception {
        String body = """
                {
                  "sources":[{"sourceRef":"s1","sourceName":"群通知","rawText":"两条任务","attachmentIndexes":[0]}],
                  "attachments":[{"fileIndex":0,"originalName":"a.png"}],
                  "tasks":[
                    {"title":"正常任务","sourceRefs":["s1"]},
                    {"title":"坏任务","courseId":999999,"sourceRefs":["s1"]}
                  ]
                }
                """;
        MockMultipartHttpServletRequestBuilder request = multipart("/api/tasks/import-notices");
        request.file(new MockMultipartFile("notice", "", MediaType.APPLICATION_JSON_VALUE,
                body.getBytes(StandardCharsets.UTF_8)));
        request.file(new MockMultipartFile("files", "a.png", MediaType.IMAGE_PNG_VALUE, tinyPng()));

        mvc.perform(request)
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));

        assertThat(taskRepository.count()).isZero();
        assertThat(sourceRepository.count()).isZero();
        assertThat(attachmentRepository.count()).isZero();
        // 校验在落盘之前完成：一张文件都不应该写出去
        assertThat(storedFileCount()).isZero();
    }

    @Test
    @DisplayName("校验失败时不落盘：候选本身非法（标题空白）→ 400 且磁盘无残留")
    void validationFailureBeforeStorageLeavesNoFiles() throws Exception {
        String body = """
                {
                  "sources":[{"sourceRef":"s1","sourceName":"群通知","attachmentIndexes":[0]}],
                  "attachments":[{"fileIndex":0,"originalName":"b.png"}],
                  "tasks":[{"title":"    ","sourceRefs":["s1"]}]
                }
                """;
        MockMultipartHttpServletRequestBuilder request = multipart("/api/tasks/import-notices");
        request.file(new MockMultipartFile("notice", "", MediaType.APPLICATION_JSON_VALUE,
                body.getBytes(StandardCharsets.UTF_8)));
        request.file(new MockMultipartFile("files", "b.png", MediaType.IMAGE_PNG_VALUE, tinyPng()));

        mvc.perform(request).andExpect(status().isBadRequest());
        assertThat(storedFileCount()).isZero();
        assertThat(attachmentRepository.count()).isZero();
        assertThat(sourceRepository.count()).isZero();
    }

    @Test
    @DisplayName("图片本身不合法（改后缀的文本）→ 415 且不留文件、不建任务")
    void invalidImageContentRejectedAndCleaned() throws Exception {
        String body = """
                {
                  "sources":[{"sourceRef":"s1","sourceName":"群通知","attachmentIndexes":[0]}],
                  "attachments":[{"fileIndex":0,"originalName":"fake.png"}],
                  "tasks":[{"title":"任务","sourceRefs":["s1"]}]
                }
                """;
        MockMultipartHttpServletRequestBuilder request = multipart("/api/tasks/import-notices");
        request.file(new MockMultipartFile("notice", "", MediaType.APPLICATION_JSON_VALUE,
                body.getBytes(StandardCharsets.UTF_8)));
        request.file(new MockMultipartFile("files", "fake.png", MediaType.IMAGE_PNG_VALUE,
                "这不是图片，只是一个文本文件".getBytes(StandardCharsets.UTF_8)));

        mvc.perform(request)
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"));

        assertThat(taskRepository.count()).isZero();
        assertThat(sourceRepository.count()).isZero();
        assertThat(storedFileCount()).isZero();
    }

    @Test
    @DisplayName("未选中的来源与图片不写库：只导出一条任务，其它来源/图片被忽略并给出提示")
    void unreferencedSourcesAndFilesAreNotStored() throws Exception {
        String body = """
                {
                  "sources":[
                    {"sourceRef":"s1","sourceName":"选中的通知","rawText":"要保存","attachmentIndexes":[0]},
                    {"sourceRef":"s2","sourceName":"没选中的通知","rawText":"用户取消了这条","attachmentIndexes":[1]}
                  ],
                  "attachments":[
                    {"fileIndex":0,"originalName":"keep.png"},
                    {"fileIndex":1,"originalName":"drop.png"}
                  ],
                  "tasks":[{"title":"唯一保存的任务","sourceRefs":["s1"]}]
                }
                """;
        MockMultipartHttpServletRequestBuilder request = multipart("/api/tasks/import-notices");
        request.file(new MockMultipartFile("notice", "", MediaType.APPLICATION_JSON_VALUE,
                body.getBytes(StandardCharsets.UTF_8)));
        request.file(new MockMultipartFile("files", "keep.png", MediaType.IMAGE_PNG_VALUE, tinyPng()));
        request.file(new MockMultipartFile("files", "drop.png", MediaType.IMAGE_PNG_VALUE, tinyPng()));

        mvc.perform(request)
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdTasks").value(1))
                .andExpect(jsonPath("$.createdSources").value(1))
                .andExpect(jsonPath("$.createdAttachments").value(1))
                .andExpect(jsonPath("$.notices.length()").value(2));

        assertThat(taskRepository.count()).isEqualTo(1);
        assertThat(sourceRepository.count()).isEqualTo(1);
        assertThat(sourceRepository.findAll().get(0).getSourceName()).isEqualTo("选中的通知");
        assertThat(attachmentRepository.count()).isEqualTo(1);
        assertThat(attachmentRepository.findAll().get(0).getOriginalName()).isEqualTo("keep.png");
        assertThat(storedFileCount()).isEqualTo(1);
    }

    @Test
    @DisplayName("引用校验：不存在的 sourceRef / 越界 fileIndex / 重复 fileIndex / 重复 sourceRef 都是 400 且不落库")
    void referenceValidation() throws Exception {
        // 不存在的来源
        performJson("""
                {"sources":[{"sourceRef":"s1","sourceName":"通知"}],
                 "tasks":[{"title":"任务","sourceRefs":["nope"]}]}
                """).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("tasks[0].sourceRefs"));

        // 声明了 attachments 却一张图都没传：图片下标越界
        performJson("""
                {"sources":[{"sourceRef":"s1","sourceName":"通知","attachmentIndexes":[3]}],
                 "attachments":[{"fileIndex":3,"originalName":"a.png"}],
                 "tasks":[{"title":"任务","sourceRefs":["s1"]}]}
                """).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("attachments[0].fileIndex"));

        // 同一张图声明两次：必须真的传了这两张图，才走得到"重复下标"分支 ——
        // 否则会先被"下标越界"拦下，断言就测不到重复检测本身。报错应定位在真正重复的那条声明上。
        performJsonWithFiles("""
                {"sources":[{"sourceRef":"s1","sourceName":"通知","attachmentIndexes":[0]}],
                 "attachments":[{"fileIndex":0,"originalName":"a.png"},{"fileIndex":0,"originalName":"b.png"}],
                 "tasks":[{"title":"任务","sourceRefs":["s1"]}]}
                """, 2).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("attachments[1].fileIndex"));

        // 来源标识重复
        performJson("""
                {"sources":[{"sourceRef":"s1","sourceName":"A"},{"sourceRef":"s1","sourceName":"B"}],
                 "tasks":[{"title":"任务","sourceRefs":["s1"]}]}
                """).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("sources[1].sourceRef"));

        assertThat(taskRepository.count()).isZero();
        assertThat(sourceRepository.count()).isZero();
        assertThat(attachmentRepository.count()).isZero();
        assertThat(storedFileCount()).isZero();
    }

    @Test
    @DisplayName("数组里的 null 元素、空任务列表、缺来源关联都是 400 而不是 500")
    void nullElementsAndEmptyListsAreBadRequest() throws Exception {
        performJson("""
                {"sources":[null],"tasks":[{"title":"任务","sourceRefs":["s1"]}]}
                """).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));

        performJson("""
                {"sources":[{"sourceRef":"s1","sourceName":"A"}],"attachments":[null],
                 "tasks":[{"title":"任务","sourceRefs":["s1"]}]}
                """).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));

        performJson("""
                {"sources":[{"sourceRef":"s1","sourceName":"A"}],"tasks":[null]}
                """).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));

        performJson("""
                {"sources":[{"sourceRef":"s1","sourceName":"A"}],"tasks":[]}
                """).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("tasks"));

        // 任务没有关联任何来源
        performJson("""
                {"sources":[{"sourceRef":"s1","sourceName":"A"}],"tasks":[{"title":"任务","sourceRefs":[]}]}
                """).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("tasks[0].sourceRefs"));

        // 标题为空
        performJson("""
                {"sources":[{"sourceRef":"s1","sourceName":"A"}],"tasks":[{"title":"  ","sourceRefs":["s1"]}]}
                """).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("tasks[0].title"));

        // 任务类型非法
        performJson("""
                {"sources":[{"sourceRef":"s1","sourceName":"A"}],
                 "tasks":[{"title":"任务","type":"NOT_A_TYPE","sourceRefs":["s1"]}]}
                """).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));

        assertThat(taskRepository.count()).isZero();
        assertThat(sourceRepository.count()).isZero();
    }

    @Test
    @DisplayName("同一次请求内语义字段与来源完全一致的重复候选 → 409（仅请求内去重，不是跨请求幂等）")
    void duplicateCandidateRejected() throws Exception {
        performJson("""
                {"sources":[{"sourceRef":"s1","sourceName":"A"}],
                 "tasks":[
                   {"title":"重复任务","deadline":"2026-10-20T23:00:00+08:00","sourceRefs":["s1"]},
                   {"title":"重复任务","deadline":"2026-10-20T23:00:00+08:00","sourceRefs":["s1"]}
                 ]}
                """).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("RESOURCE_IN_USE"));

        assertThat(taskRepository.count()).isZero();
        assertThat(sourceRepository.count()).isZero();
    }

    @Test
    @DisplayName("同名同截止但课程 / 来源 / 说明不同：四条都写入，不再被误判为重复 409")
    void sameTitleAndDeadlineWithDifferentCourseSourceOrDescriptionIsAllowed() throws Exception {
        long dataStructures = createCourse("CS201", "数据结构");
        long algorithms = createCourse("CS202", "算法设计");

        mvc.perform(multipartJsonWithNoFiles("""
                {"sources":[
                   {"sourceRef":"s1","sourceName":"数据结构课程群","rawText":"第三章作业 10月20日 23:00 前交"},
                   {"sourceRef":"s2","sourceName":"算法课程群","rawText":"第三章作业 10月20日 23:00 前交"}
                 ],
                 "tasks":[
                   {"title":"第三章作业","deadline":"2026-10-20T23:00:00+08:00","courseId":%d,
                    "type":"LAB","sourceRefs":["s1"]},
                   {"title":"第三章作业","deadline":"2026-10-20T23:00:00+08:00","courseId":%d,
                    "type":"LAB","sourceRefs":["s2"]},
                   {"title":"第三章作业","deadline":"2026-10-20T23:00:00+08:00","courseId":%d,
                    "type":"LAB","sourceRefs":["s2"],"description":"补充说明不同"},
                   {"title":"第三章作业","deadline":"2026-10-20T23:00:00+08:00","courseId":%d,
                    "type":"LAB","sourceRefs":["s1"],"description":"只有说明不同"}
                 ]}
                """.formatted(dataStructures, algorithms, dataStructures, dataStructures)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdTasks").value(4))
                .andExpect(jsonPath("$.notices.length()").value(0))
                // 课程确实按各自的 courseId 落库，没有被合并成一条
                .andExpect(jsonPath("$.tasks[0].course.name").value("数据结构"))
                .andExpect(jsonPath("$.tasks[1].course.name").value("算法设计"))
                .andExpect(jsonPath("$.tasks[2].course.name").value("数据结构"))
                .andExpect(jsonPath("$.tasks[3].course.name").value("数据结构"))
                .andExpect(jsonPath("$.tasks[3].description").value("只有说明不同"));

        assertThat(taskRepository.count()).isEqualTo(4);
        // 每条任务各持一份自己的来源记录
        assertThat(sourceRepository.count()).isEqualTo(4);
        assertThat(storedFileCount()).isZero();
    }

    @Test
    @DisplayName("语义字段与来源集合完全一致（含来源书写顺序不同）→ 409 且零副作用")
    void fullyIdenticalCandidatesRejectedWhateverTheSourceOrder() throws Exception {
        long courseId = createCourse("CS201", "数据结构");

        performJson("""
                {"sources":[
                   {"sourceRef":"s1","sourceName":"课程群","rawText":"同一份通知"},
                   {"sourceRef":"s2","sourceName":"教学平台","rawText":"同一份通知"}
                 ],
                 "tasks":[
                   {"title":"实验三","description":"同一段说明","courseId":%d,"type":"LAB","status":"TODO",
                    "deadline":"2026-10-25T22:00:00+08:00","submitRequirement":"实验报告 PDF",
                    "submitMethod":"学习通","sourceRefs":["s1","s2"]},
                   {"title":"实验三","description":"同一段说明","courseId":%d,"type":"LAB","status":"TODO",
                    "deadline":"2026-10-25T22:00:00+08:00","submitRequirement":"实验报告 PDF",
                    "submitMethod":"学习通","sourceRefs":["s2","s1"]}
                 ]}
                """.formatted(courseId, courseId))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("RESOURCE_IN_USE"));

        assertThat(taskRepository.count()).isZero();
        assertThat(sourceRepository.count()).isZero();
        assertThat(attachmentRepository.count()).isZero();
        assertThat(storedFileCount()).isZero();
    }

    @Test
    @DisplayName("副本总字节超 100MiB：落盘与写库之前整体 400 提示分批，且零副作用")
    void storedBytesCapRejectsBeforeAnyWrite() throws Exception {
        // 一张 5MiB 图被 21 条任务引用 → 21 份副本 = 110,100,480 字节 > 100MiB（104,857,600）。
        // 单张 5MiB 与请求体 5MiB 都在既有上限内，被拦下的只能是"副本总量"这一条新上限。
        byte[] fiveMiB = new byte[5 * 1024 * 1024];
        System.arraycopy(tinyPng(), 0, fiveMiB, 0, tinyPng().length);

        StringBuilder taskList = new StringBuilder();
        for (int i = 0; i < 21; i++) {
            if (i > 0) {
                taskList.append(',');
            }
            taskList.append("{\"title\":\"任务").append(i).append("\",\"sourceRefs\":[\"s1\"]}");
        }
        String body = """
                {"sources":[{"sourceRef":"s1","sourceName":"一张图多条任务","attachmentIndexes":[0]}],
                 "attachments":[{"fileIndex":0,"originalName":"大图.png"}],
                 "tasks":[%s]}
                """.formatted(taskList);

        MockMultipartHttpServletRequestBuilder request = multipart("/api/tasks/import-notices");
        request.file(new MockMultipartFile("notice", "", MediaType.APPLICATION_JSON_VALUE,
                body.getBytes(StandardCharsets.UTF_8)));
        request.file(new MockMultipartFile("files", "大图.png", MediaType.IMAGE_PNG_VALUE, fiveMiB));

        mvc.perform(request)
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"))
                .andExpect(jsonPath("$.fieldErrors[0].field").value("attachments"))
                .andExpect(jsonPath("$.fieldErrors[0].message",
                        org.hamcrest.Matchers.containsString("分批")));

        // 零副作用：一张文件都没写，也没有任何任务/来源/附件落库
        assertThat(storedFileCount()).isZero();
        assertThat(taskRepository.count()).isZero();
        assertThat(sourceRepository.count()).isZero();
        assertThat(attachmentRepository.count()).isZero();
    }

    @Test
    @DisplayName("图片数量上限 8：第 9 张 → 400，且不写任何文件")
    void tooManyAttachmentsRejected() throws Exception {
        StringBuilder attachments = new StringBuilder();
        StringBuilder indexes = new StringBuilder();
        for (int i = 0; i < 9; i++) {
            if (i > 0) {
                attachments.append(',');
                indexes.append(',');
            }
            attachments.append("{\"fileIndex\":").append(i).append(",\"originalName\":\"n")
                    .append(i).append(".png\"}");
            indexes.append(i);
        }
        String body = """
                {"sources":[{"sourceRef":"s1","sourceName":"A","attachmentIndexes":[%s]}],
                 "attachments":[%s],
                 "tasks":[{"title":"任务","sourceRefs":["s1"]}]}
                """.formatted(indexes, attachments);

        MockMultipartHttpServletRequestBuilder request = multipart("/api/tasks/import-notices");
        request.file(new MockMultipartFile("notice", "", MediaType.APPLICATION_JSON_VALUE,
                body.getBytes(StandardCharsets.UTF_8)));
        for (int i = 0; i < 9; i++) {
            request.file(new MockMultipartFile("files", "n" + i + ".png", MediaType.IMAGE_PNG_VALUE, tinyPng()));
        }

        mvc.perform(request)
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"))
                // 请求体里声明了 9 张图片，DTO 的 @Size(max = 8) 先拦下（比读取文件更早）
                .andExpect(jsonPath("$.fieldErrors[0].field").value("attachments"));

        assertThat(taskRepository.count()).isZero();
        assertThat(storedFileCount()).isZero();
    }

    @Test
    @DisplayName("只保存粘贴文字（不带任何图片）也能创建任务与原通知")
    void textOnlyImportWorks() throws Exception {
        performJson("""
                {"sources":[{"sourceRef":"t1","sourceName":"班级群文字通知",
                  "rawText":"下周三前把选课确认表交到教务","sourceType":"MANUAL"}],
                 "tasks":[{"title":"交选课确认表","submitMethod":"教务办公室","sourceRefs":["t1"]}]}
                """).andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdTasks").value(1))
                .andExpect(jsonPath("$.createdAttachments").value(0))
                .andExpect(jsonPath("$.attachments.length()").value(0));

        assertThat(taskRepository.count()).isEqualTo(1);
        assertThat(sourceRepository.count()).isEqualTo(1);
        assertThat(attachmentRepository.count()).isZero();
        // 用户确认过的原文必须逐字保留
        assertThat(sourceRepository.findAll().get(0).getRawText()).contains("选课确认表");
    }

    @Test
    @DisplayName("同一张图被两条任务引用：各自持有独立来源与附件，删掉一条任务不影响另一条的原图")
    void sharedImageAcrossTasksStaysIndependent() throws Exception {
        String body = """
                {
                  "sources":[{"sourceRef":"s1","sourceName":"一张图两条任务","attachmentIndexes":[0]}],
                  "attachments":[{"fileIndex":0,"originalName":"共用.png"}],
                  "tasks":[
                    {"title":"任务甲","sourceRefs":["s1"]},
                    {"title":"任务乙","sourceRefs":["s1"]}
                  ]
                }
                """;
        byte[] png = tinyPng();
        MockMultipartHttpServletRequestBuilder request = multipart("/api/tasks/import-notices");
        request.file(new MockMultipartFile("notice", "", MediaType.APPLICATION_JSON_VALUE,
                body.getBytes(StandardCharsets.UTF_8)));
        request.file(new MockMultipartFile("files", "共用.png", MediaType.IMAGE_PNG_VALUE, png));

        JsonNode response = ApiTestSupport.body(mvc.perform(request)
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdTasks").value(2))
                .andExpect(jsonPath("$.createdSources").value(2))
                .andExpect(jsonPath("$.createdAttachments").value(2))
                .andExpect(jsonPath("$.tasks[0].attachments.length()").value(1))
                .andExpect(jsonPath("$.tasks[1].attachments.length()").value(1))
                .andReturn());

        assertThat(taskRepository.count()).isEqualTo(2);
        assertThat(sourceRepository.count()).isEqualTo(2);
        assertThat(attachmentRepository.count()).isEqualTo(2);
        // 两条任务各自持有独立来源与独立落盘文件（删除一条不影响另一条）→ 2 个文件
        assertThat(storedFileCount()).isEqualTo(2);
        long firstAttachmentId = response.get("tasks").get(0).get("attachments").get(0).get("id").asLong();
        long secondAttachmentId = response.get("tasks").get(1).get("attachments").get(0).get("id").asLong();
        assertThat(firstAttachmentId).isNotEqualTo(secondAttachmentId);
        // 不只是 id 不同：两条任务必须各有一份物理文件，磁盘路径不能共用
        assertThat(attachmentRepository.findById(firstAttachmentId).orElseThrow().getRelativePath())
                .isNotEqualTo(attachmentRepository.findById(secondAttachmentId).orElseThrow().getRelativePath());

        // 删掉第一条任务：它的来源与附件一起删除，第二条仍然有自己的原图可下载
        long firstTaskId = response.get("createdTaskIds").get(0).asLong();
        long secondTaskId = response.get("createdTaskIds").get(1).asLong();
        mvc.perform(delete("/api/tasks/{id}", firstTaskId))
                .andExpect(status().isNoContent());

        assertThat(taskRepository.count()).isEqualTo(1);
        assertThat(taskRepository.findById(secondTaskId)).isPresent();
        assertThat(attachmentRepository.findById(secondAttachmentId)).isPresent();
        mvc.perform(get("/api/tasks/{id}", secondTaskId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sourceCount").value(1))
                .andExpect(jsonPath("$.attachments.length()").value(1));
        // 删掉甲之后，乙的原图仍能下载，且字节与上传时完全一致
        byte[] downloadedSecond = mvc.perform(get("/api/attachments/{id}", secondAttachmentId).param("download", "true"))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.IMAGE_PNG))
                .andReturn().getResponse().getContentAsByteArray();
        assertThat(downloadedSecond).isEqualTo(png);
    }

    @Test
    @DisplayName("参数元数据接口暴露真实上限（前端选择图片前先校验）")
    void storageLimitsExposed() throws Exception {
        mvc.perform(get("/api/meta/storage-limits"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.maxAttachments").value(8))
                .andExpect(jsonPath("$.maxFileSizeBytes").value(5L * 1024 * 1024))
                .andExpect(jsonPath("$.maxRequestSizeBytes").value(20L * 1024 * 1024))
                // 新增的"实际写盘副本总量"上限，既有 5MiB 单张 / 20MiB 请求 / 8 张都保持不变
                .andExpect(jsonPath("$.maxImportStoredBytes").value(100L * 1024 * 1024))
                .andExpect(jsonPath("$.allowedContentTypes.length()").value(3));
    }

    // ------------------------------------------------------------------ 工具

    private long createCourse(String code, String name) throws Exception {
        return ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                ApiTestSupport.course(code, name)))
                .andExpect(status().isCreated()).andReturn());
    }

    /** 只发 JSON 部分（不带文件）的便捷入口。 */
    private org.springframework.test.web.servlet.ResultActions performJson(String body) throws Exception {
        return mvc.perform(multipartJsonWithNoFiles(body));
    }

    /** 组装一个只带 notice JSON、不带任何 files 的 multipart 请求。 */
    private MockMultipartHttpServletRequestBuilder multipartJsonWithNoFiles(String body) {
        MockMultipartHttpServletRequestBuilder request = multipart("/api/tasks/import-notices");
        request.file(new MockMultipartFile("notice", "", MediaType.APPLICATION_JSON_VALUE,
                body.getBytes(StandardCharsets.UTF_8)));
        return request;
    }

    /** 带真实上传文件的 JSON 入口：校验"只有真的传了文件才走得到"的分支（如重复图片下标）。 */
    private org.springframework.test.web.servlet.ResultActions performJsonWithFiles(String body, int fileCount)
            throws Exception {
        MockMultipartHttpServletRequestBuilder request = multipart("/api/tasks/import-notices");
        request.file(new MockMultipartFile("notice", "", MediaType.APPLICATION_JSON_VALUE,
                body.getBytes(StandardCharsets.UTF_8)));
        for (int i = 0; i < fileCount; i++) {
            request.file(new MockMultipartFile("files", "f" + i + ".png", MediaType.IMAGE_PNG_VALUE, tinyPng()));
        }
        return mvc.perform(request);
    }

    /** 测试上传目录里真实存在的文件数（按文件系统核算，不依赖数据库）。 */
    private long storedFileCount() throws Exception {
        if (!Files.exists(UPLOAD_DIR)) {
            return 0;
        }
        try (Stream<Path> files = Files.walk(UPLOAD_DIR)) {
            return files.filter(Files::isRegularFile).count();
        }
    }
}
