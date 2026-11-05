package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import com.ddlmate.auth.PasswordHasher;

/** 启用单人登录后：未登录拒绝、密码错误、连续失败锁定、跨站写请求拒绝、登录 / 退出。 */
class AuthIT extends BaseIntegrationTest {

    private static final String PASSWORD = "correct horse battery";

    @DynamicPropertySource
    static void authProperties(DynamicPropertyRegistry registry) {
        // 独立的内存库：启用登录时的启动迁移会改名用户，不能影响其他测试类
        registry.add("spring.datasource.url",
                () -> "jdbc:h2:mem:authit;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        registry.add("ddlmate.auth.enabled", () -> "true");
        registry.add("ddlmate.auth.username", () -> "chen");
        registry.add("ddlmate.auth.password-hash", () -> PasswordHasher.hash(PASSWORD.toCharArray()));
        registry.add("ddlmate.auth.max-failures", () -> "3");
    }

    /** 浏览器同源写请求：本站主机名 + 同主机的 Origin（真实 Tomcat 的主机名来自 Host 头）。 */
    private static MockHttpServletRequestBuilder sameSite(MockHttpServletRequestBuilder builder) {
        return onSite(builder).header("Origin", "http://example.test");
    }

    private static MockHttpServletRequestBuilder onSite(MockHttpServletRequestBuilder builder) {
        return builder.with(r -> {
            r.setServerName("example.test");
            return r;
        });
    }

    private static String login(String user, String password) {
        return "{\"username\":\"%s\",\"password\":\"%s\"}".formatted(user, password);
    }

    @Test
    @DisplayName("未登录访问接口返回 401；页面本身可以打开；H2 控制台不可用")
    void anonymousBlocked() throws Exception {
        mvc.perform(get("/api/tasks")).andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHENTICATED"));
        mvc.perform(get("/api/backup/export")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/auth/me")).andExpect(status().isOk())
                .andExpect(jsonPath("$.authEnabled").value(true))
                .andExpect(jsonPath("$.authenticated").value(false));
        mvc.perform(get("/h2-console")).andExpect(status().isNotFound());
    }

    @Test
    @DisplayName("登录成功后会话可访问接口，退出后失效")
    void loginAndLogout() throws Exception {
        MvcResult result = mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/login")), login("chen", PASSWORD)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.username").value("chen"))
                .andReturn();
        MockHttpSession session = (MockHttpSession) result.getRequest().getSession(false);
        assertThat(session).isNotNull();

        mvc.perform(get("/api/tasks").session(session)).andExpect(status().isOk());
        mvc.perform(ApiTestSupport.json(sameSite(post("/api/courses")).session(session),
                ApiTestSupport.course("CS201", "数据结构"))).andExpect(status().isCreated());

        mvc.perform(sameSite(post("/api/auth/logout")).session(session)).andExpect(status().isNoContent());
        mvc.perform(get("/api/tasks").session(session)).andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("密码错误返回 401；连续失败达到上限后锁定，正确密码也暂时不能登录")
    void wrongPasswordAndLockout() throws Exception {
        for (int i = 0; i < 2; i++) {
            mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/login")), login("chen", "nope"))
                    .with(r -> { r.setRemoteAddr("10.0.0.7"); return r; }))
                    .andExpect(status().isUnauthorized())
                    .andExpect(jsonPath("$.code").value("LOGIN_FAILED"));
        }
        mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/login")), login("chen", "nope"))
                .with(r -> { r.setRemoteAddr("10.0.0.7"); return r; }))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.code").value("LOGIN_LOCKED"));
        mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/login")), login("chen", PASSWORD))
                .with(r -> { r.setRemoteAddr("10.0.0.7"); return r; }))
                .andExpect(status().isTooManyRequests());
        // 其他来源不受影响
        mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/login")), login("chen", PASSWORD))
                .with(r -> { r.setRemoteAddr("10.0.0.8"); return r; }))
                .andExpect(status().isOk());
    }

    @Test
    @DisplayName("写请求的 Origin 与本站不一致（或缺失）时拒绝，即使已登录")
    void crossSiteWriteRejected() throws Exception {
        MvcResult result = mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/login")), login("chen", PASSWORD)))
                .andExpect(status().isOk()).andReturn();
        MockHttpSession session = (MockHttpSession) result.getRequest().getSession(false);

        mvc.perform(ApiTestSupport.json(onSite(post("/api/courses")).session(session)
                        .header("Origin", "https://evil.test"),
                ApiTestSupport.course("MA102", "线性代数")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN_ORIGIN"));
        mvc.perform(ApiTestSupport.json(onSite(post("/api/courses")).session(session),
                ApiTestSupport.course("MA102", "线性代数")))
                .andExpect(status().isForbidden());
        assertThat(asSystem(() -> courseRepository.count())).isZero();
    }
}
