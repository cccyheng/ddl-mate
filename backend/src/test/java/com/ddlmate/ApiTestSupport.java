package com.ddlmate;

import java.nio.charset.StandardCharsets;

import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/** MockMvc 小工具：发送 JSON、读取响应、拼 multipart。 */
public final class ApiTestSupport {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private ApiTestSupport() {
    }

    public static MockHttpServletRequestBuilder json(MockHttpServletRequestBuilder builder, String body) {
        return builder.contentType(MediaType.APPLICATION_JSON).content(body.getBytes(StandardCharsets.UTF_8));
    }

    public static JsonNode body(MvcResult result) throws Exception {
        String content = result.getResponse().getContentAsString(StandardCharsets.UTF_8);
        if (content == null || content.isBlank()) {
            return MAPPER.nullNode();
        }
        return MAPPER.readTree(content);
    }

    public static long idOf(MvcResult result) throws Exception {
        return body(result).get("id").asLong();
    }

    public static String utf8(MvcResult result) throws Exception {
        return result.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    /** 课程 JSON。 */
    public static String course(String code, String name) {
        return """
                {"code":"%s","name":"%s","instructor":"测试老师","semester":"2025-2026 第二学期","color":"#4f7cff"}
                """.formatted(code, name);
    }

    /** 任务 JSON。deadline 传 null 表示不设截止时间。 */
    public static String task(String title, Long courseId, String deadline, String type, Integer priority,
            Integer estimatedMinutes) {
        return """
                {"title":"%s","description":"集成测试任务","courseId":%s,"type":"%s","priority":%s,
                 "deadline":%s,"estimatedMinutes":%s,"submitRequirement":"源代码+报告","submitMethod":"学习通"}
                """.formatted(title, courseId == null ? "null" : courseId, type,
                priority == null ? "null" : priority,
                deadline == null ? "null" : "\"" + deadline + "\"",
                estimatedMinutes == null ? "null" : estimatedMinutes);
    }

    public static String source(String sourceName, String rawText) {
        return """
                {"sourceName":"%s","sourceType":"WECHAT_GROUP","rawText":"%s","capturedAt":"2026-10-05T20:31:00+08:00"}
                """.formatted(sourceName, rawText);
    }

    /** 基础课表 JSON（不带教学周信息，兼容旧行为）。 */
    public static String schedule(int weekday, String startTime, String endTime, String location) {
        return """
                {"weekday":%d,"startTime":"%s","endTime":"%s","location":%s}
                """.formatted(weekday, startTime, endTime, location == null ? "null" : "\"" + location + "\"");
    }

    /** 带教学周规则的课表 JSON。weeks/pattern/semesterStart 均可为 null。 */
    public static String scheduleWithWeeks(int weekday, String startTime, String endTime, String location,
            String weekPattern, String semesterStartDate, Integer startWeek, Integer endWeek) {
        return """
                {"weekday":%d,"startTime":"%s","endTime":"%s","location":%s,
                 "weekPattern":%s,"semesterStartDate":%s,"startWeek":%s,"endWeek":%s}
                """.formatted(weekday, startTime, endTime,
                location == null ? "null" : "\"" + location + "\"",
                weekPattern == null ? "null" : "\"" + weekPattern + "\"",
                semesterStartDate == null ? "null" : "\"" + semesterStartDate + "\"",
                startWeek == null ? "null" : startWeek,
                endWeek == null ? "null" : endWeek);
    }

    public static MockMvc mockMvc(MockMvc mvc) {
        return mvc;
    }
}
