package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import com.ddlmate.repository.AppUserRepository;

/** 一次性设置码：错误计数、成功后直接登录、不能重复使用、备份里不带密码哈希。 */
class AuthSetupIT extends BaseIntegrationTest {

    private static final String TOKEN = "setup-token-0123456789-abcdef";

    @Autowired
    AppUserRepository userRepository;

    @DynamicPropertySource
    static void authProperties(DynamicPropertyRegistry registry) {
        // 独立的内存库：启用登录时的启动迁移会改名用户，不能影响其他测试类
        registry.add("spring.datasource.url",
                () -> "jdbc:h2:mem:authsetupit;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        registry.add("ddlmate.auth.enabled", () -> "true");
        registry.add("ddlmate.auth.username", () -> "siteadmin");
        registry.add("ddlmate.auth.password-hash", () -> "");
        registry.add("ddlmate.auth.setup-token", () -> TOKEN);
        registry.add("ddlmate.auth.max-failures", () -> "3");
    }

    private static MockHttpServletRequestBuilder sameSite(MockHttpServletRequestBuilder builder, String ip) {
        return builder.with(r -> {
            r.setServerName("example.test");
            r.setRemoteAddr(ip);
            return r;
        }).header("Origin", "http://example.test");
    }

    private static String setup(String token, String password) {
        return "{\"token\":\"%s\",\"password\":\"%s\"}".formatted(token, password);
    }

    @Test
    @DisplayName("设置码：错误被拒并计入锁定；正确则设置密码并直接登录；之后不能再用；新密码可登录")
    void setupFlow() throws Exception {
        var admin = userRepository.findByUsernameIgnoreCase("siteadmin").orElseThrow();
        admin.setPasswordHash(null);
        userRepository.save(admin);
        mvc.perform(get("/api/auth/me")).andExpect(jsonPath("$.setupAvailable").value(true));

        mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/setup"), "10.1.0.1"), setup("wrong", "a-new-password-1")))
                .andExpect(status().isForbidden());
        mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/setup"), "10.1.0.1"), setup(TOKEN, "short")))
                .andExpect(status().isBadRequest());

        MvcResult done = mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/setup"), "10.1.0.2"),
                        setup(TOKEN, "a-new-password-1")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.authenticated").value(true))
                .andReturn();
        MockHttpSession session = (MockHttpSession) done.getRequest().getSession(false);
        mvc.perform(get("/api/tasks").session(session)).andExpect(status().isOk());
        assertThat(userRepository.findByUsernameIgnoreCase("siteadmin").orElseThrow().getPasswordHash()).startsWith("pbkdf2$");

        // 设置码已作废
        mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/setup"), "10.1.0.3"), setup(TOKEN, "another-password-2")))
                .andExpect(status().isNotFound());
        mvc.perform(get("/api/auth/me")).andExpect(jsonPath("$.setupAvailable").value(false));

        // 新密码可以登录，备份里没有密码哈希
        MvcResult login = mvc.perform(ApiTestSupport.json(sameSite(post("/api/auth/login"), "10.1.0.4"),
                        "{\"username\":\"siteadmin\",\"password\":\"a-new-password-1\"}"))
                .andExpect(status().isOk()).andReturn();
        MockHttpSession again = (MockHttpSession) login.getRequest().getSession(false);
        String backup = ApiTestSupport.utf8(mvc.perform(get("/api/backup/export").session(again))
                .andExpect(status().isOk()).andReturn());
        assertThat(backup).doesNotContain("pbkdf2$").doesNotContain("password_hash");
    }
}
