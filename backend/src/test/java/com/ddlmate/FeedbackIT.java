package com.ddlmate;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import com.ddlmate.auth.PasswordHasher;
import com.ddlmate.repository.FeedbackRepository;
import com.ddlmate.service.FeedbackService;

/** 问题反馈：用户提交并只能看自己的；只有站长能看全部、标记处理和回复。 */
class FeedbackIT extends BaseIntegrationTest {

    private static final AtomicInteger IP = new AtomicInteger(1);

    @Autowired
    FeedbackRepository feedbackRepository;

    @BeforeEach
    void clearFeedback() {
        feedbackRepository.deleteAll();
    }

    @DynamicPropertySource
    static void authProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url",
                () -> "jdbc:h2:mem:feedbackit;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        registry.add("ddlmate.auth.enabled", () -> "true");
        registry.add("ddlmate.auth.username", () -> "siteadmin");
        registry.add("ddlmate.auth.password-hash", () -> PasswordHasher.hash("admin-password-1".toCharArray()));
        registry.add("ddlmate.auth.registration-enabled", () -> "true");
        registry.add("ddlmate.auth.registrations-per-ip-per-hour", () -> "5");
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
        return site(builder, "10.8.8.8").session(session);
    }

    private MockHttpSession register(String username) throws Exception {
        MvcResult result = mvc.perform(ApiTestSupport.json(site(post("/api/auth/register"), "10.3.0." + IP.incrementAndGet()),
                        "{\"username\":\"%s\",\"password\":\"password-%s-1\"}".formatted(username, username)))
                .andExpect(status().isOk()).andReturn();
        return (MockHttpSession) result.getRequest().getSession(false);
    }

    private MockHttpSession admin() throws Exception {
        MvcResult result = mvc.perform(ApiTestSupport.json(site(post("/api/auth/login"), "10.3.9.9"),
                        "{\"username\":\"siteadmin\",\"password\":\"admin-password-1\"}"))
                .andExpect(status().isOk()).andReturn();
        return (MockHttpSession) result.getRequest().getSession(false);
    }

    @Test
    @DisplayName("用户提交反馈只能看到自己的；站长看到全部、能回复；用户看到回复")
    void usersSubmitAndAdminSeesAll() throws Exception {
        MockHttpSession carol = register("carol");
        MockHttpSession dave = register("dave");

        mvc.perform(ApiTestSupport.json(as(post("/api/feedback"), carol),
                        "{\"category\":\"bug\",\"content\":\"课表导入按钮没反应\",\"contact\":\"QQ 123\",\"page\":\"/courses/import-schedule\"}")
                        .header("User-Agent", "TestBrowser/1.0"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.category").value("BUG"))
                .andExpect(jsonPath("$.status").value("NEW"))
                .andExpect(jsonPath("$.username").value("carol"));
        mvc.perform(ApiTestSupport.json(as(post("/api/feedback"), dave), "{\"category\":\"SUGGESTION\",\"content\":\"希望能导入考试\"}"))
                .andExpect(status().isCreated());

        // 普通用户：只能看到自己的，不能访问站长接口
        mvc.perform(as(get("/api/feedback/mine"), carol))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].content").value("课表导入按钮没反应"));
        mvc.perform(as(get("/api/feedback/role"), carol)).andExpect(jsonPath("$.admin").value(false));
        mvc.perform(as(get("/api/admin/feedback"), carol))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));

        // 站长：看到全部和未读数，回复后用户能看到
        MockHttpSession admin = admin();
        mvc.perform(as(get("/api/feedback/role"), admin))
                .andExpect(jsonPath("$.admin").value(true))
                .andExpect(jsonPath("$.unread").value(2));
        MvcResult all = mvc.perform(as(get("/api/admin/feedback"), admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[1].userAgent").value("TestBrowser/1.0"))
                .andExpect(jsonPath("$[1].page").value("/courses/import-schedule"))
                .andReturn();
        long carolsId = ApiTestSupport.body(all).get(1).get("id").asLong();
        mvc.perform(ApiTestSupport.json(as(patch("/api/admin/feedback/{id}", carolsId), admin),
                        "{\"reply\":\"已修复，刷新页面即可\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("READ"));
        mvc.perform(ApiTestSupport.json(as(patch("/api/admin/feedback/{id}", carolsId), admin), "{\"status\":\"DONE\"}"))
                .andExpect(jsonPath("$.status").value("DONE"));
        mvc.perform(as(get("/api/admin/feedback").param("status", "NEW"), admin))
                .andExpect(jsonPath("$.length()").value(1));
        mvc.perform(as(get("/api/feedback/mine"), carol))
                .andExpect(jsonPath("$[0].reply").value("已修复，刷新页面即可"))
                .andExpect(jsonPath("$[0].status").value("DONE"));

        // 普通用户不能改别人的状态
        mvc.perform(ApiTestSupport.json(as(patch("/api/admin/feedback/{id}", carolsId), dave), "{\"status\":\"NEW\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    @DisplayName("校验与限流：空内容 / 超长 / 非法类型 → 400；24 小时内超过上限 → 409")
    void validationAndRateLimit() throws Exception {
        MockHttpSession erin = register("erin");
        mvc.perform(ApiTestSupport.json(as(post("/api/feedback"), erin), "{\"content\":\"   \"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(ApiTestSupport.json(as(post("/api/feedback"), erin), "{\"category\":\"SPAM\",\"content\":\"x\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(ApiTestSupport.json(as(post("/api/feedback"), erin), "{\"content\":\"" + "长".repeat(2001) + "\"}"))
                .andExpect(status().isBadRequest());
        for (int i = 0; i < FeedbackService.MAX_PER_DAY; i++) {
            mvc.perform(ApiTestSupport.json(as(post("/api/feedback"), erin), "{\"content\":\"第 " + i + " 条\"}"))
                    .andExpect(status().isCreated());
        }
        mvc.perform(ApiTestSupport.json(as(post("/api/feedback"), erin), "{\"content\":\"再来一条\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("FEEDBACK_LIMITED"));
        // 未登录不能提交
        mvc.perform(ApiTestSupport.json(site(post("/api/feedback"), "10.3.7.7"), "{\"content\":\"匿名\"}"))
                .andExpect(status().isUnauthorized());
    }
}
