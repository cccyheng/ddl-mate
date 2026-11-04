package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.contains;
import static org.hamcrest.Matchers.not;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.DayOfWeek;
import java.time.LocalDate;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.ddlmate.common.TimeZones;

/** 单双周 / 教学周在真实接口上的行为（含校验边界与旧数据兼容）。 */
class ScheduleWeekPatternIT extends BaseIntegrationTest {

    /** 2026-09-07 是周一：第 1 周 9/7，第 2 周 9/14，第 3 周 9/21，第 5 周 10/5。 */
    private static final String SEMESTER_START = "2026-09-07";

    @Test
    @DisplayName("单周课表只在奇数教学周出现")
    void oddPatternOnlyOddWeeks() throws Exception {
        long courseId = createCourse("MA102", "线性代数");
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "10:10", "11:50", "教二 108", "ODD", SEMESTER_START, 1, 5)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.weekPattern").value("ODD"))
                .andExpect(jsonPath("$.weekPatternLabel").value("单周"))
                .andExpect(jsonPath("$.startWeek").value(1))
                .andExpect(jsonPath("$.endWeek").value(5))
                .andExpect(jsonPath("$.teachingWeeksConfigured").value(true))
                .andExpect(jsonPath("$.weekSummary").value("第 1-5 周 · 单周"));

        mvc.perform(get("/api/schedules/by-date").param("date", "2026-09-07"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(1));
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-09-14"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(0));
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-09-21"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(1));
        // 第 5 周在内，第 6 周超出结束周
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-10-05"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(1));
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-10-12"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(0));
        // 学期之前
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-08-31"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(0));
    }

    @Test
    @DisplayName("双周课表只在偶数教学周出现")
    void evenPatternOnlyEvenWeeks() throws Exception {
        long courseId = createCourse("EN101", "大学英语");
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", "外语楼 402", "EVEN", SEMESTER_START, 1, 4)))
                .andExpect(status().isCreated());

        mvc.perform(get("/api/schedules/by-date").param("date", "2026-09-07"))
                .andExpect(jsonPath("$.length()").value(0));
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-09-14"))
                .andExpect(jsonPath("$.length()").value(1));
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-09-28"))
                .andExpect(jsonPath("$.length()").value(1));
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-10-05"))
                .andExpect(jsonPath("$.length()").value(0));
    }

