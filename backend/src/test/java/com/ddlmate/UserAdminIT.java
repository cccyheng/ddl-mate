package com.ddlmate;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import com.ddlmate.auth.PasswordHasher;
import com.fasterxml.jackson.databind.JsonNode;

/** 用户管理：注册时间 / 登录记录 / 数据量；封号后不能登录、已登录会话立即失效；解封恢复。 */
class UserAdminIT extends BaseIntegrationTest {

    private static final AtomicInteger IP = new AtomicInteger(1);

    @DynamicPropertySource
    static void authProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url",
                () -> "jdbc:h2:mem:useradminit;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
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
        }).header("Origin", "http://example.test").header("User-Agent", "TestBrowser/2.0");
    }

    private static MockHttpServletRequestBuilder as(MockHttpServletRequestBuilder builder, MockHttpSession session) {
        return site(builder, "10.6.6.6").session(session);
    }

    private MockHttpSession register(String username) throws Exception {
        MvcResult result = mvc.perform(ApiTestSupport.json(site(post("/api/auth/register"), "10.6.0." + IP.incrementAndGet()),
                        "{\"username\":\"%s\",\"password\":\"password-%s-1\"}".formatted(username, username)))
                .andExpect(status().isOk()).andReturn();
        return (MockHttpSession) result.getRequest().getSession(false);
    }

    private ResultActions login(String username, String password) throws Exception {
        return mvc.perform(ApiTestSupport.json(site(post("/api/auth/login"), "10.6.9." + IP.incrementAndGet()),
                "{\"username\":\"%s\",\"password\":\"%s\"}".formatted(username, password)));
    }

    private MockHttpSession admin() throws Exception {
        return (MockHttpSession) login("siteadmin", "admin-password-1").andExpect(status().isOk())
                .andReturn().getRequest().getSession(false);
    }

    private JsonNode rowOf(MockHttpSession admin, String username) throws Exception {
        JsonNode list = ApiTestSupport.body(mvc.perform(as(get("/api/admin/users"), admin))
                .andExpect(status().isOk()).andReturn());
        for (JsonNode row : list) {
            if (row.get("username").asText().equals(username)) {
                return row;
            }
        }
        throw new AssertionError("列表里没有 " + username);
    }

    @Test
    @DisplayName("用户列表：注册时间、最近登录、登录次数、数据量；登录记录带时间 / IP / 浏览器")
    void listShowsRegistrationAndLogins() throws Exception {
        MockHttpSession kate = register("kate");
        mvc.perform(ApiTestSupport.json(as(post("/api/courses"), kate), ApiTestSupport.course("K1", "课程一")))
                .andExpect(status().isCreated());
        login("kate", "password-kate-1").andExpect(status().isOk());
        login("kate", "wrong-password").andExpect(status().isUnauthorized());

        MockHttpSession admin = admin();
        JsonNode row = rowOf(admin, "kate");
        org.assertj.core.api.Assertions.assertThat(row.get("createdAt").asText()).isNotBlank();
        org.assertj.core.api.Assertions.assertThat(row.get("lastLoginAt").asText()).isNotBlank();
        org.assertj.core.api.Assertions.assertThat(row.get("loginCount").asLong()).isEqualTo(2); // 注册 + 一次登录（失败的不算）
        org.assertj.core.api.Assertions.assertThat(row.get("courses").asLong()).isEqualTo(1);
        org.assertj.core.api.Assertions.assertThat(row.get("disabled").asBoolean()).isFalse();

        mvc.perform(as(get("/api/admin/users/{id}/logins", row.get("id").asLong()), admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].kind").value("LOGIN"))
                .andExpect(jsonPath("$[1].kind").value("REGISTER"))
                .andExpect(jsonPath("$[0].userAgent").value("TestBrowser/2.0"))
                .andExpect(jsonPath("$[0].ip").isNotEmpty());

        // 普通用户不能看
        mvc.perform(as(get("/api/admin/users"), kate)).andExpect(status().isForbidden());
    }

    @Test
    @DisplayName("封号：不能登录（密码对才告知已封禁），已登录会话立即失效；不能封站长；解封后恢复")
    void banAndUnban() throws Exception {
        MockHttpSession leo = register("leo");
        MockHttpSession admin = admin();
        long leoId = rowOf(admin, "leo").get("id").asLong();

        mvc.perform(ApiTestSupport.json(as(post("/api/admin/users/{id}/ban", leoId), admin), "{\"reason\":\"发布广告\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.disabled").value(true))
                .andExpect(jsonPath("$.disabledReason").value("发布广告"));

        mvc.perform(as(get("/api/courses"), leo)).andExpect(status().isUnauthorized());
        login("leo", "password-leo-1").andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("ACCOUNT_DISABLED"))
                .andExpect(jsonPath("$.message", org.hamcrest.Matchers.containsString("发布广告")));
        login("leo", "wrong-password").andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("LOGIN_FAILED"));

        long adminId = rowOf(admin, "siteadmin").get("id").asLong();
        mvc.perform(ApiTestSupport.json(as(post("/api/admin/users/{id}/ban", adminId), admin), "{}"))
                .andExpect(status().isForbidden());
        MockHttpSession other = register("mia");
        mvc.perform(ApiTestSupport.json(as(post("/api/admin/users/{id}/ban", leoId), other), "{}"))
                .andExpect(status().isForbidden());

        mvc.perform(as(post("/api/admin/users/{id}/unban", leoId), admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.disabled").value(false));
        login("leo", "password-leo-1").andExpect(status().isOk());
    }
}
