package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import com.ddlmate.auth.PasswordHasher;
import com.ddlmate.common.TimeZones;

/** 修改密码、忘记密码（站长发临时密码 → 强制改密码）、注销账号（删除全部数据、其他会话立即失效）。 */
class AccountIT extends BaseIntegrationTest {

    private static final AtomicInteger IP = new AtomicInteger(1);

    @Autowired
    JdbcTemplate jdbc;

    @DynamicPropertySource
    static void authProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url",
                () -> "jdbc:h2:mem:accountit;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        registry.add("ddlmate.auth.enabled", () -> "true");
        registry.add("ddlmate.auth.username", () -> "siteadmin");
        registry.add("ddlmate.auth.password-hash", () -> PasswordHasher.hash("admin-password-1".toCharArray()));
        registry.add("ddlmate.auth.registration-enabled", () -> "true");
        registry.add("ddlmate.auth.registrations-per-ip-per-hour", () -> "5");
        registry.add("ddlmate.auth.registrations-per-day", () -> "1000");
        registry.add("ddlmate.auth.max-failures", () -> "50");
    }

    private static MockHttpServletRequestBuilder site(MockHttpServletRequestBuilder builder, String ip) {
        return builder.with(r -> {
            r.setServerName("example.test");
            r.setRemoteAddr(ip);
            return r;
        }).header("Origin", "http://example.test");
    }

    private static MockHttpServletRequestBuilder as(MockHttpServletRequestBuilder builder, MockHttpSession session) {
        return site(builder, "10.7.7.7").session(session);
    }

    private MockHttpSession register(String username, String password) throws Exception {
        MvcResult result = mvc.perform(ApiTestSupport.json(site(post("/api/auth/register"), "10.4.0." + IP.incrementAndGet()),
                        "{\"username\":\"%s\",\"password\":\"%s\"}".formatted(username, password)))
                .andExpect(status().isOk()).andReturn();
        return (MockHttpSession) result.getRequest().getSession(false);
    }

    private ResultActions login(String username, String password) throws Exception {
        return mvc.perform(ApiTestSupport.json(site(post("/api/auth/login"), "10.4.9." + IP.incrementAndGet()),
                "{\"username\":\"%s\",\"password\":\"%s\"}".formatted(username, password)));
    }

    private MockHttpSession sessionOf(ResultActions actions) {
        return (MockHttpSession) actions.andReturn().getRequest().getSession(false);
    }

    @Test
    @DisplayName("修改密码：旧密码错 → 400；新密码太短 → 400；成功后旧密码不能再登录")
    void changePassword() throws Exception {
        MockHttpSession frank = register("frank", "frank-password-1");
        mvc.perform(ApiTestSupport.json(as(post("/api/auth/password"), frank),
                        "{\"oldPassword\":\"wrong-password\",\"newPassword\":\"frank-password-2\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(ApiTestSupport.json(as(post("/api/auth/password"), frank),
                        "{\"oldPassword\":\"frank-password-1\",\"newPassword\":\"short\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(ApiTestSupport.json(as(post("/api/auth/password"), frank),
                        "{\"oldPassword\":\"frank-password-1\",\"newPassword\":\"frank-password-2\"}"))
                .andExpect(status().isOk());
        login("frank", "frank-password-1").andExpect(status().isUnauthorized());
        login("frank", "frank-password-2").andExpect(status().isOk());
    }

    @Test
    @DisplayName("忘记密码：匿名申请不透露用户名是否存在；站长发临时密码；登录后必须先改密码")
    void forgotPasswordFlow() throws Exception {
        register("grace", "grace-password-1");
        String expected = "已提交。站长核对后会通过你留的联系方式发给你临时密码。";
        mvc.perform(ApiTestSupport.json(site(post("/api/auth/reset-request"), "10.5.0.1"),
                        "{\"username\":\"grace\",\"contact\":\"QQ 10001\",\"note\":\"换手机忘了\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.message").value(expected));
        mvc.perform(ApiTestSupport.json(site(post("/api/auth/reset-request"), "10.5.0.2"),
                        "{\"username\":\"nobody-here\",\"contact\":\"QQ 10002\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.message").value(expected));
        mvc.perform(ApiTestSupport.json(site(post("/api/auth/reset-request"), "10.5.0.3"), "{\"username\":\"grace\"}"))
                .andExpect(status().isBadRequest());

        MockHttpSession admin = sessionOf(login("siteadmin", "admin-password-1").andExpect(status().isOk()));
        mvc.perform(as(get("/api/feedback/role"), admin)).andExpect(jsonPath("$.resetPending").value(2));
        MvcResult list = mvc.perform(as(get("/api/admin/reset-requests"), admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].accountExists").value(false))
                .andExpect(jsonPath("$[1].accountExists").value(true))
                .andReturn();
        long missingId = ApiTestSupport.body(list).get(0).get("id").asLong();
        long graceId = ApiTestSupport.body(list).get(1).get("id").asLong();
        mvc.perform(as(post("/api/admin/reset-requests/{id}/issue", missingId), admin)).andExpect(status().isBadRequest());
        MvcResult issued = mvc.perform(as(post("/api/admin/reset-requests/{id}/issue", graceId), admin))
                .andExpect(status().isOk()).andReturn();
        String temp = ApiTestSupport.body(issued).get("tempPassword").asText();
        assertThat(temp).matches("[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}");

        // 普通用户不能处理申请
        MockHttpSession other = register("henry", "henry-password-1");
        mvc.perform(as(get("/api/admin/reset-requests"), other)).andExpect(status().isForbidden());

        login("grace", "grace-password-1").andExpect(status().isUnauthorized());
        MockHttpSession grace = sessionOf(login("grace", temp).andExpect(status().isOk())
                .andExpect(jsonPath("$.mustChangePassword").value(true)));
        mvc.perform(as(get("/api/auth/me"), grace)).andExpect(jsonPath("$.mustChangePassword").value(true));
        mvc.perform(as(get("/api/courses"), grace))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("PASSWORD_CHANGE_REQUIRED"));
        mvc.perform(ApiTestSupport.json(as(post("/api/auth/password"), grace),
                        "{\"oldPassword\":\"%s\",\"newPassword\":\"grace-password-9\"}".formatted(temp)))
                .andExpect(status().isOk());
        mvc.perform(as(get("/api/courses"), grace)).andExpect(status().isOk());
        login("grace", "grace-password-9").andExpect(jsonPath("$.mustChangePassword").value(false));
    }

    @Test
    @DisplayName("临时密码 24 小时后失效")
    void expiredTempPassword() throws Exception {
        register("ivan", "ivan-password-1");
        mvc.perform(ApiTestSupport.json(site(post("/api/auth/reset-request"), "10.5.1.1"),
                "{\"username\":\"ivan\",\"contact\":\"微信 ivan\"}")).andExpect(status().isOk());
        MockHttpSession admin = sessionOf(login("siteadmin", "admin-password-1"));
        long id = ApiTestSupport.body(mvc.perform(as(get("/api/admin/reset-requests"), admin)).andReturn()).get(0).get("id").asLong();
        String temp = ApiTestSupport.body(mvc.perform(as(post("/api/admin/reset-requests/{id}/issue", id), admin)).andReturn())
                .get("tempPassword").asText();
        jdbc.update("UPDATE app_users SET temp_password_expires_at = ? WHERE username = 'ivan'",
                TimeZones.now().minusHours(1));
        login("ivan", temp).andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.message", org.hamcrest.Matchers.containsString("已过期")));
    }

    @Test
    @DisplayName("注销账号：删除这个账号的全部数据和账号本身，其他设备的会话立即失效；站长不能注销")
    void deleteAccount() throws Exception {
        MockHttpSession judy = register("judy", "judy-password-1");
        MockHttpSession judyPhone = sessionOf(login("judy", "judy-password-1"));
        long course = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(as(post("/api/courses"), judy),
                ApiTestSupport.course("CS101", "离散数学"))).andExpect(status().isCreated()).andReturn());
        mvc.perform(ApiTestSupport.json(as(post("/api/courses/{id}/schedules", course), judy),
                "{\"weekday\":2,\"startTime\":\"08:00\",\"endTime\":\"09:35\"}")).andExpect(status().isCreated());
        mvc.perform(ApiTestSupport.json(as(post("/api/tasks"), judy),
                ApiTestSupport.task("作业一", course, "2026-11-20T23:59:00+08:00", "HOMEWORK", 3, 60)))
                .andExpect(status().isCreated());
        mvc.perform(ApiTestSupport.json(as(put("/api/settings/{key}", "focus.sessions.v1"), judy),
                "{\"value\":\"{}\",\"expectedRevision\":0}"));
        mvc.perform(ApiTestSupport.json(as(post("/api/feedback"), judy), "{\"content\":\"很好用\"}")).andExpect(status().isCreated());
        long judyId = jdbc.queryForObject("SELECT id FROM app_users WHERE username = 'judy'", Long.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM tasks WHERE owner_id = ?", Long.class, judyId)).isEqualTo(1);

        mvc.perform(ApiTestSupport.json(as(post("/api/auth/delete-account"), judy),
                "{\"password\":\"judy-password-1\",\"confirmUsername\":\"someone\"}")).andExpect(status().isBadRequest());
        mvc.perform(ApiTestSupport.json(as(post("/api/auth/delete-account"), judy),
                "{\"password\":\"wrong-password\",\"confirmUsername\":\"judy\"}")).andExpect(status().isBadRequest());
        mvc.perform(ApiTestSupport.json(as(post("/api/auth/delete-account"), judy),
                "{\"password\":\"judy-password-1\",\"confirmUsername\":\"judy\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.deleted").value(true));

        for (String table : new String[] { "courses", "course_schedules", "tasks", "task_sources", "attachments", "user_settings" }) {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE owner_id = ?", Long.class, judyId))
                    .as(table).isZero();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM feedback WHERE user_id = ?", Long.class, judyId)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM app_users WHERE id = ?", Long.class, judyId)).isZero();
        // 另一台设备上的会话：立即失效，绝不会落到别的账号
        mvc.perform(as(get("/api/courses"), judyPhone)).andExpect(status().isUnauthorized());
        mvc.perform(as(get("/api/profile"), judyPhone)).andExpect(status().isUnauthorized());
        login("judy", "judy-password-1").andExpect(status().isUnauthorized());

        MockHttpSession admin = sessionOf(login("siteadmin", "admin-password-1"));
        mvc.perform(ApiTestSupport.json(as(post("/api/auth/delete-account"), admin),
                "{\"password\":\"admin-password-1\",\"confirmUsername\":\"siteadmin\"}")).andExpect(status().isForbidden());
        login("siteadmin", "admin-password-1").andExpect(status().isOk());
    }
}