    @Test
    @DisplayName("旧课表（没有教学周信息）仍然每周出现，并提示未设置")
    void legacyScheduleStillWeekly() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.schedule(1, "08:00", "09:40", "教三 305")))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.weekPattern").value("ALL"))
                .andExpect(jsonPath("$.teachingWeeksConfigured").value(false))
                .andExpect(jsonPath("$.weekSummary").value("未设置教学周（按每周显示）"));

        for (String date : new String[] {"2026-09-07", "2026-09-14", "2026-09-21", "2027-03-01"}) {
            mvc.perform(get("/api/schedules/by-date").param("date", date))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(1));
        }
    }

    @Test
    @DisplayName("今日课程遵守教学周规则（按今天的实际教学周奇偶构造）")
    void todayRespectsWeekPattern() throws Exception {
        LocalDate today = LocalDate.now(TimeZones.zone());
        // 让今天落在第 6 教学周（偶数），这样单周课今天不上、每周课今天要上
        LocalDate semesterStart = today.minusWeeks(5).with(DayOfWeek.MONDAY);
        int weekday = today.getDayOfWeek().getValue();

        long courseId = createCourse("PH101", "大学物理");
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(weekday, "08:00", "09:40", "实验楼", "ALL",
                                semesterStart.toString(), 1, 10)))
                .andExpect(status().isCreated());
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(weekday, "10:10", "11:50", "实验楼", "ODD",
                                semesterStart.toString(), 1, 10)))
                .andExpect(status().isCreated());

        mvc.perform(get("/api/schedules/today"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].weekPattern").value("ALL"));
    }

    @Test
    @DisplayName("列表接口按日期过滤：/api/schedules?date=")
    void listFilteredByDate() throws Exception {
        long courseId = createCourse("CS202", "数据结构实验");
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(2, "13:30", "15:10", "B204", "ODD", SEMESTER_START, 1, 5)))
                .andExpect(status().isCreated());

        // 周二第 2 周（偶数）不上；第 3 周（奇数）上
        mvc.perform(get("/api/schedules").param("date", "2026-09-15"))
                .andExpect(jsonPath("$.length()").value(0));
        mvc.perform(get("/api/schedules").param("date", "2026-09-22"))
                .andExpect(jsonPath("$.length()").value(1));
        // 不带日期时保持原有行为（全部返回）
        mvc.perform(get("/api/schedules"))
                .andExpect(jsonPath("$.length()").value(1));
        mvc.perform(get("/api/schedules").param("weekday", "2"))
                .andExpect(jsonPath("$.length()").value(1));
        mvc.perform(get("/api/schedules").param("weekday", "3"))
                .andExpect(jsonPath("$.length()").value(0));
    }

    @Test
    @DisplayName("更新课表可以改成双周并补齐教学周")
    void updateToEvenPattern() throws Exception {
        long courseId = createCourse("CS203", "编译原理");
        long scheduleId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(
                        post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.schedule(3, "08:00", "09:40", "A101")))
                .andExpect(status().isCreated()).andReturn());

        mvc.perform(ApiTestSupport.json(put("/api/courses/{cid}/schedules/{sid}", courseId, scheduleId),
                        ApiTestSupport.scheduleWithWeeks(3, "08:00", "09:40", "A101", "EVEN", SEMESTER_START, 2, 8)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.weekPatternLabel").value("双周"))
                .andExpect(jsonPath("$.startWeek").value(2))
                .andExpect(jsonPath("$.semesterStartDate").value(SEMESTER_START));

        // 周三 2026-09-16 属于第 2 周（偶数）→ 上
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-09-16"))
                .andExpect(jsonPath("$.length()").value(1));
        // 周三 2026-09-23 属于第 3 周（奇数）→ 不上
        mvc.perform(get("/api/schedules/by-date").param("date", "2026-09-23"))
                .andExpect(jsonPath("$.length()").value(0));
    }

    @Test
    @DisplayName("服务端校验：非周一起点 / 单双周缺起点 / 缺起止周 / 周数倒置 / 周数越界")
    void validationBoundaries() throws Exception {
        long courseId = createCourse("CS204", "算法");

        // 非周一
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", null, "ALL", "2026-09-08", 1, 16)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("semesterStartDate"));

        // 单周但没有学期起点
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", null, "ODD", null, null, null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("weekPattern"));

        // 单周有起点但没有起止周
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", null, "ODD", SEMESTER_START, null, null)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("startWeek"));

        // 只有起止周、没有学期起点
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", null, "ALL", null, 1, 16)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("semesterStartDate"));

        // 起止周倒置
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", null, "ALL", SEMESTER_START, 8, 3)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("startWeek"));

        // 周数越界（bean validation）
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", null, "ALL", SEMESTER_START, 0, 16)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("startWeek"));

        // 非法枚举值
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "08:00", "09:40", null, "WEEKLY", SEMESTER_START, 1, 16)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("weekPattern"));

        // 以上全部失败，不应产生任何课表
        assertThat(scheduleRepository.count()).isZero();
    }

    @Test
    @DisplayName("起止时间非法仍然 400（原有约束不回退）")
    void timeRangeStillValidated() throws Exception {
        long courseId = createCourse("CS205", "操作系统");
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.scheduleWithWeeks(1, "14:00", "12:00", null, "ALL", SEMESTER_START, 1, 16)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("startTime"));
    }

    private long createCourse(String code, String name) throws Exception {
        return ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                        ApiTestSupport.course(code, name)))
                .andExpect(status().isCreated()).andReturn());
    }
}
