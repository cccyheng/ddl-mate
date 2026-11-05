package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import com.ddlmate.auth.PasswordHasher;

/**
 * 多用户隔离：A 的数据，B 列表看不到、按 id 读不到、改不了、删不掉，也不能把自己的数据挂到 A 的记录上。
 * 另外覆盖注册规则、注册限流、按用户的课程代码唯一、按用户的备份。
 */
class MultiUserIT extends BaseIntegrationTest {

    private static final AtomicInteger IP = new AtomicInteger(1);

    @DynamicPropertySource
    static void authProperties(DynamicPropertyRegistry registry) {
        // 独立的内存库：启用登录时的启动迁移会改名用户，不能影响其他测试类
        registry.add("spring.datasource.url",
                () -> "jdbc:h2:mem:multiuserit;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        registry.add("ddlmate.auth.enabled", () -> "true");
        registry.add("ddlmate.auth.username", () -> "siteadmin");
        registry.add("ddlmate.auth.password-hash", () -> PasswordHasher.hash("admin-password-1".toCharArray()));
        registry.add("ddlmate.auth.registration-enabled", () -> "true");
        registry.add("ddlmate.auth.registrations-per-ip-per-hour", () -> "2");
        registry.add("ddlmate.auth.registrations-per-day", () -> "1000");
    }

    private static MockHttpServletRequestBuilder site(MockHttpServletRequestBuilder builder, String ip) {
        return builder.with(r -> {
            r.setServerName("example.test");
            r.setRemoteAddr(ip);
            return r;
        }).header("Origin", "http://example.test");
    }

    private static MockHttpServletRequestBuilder as(MockHttpServletRequestBuilder builder, MockHttpSession session) {
        return site(builder, "10.9.9.9").session(session);
    }

    /** 每次用不同来源注册，避免触发同 IP 限流。 */
    private MockHttpSession register(String username) throws Exception {
        String ip = "10.2.0." + IP.incrementAndGet();
        MvcResult result = mvc.perform(ApiTestSupport.json(site(post("/api/auth/register"), ip),
                        "{\"username\":\"%s\",\"password\":\"password-%s-1\"}".formatted(username, username)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.username").value(username))
                .andReturn();
        return (MockHttpSession) result.getRequest().getSession(false);
    }

    private long createIn(MockHttpSession session, MockHttpServletRequestBuilder builder, String body) throws Exception {
        return ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(as(builder, session), body))
                .andExpect(status().isCreated()).andReturn());
    }

    @Test
    @DisplayName("隔离：B 看不到、读不到、改不了、删不掉 A 的课程 / 课表 / 任务 / 原通知 / 附件 / 设置")
    void dataIsIsolatedBetweenUsers() throws Exception {
        MockHttpSession alice = register("alice");
        MockHttpSession bob = register("bob");

        long course = createIn(alice, post("/api/courses"), ApiTestSupport.course("CS201", "数据结构"));
        long schedule = createIn(alice, post("/api/courses/{id}/schedules", course),
                "{\"weekday\":3,\"startTime\":\"14:00\",\"endTime\":\"15:40\"}");
        long task = createIn(alice, post("/api/tasks"),
                ApiTestSupport.task("A 的实验报告", course, "2026-11-20T23:59:00+08:00", "LAB", 4, 90));
        long source = createIn(alice, post("/api/tasks/{id}/sources", task), ApiTestSupport.source("课程群", "A 的通知原文"));
        MvcResult uploaded = mvc.perform(as(multipart("/api/sources/{id}/attachments", source)
                        .file(new MockMultipartFile("file", "a.png", "image/png", tinyPng())), alice))
                .andExpect(status().isCreated()).andReturn();
        long attachment = ApiTestSupport.body(uploaded).get(0).get("id").asLong();
        mvc.perform(ApiTestSupport.json(as(put("/api/settings/{k}", "focus.sessions.v1"), alice),
                "{\"value\":\"A 的专注\",\"expectedRevision\":0}")).andExpect(status().isOk());
        mvc.perform(ApiTestSupport.json(as(put("/api/settings/{k}", "task_steps." + task), alice),
                "{\"value\":\"[]\",\"expectedRevision\":0}")).andExpect(status().isOk());

        // ---- 列表：B 一条都看不到
        mvc.perform(as(get("/api/courses"), bob)).andExpect(jsonPath("$.length()").value(0));
        mvc.perform(as(get("/api/tasks").param("includeDone", "true"), bob)).andExpect(jsonPath("$.totalElements").value(0));
        mvc.perform(as(get("/api/tasks/deadlines"), bob)).andExpect(jsonPath("$.length()").value(0));
        mvc.perform(as(get("/api/tasks/by-date").param("date", "2026-11-20"), bob)).andExpect(jsonPath("$.length()").value(0));
        mvc.perform(as(get("/api/tasks/stats"), bob)).andExpect(jsonPath("$.total").value(0));
        mvc.perform(as(get("/api/sources"), bob)).andExpect(jsonPath("$.length()").value(0));
        mvc.perform(as(get("/api/schedules"), bob)).andExpect(jsonPath("$.length()").value(0));
        mvc.perform(as(get("/api/calendar").param("year", "2026").param("month", "11"), bob))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$..id").isEmpty());
        mvc.perform(as(get("/api/settings/{k}", "focus.sessions.v1"), bob)).andExpect(jsonPath("$.revision").value(0));
        mvc.perform(as(get("/api/settings").param("prefix", "task_steps."), bob)).andExpect(jsonPath("$.length()").value(0));

        // ---- 按 id 读：一律 404
        mvc.perform(as(get("/api/courses/{id}", course), bob)).andExpect(status().isNotFound());
        mvc.perform(as(get("/api/courses/{id}/schedules", course), bob)).andExpect(status().isNotFound());
        mvc.perform(as(get("/api/tasks/{id}", task), bob)).andExpect(status().isNotFound());
        mvc.perform(as(get("/api/tasks/{id}/sources", task), bob)).andExpect(status().isNotFound());
        mvc.perform(as(get("/api/sources/{id}", source), bob)).andExpect(status().isNotFound());
        mvc.perform(as(get("/api/attachments/{id}", attachment), bob)).andExpect(status().isNotFound());

        // ---- 改 / 删：一律 404，A 的数据不变
        mvc.perform(ApiTestSupport.json(as(put("/api/courses/{id}", course), bob), ApiTestSupport.course("XX", "改掉")))
                .andExpect(status().isNotFound());
        mvc.perform(ApiTestSupport.json(as(put("/api/courses/{c}/schedules/{s}", course, schedule), bob),
                "{\"weekday\":1,\"startTime\":\"08:00\",\"endTime\":\"09:00\"}")).andExpect(status().isNotFound());
        mvc.perform(ApiTestSupport.json(as(put("/api/tasks/{id}", task), bob),
                ApiTestSupport.task("改掉", null, null, "OTHER", 3, null))).andExpect(status().isNotFound());
        mvc.perform(ApiTestSupport.json(as(patch("/api/tasks/{id}", task), bob), "{\"title\":\"改掉\"}"))
                .andExpect(status().isNotFound());
        mvc.perform(ApiTestSupport.json(as(patch("/api/tasks/{id}/status", task), bob), "{\"status\":\"DONE\"}"))
                .andExpect(status().isNotFound());
        mvc.perform(as(delete("/api/attachments/{id}", attachment), bob)).andExpect(status().isNotFound());
        mvc.perform(as(delete("/api/sources/{id}", source), bob)).andExpect(status().isNotFound());
        mvc.perform(as(delete("/api/courses/{c}/schedules/{s}", course, schedule), bob)).andExpect(status().isNotFound());
        mvc.perform(as(delete("/api/tasks/{id}", task), bob)).andExpect(status().isNotFound());
        mvc.perform(as(delete("/api/courses/{id}", course).param("force", "true"), bob)).andExpect(status().isNotFound());

        // ---- 不能把自己的数据挂到 A 的记录上
        mvc.perform(ApiTestSupport.json(as(post("/api/tasks"), bob), ApiTestSupport.task("挂到 A 的课", course, null, "OTHER", 3, null)))
                .andExpect(status().isNotFound());
        mvc.perform(ApiTestSupport.json(as(post("/api/courses/{id}/schedules", course), bob),
                "{\"weekday\":2,\"startTime\":\"08:00\",\"endTime\":\"09:00\"}")).andExpect(status().isNotFound());
        mvc.perform(ApiTestSupport.json(as(post("/api/tasks/{id}/sources", task), bob), ApiTestSupport.source("x", "y")))
                .andExpect(status().isNotFound());
        mvc.perform(as(multipart("/api/sources/{id}/attachments", source)
                .file(new MockMultipartFile("file", "b.png", "image/png", tinyPng())), bob)).andExpect(status().isNotFound());

        // ---- A 的数据原样还在
        mvc.perform(as(get("/api/tasks/{id}", task), alice))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("A 的实验报告"))
                .andExpect(jsonPath("$.sourceCount").value(1));
        mvc.perform(as(get("/api/courses/{id}/schedules", course), alice)).andExpect(jsonPath("$.length()").value(1));
        mvc.perform(as(get("/api/settings/{k}", "focus.sessions.v1"), alice)).andExpect(jsonPath("$.value").value("A 的专注"));
        assertThat(asSystem(() -> attachmentRepository.count())).isEqualTo(1);

        // ---- 课程代码按用户唯一：B 也可以用 CS201，同一个人不能重复
        createIn(bob, post("/api/courses"), ApiTestSupport.course("CS201", "B 的数据结构"));
        mvc.perform(ApiTestSupport.json(as(post("/api/courses"), bob), ApiTestSupport.course("cs201", "重复")))
                .andExpect(status().isConflict());
        mvc.perform(as(get("/api/courses"), alice)).andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].name").value("数据结构"));
    }

    @Test
    @DisplayName("备份按用户：只导出自己的；不能用别人的备份覆盖，自己导出的可以恢复")
    void backupIsPerUser() throws Exception {
        MockHttpSession alice = register("carol");
        MockHttpSession bob = register("dave");
        long course = createIn(alice, post("/api/courses"), ApiTestSupport.course("MA102", "线性代数"));
        createIn(alice, post("/api/tasks"), ApiTestSupport.task("C 的作业", course, null, "HOMEWORK", 3, null));
        createIn(bob, post("/api/tasks"), ApiTestSupport.task("D 的作业", null, null, "HOMEWORK", 3, null));

        String aliceBackup = ApiTestSupport.utf8(mvc.perform(as(get("/api/backup/export"), alice))
                .andExpect(jsonPath("$.counts.tasks").value(1))
                .andExpect(jsonPath("$.counts.courses").value(1)).andReturn());
        assertThat(aliceBackup).doesNotContain("D 的作业").doesNotContain("owner_id");

        // D 拿 C 的备份来恢复：编号属于别人，拒绝，D 的数据不动
        mvc.perform(ApiTestSupport.json(as(post("/api/backup/restore"), bob), aliceBackup))
                .andExpect(status().isBadRequest());
        mvc.perform(as(get("/api/tasks"), bob)).andExpect(jsonPath("$.content[0].title").value("D 的作业"));

        // C 删掉自己的数据后用自己的备份恢复：成功，D 的数据不受影响
        mvc.perform(as(delete("/api/courses/{id}", course).param("force", "true"), alice)).andExpect(status().isNoContent());
        mvc.perform(ApiTestSupport.json(as(post("/api/backup/restore"), alice), aliceBackup)).andExpect(status().isOk());
        mvc.perform(as(get("/api/courses"), alice)).andExpect(jsonPath("$[0].name").value("线性代数"));
        mvc.perform(as(get("/api/tasks"), bob)).andExpect(jsonPath("$.totalElements").value(1));
    }

    @Test
    @DisplayName("注册规则：用户名格式、不区分大小写重复、密码长度、同来源限流；站长可登录")
    void registrationRules() throws Exception {
        String ip = "10.3.0.1";
        mvc.perform(ApiTestSupport.json(site(post("/api/auth/register"), ip), "{\"username\":\"a\",\"password\":\"long-enough-1\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(ApiTestSupport.json(site(post("/api/auth/register"), ip), "{\"username\":\"erin\",\"password\":\"short\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(ApiTestSupport.json(site(post("/api/auth/register"), ip), "{\"username\":\"erin\",\"password\":\"long-enough-1\"}"))
                .andExpect(status().isOk());
        mvc.perform(ApiTestSupport.json(site(post("/api/auth/register"), ip), "{\"username\":\"ERIN\",\"password\":\"long-enough-1\"}"))
                .andExpect(status().isBadRequest());
        // 同一来源每小时 2 个（测试配置）：第 3 次被限流
        mvc.perform(ApiTestSupport.json(site(post("/api/auth/register"), ip), "{\"username\":\"frank\",\"password\":\"long-enough-1\"}"))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.code").value("REGISTRATION_LIMITED"));

        mvc.perform(ApiTestSupport.json(site(post("/api/auth/login"), "10.3.0.2"),
                "{\"username\":\"SiteAdmin\",\"password\":\"admin-password-1\"}")).andExpect(status().isOk());
        mvc.perform(ApiTestSupport.json(site(post("/api/auth/login"), "10.3.0.2"),
                "{\"username\":\"erin\",\"password\":\"long-enough-1\"}")).andExpect(status().isOk());
    }
}
