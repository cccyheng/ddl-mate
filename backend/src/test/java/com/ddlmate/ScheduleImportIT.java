package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** 照片导入确认后的批量导入接口：事务、去重、校验与回滚。 */
class ScheduleImportIT extends BaseIntegrationTest {

    private static final String TWO_SCHEDULES = """
            {
              "courses":[{"ref":"n1","code":"OCR-CS1","name":"数据结构","instructor":"王老师","color":"#4f7cff"}],
              "schedules":[
                {"courseRef":"n1","weekday":1,"startTime":"08:00","endTime":"09:40","location":"教三 305",
                 "periodStart":1,"periodEnd":2,"weekRange":"1-16",
                 "semesterStartDate":"2026-09-07","startWeek":1,"endWeek":16,"weekPattern":"ODD"},
                {"courseRef":"n1","weekday":3,"startTime":"10:10","endTime":"11:50","location":"实验楼 B204",
                 "weekPattern":"ALL"}
              ]
            }
            """;

    @Test
    @DisplayName("批量导入：新建课程 + 多条课表在同一个事务里完成")
    void importCreatesCourseAndSchedules() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), TWO_SCHEDULES))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdCourses").value(1))
                .andExpect(jsonPath("$.createdSchedules").value(2))
                .andExpect(jsonPath("$.skippedSchedules").value(0))
                .andExpect(jsonPath("$.schedules.length()").value(2))
                .andExpect(jsonPath("$.schedules[0].courseName").value("数据结构"))
                .andExpect(jsonPath("$.schedules[0].id").isNumber())
                .andExpect(jsonPath("$.schedules[0].weekPattern").value("ODD"));

        assertThat(courseRepository.count()).isEqualTo(1);
        assertThat(scheduleRepository.count()).isEqualTo(2);
        // 第一条按单周规则：2026-09-07 是第 1 周（奇数）要上
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .get("/api/schedules/by-date").param("date", "2026-09-07"))
                .andExpect(jsonPath("$.length()").value(1));
    }

    @Test
    @DisplayName("重复提交相同内容：跳过而不是重复建记录")
    void repeatedSubmitIsSkipped() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), TWO_SCHEDULES))
                .andExpect(status().isCreated());
        // 导入响应里没有课程 id，从库里取（本次只建了一门课）
        long courseId = courseRepository.findAll().get(0).getId();

        String again = """
                {
                  "courses":[],
                  "schedules":[
                    {"courseId":%d,"weekday":1,"startTime":"08:00","endTime":"09:40","location":"教三 305",
                     "periodStart":1,"periodEnd":2,"weekRange":"1-16",
                     "semesterStartDate":"2026-09-07","startWeek":1,"endWeek":16,"weekPattern":"ODD"},
                    {"courseId":%d,"weekday":3,"startTime":"10:10","endTime":"11:50","location":"实验楼 B204",
                     "weekPattern":"ALL"}
                  ]
                }
                """.formatted(courseId, courseId);

        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), again))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdCourses").value(0))
                .andExpect(jsonPath("$.createdSchedules").value(0))
                .andExpect(jsonPath("$.skippedSchedules").value(2))
                .andExpect(jsonPath("$.notices.length()").value(3));

        assertThat(courseRepository.count()).isEqualTo(1);
        assertThat(scheduleRepository.count()).isEqualTo(2);
    }

    @Test
    @DisplayName("请求内部重复（同课程同星期同开始时间）→ 400 且整体不落库")
    void duplicateWithinRequestRejected() throws Exception {
        String body = """
                {
                  "courses":[{"ref":"n1","code":"OCR-DUP","name":"重复课"}],
                  "schedules":[
                    {"courseRef":"n1","weekday":2,"startTime":"08:00","endTime":"09:40"},
                    {"courseRef":"n1","weekday":2,"startTime":"08:00","endTime":"09:40"}
                  ]
                }
                """;
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));

        assertThat(courseRepository.count()).isZero();
        assertThat(scheduleRepository.count()).isZero();
    }

    @Test
    @DisplayName("第二条非法时整体回滚：不会留下孤立课程")
    void failedItemRollsBackWholeImport() throws Exception {
        String body = """
                {
                  "courses":[{"ref":"n1","code":"OCR-RB1","name":"回滚测试课"}],
                  "schedules":[
                    {"courseRef":"n1","weekday":1,"startTime":"08:00","endTime":"09:40"},
                    {"courseRef":"n1","weekday":2,"startTime":"14:00","endTime":"12:00"}
                  ]
                }
                """;
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("startTime"));

        assertThat(courseRepository.count()).isZero();
        assertThat(scheduleRepository.count()).isZero();
    }

    @Test
    @DisplayName("教学周非法同样整体回滚")
    void invalidWeekRuleRollsBack() throws Exception {
        String body = """
                {
                  "courses":[{"ref":"n1","code":"OCR-RB2","name":"单周缺起点"}],
                  "schedules":[
                    {"courseRef":"n1","weekday":1,"startTime":"08:00","endTime":"09:40","weekPattern":"ODD"}
                  ]
                }
                """;
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("weekPattern"));

        assertThat(courseRepository.count()).isZero();
    }

    @Test
    @DisplayName("导入到已有课程：courseId 路径")
    void importIntoExistingCourse() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                        ApiTestSupport.course("CS201", "数据结构")))
                .andExpect(status().isCreated()).andReturn());

        String body = """
                {
                  "courses":[],
                  "schedules":[{"courseId":%d,"weekday":4,"startTime":"13:30","endTime":"15:10","location":"机房"}]
                }
                """.formatted(courseId);

        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdCourses").value(0))
                .andExpect(jsonPath("$.createdSchedules").value(1))
                .andExpect(jsonPath("$.schedules[0].courseId").value(courseId));
    }

    @Test
    @DisplayName("引用不存在的课程标识 / 同时给了 courseId 与 courseRef → 400")
    void invalidCourseReference() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), """
                        {"courses":[],"schedules":[{"courseRef":"nope","weekday":1,"startTime":"08:00","endTime":"09:40"}]}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("courseRef"));

        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), """
                        {"courses":[{"ref":"n1","code":"X1","name":"X"}],
                         "schedules":[{"courseId":1,"courseRef":"n1","weekday":1,"startTime":"08:00","endTime":"09:40"}]}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field").value("courseId"));

        assertThat(courseRepository.count()).isZero();
    }

    @Test
    @DisplayName("新建课程代码与已有课程冲突 → 409 且不落库")
    void duplicateCourseCodeRejected() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("OCR-CS1", "已存在")))
                .andExpect(status().isCreated());

        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), TWO_SCHEDULES))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("RESOURCE_IN_USE"));

        assertThat(courseRepository.count()).isEqualTo(1);
        assertThat(scheduleRepository.count()).isZero();
    }

    @Test
    @DisplayName("空课表列表 → 400")
    void emptySchedulesRejected() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), """
                        {"courses":[],"schedules":[]}
                        """))
                .andExpect(status().isBadRequest());
    }

    @Test
    @DisplayName("批量入口与单条入口同样做字段校验：星期/节次/周数越界都是 400，不是 500")
    void fieldValidationMatchesSingleEntry() throws Exception {
        // 嵌套列表里的字段错误会带下标路径（schedules[0].weekday），这里只断言字段名包含关系
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), """
                        {"courses":[{"ref":"n1","code":"V1","name":"校验课"}],
                         "schedules":[{"courseRef":"n1","weekday":8,"startTime":"08:00","endTime":"09:40"}]}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field", org.hamcrest.Matchers.containsString("weekday")));

        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), """
                        {"courses":[{"ref":"n1","code":"V2","name":"校验课"}],
                         "schedules":[{"courseRef":"n1","weekday":1,"startTime":"08:00","endTime":"09:40","periodStart":0}]}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field", org.hamcrest.Matchers.containsString("periodStart")));

        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), """
                        {"courses":[{"ref":"n1","code":"V3","name":"校验课"}],
                         "schedules":[{"courseRef":"n1","weekday":1,"startTime":"08:00","endTime":"09:40","periodEnd":13}]}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field", org.hamcrest.Matchers.containsString("periodEnd")));

        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), """
                        {"courses":[{"ref":"n1","code":"V4","name":"校验课"}],
                         "schedules":[{"courseRef":"n1","weekday":1,"startTime":"08:00","endTime":"09:40",
                          "semesterStartDate":"2026-09-07","startWeek":1,"endWeek":54}]}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.fieldErrors[0].field", org.hamcrest.Matchers.containsString("endWeek")));

        assertThat(courseRepository.count()).isZero();
        assertThat(scheduleRepository.count()).isZero();
    }

    @Test
    @DisplayName("非法的周次规律枚举在批量入口也是 400（不是 500）")
    void invalidWeekPatternIsBadRequest() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), """
                        {"courses":[{"ref":"n1","code":"V5","name":"校验课"}],
                         "schedules":[{"courseRef":"n1","weekday":1,"startTime":"08:00","endTime":"09:40",
                          "semesterStartDate":"2026-09-07","startWeek":1,"endWeek":16,"weekPattern":"WEEKLY"}]}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"))
                .andExpect(jsonPath("$.fieldErrors[0].field").value("weekPattern"));

        assertThat(courseRepository.count()).isZero();
    }

    @Test
    @DisplayName("数组里出现 null 元素 → 400 而不是 500")
    void nullElementsAreBadRequest() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), """
                        {"courses":[],"schedules":[null]}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));

        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), """
                        {"courses":[null],"schedules":[{"courseId":1,"weekday":1,"startTime":"08:00","endTime":"09:40"}]}
                        """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("INVALID_ARGUMENT"));

        assertThat(courseRepository.count()).isZero();
    }

    @Test
    @DisplayName("同一门课同一时间、单周与双周各一条（地点不同）→ 两条都要保存，不能误判重复")
    void oddAndEvenSameSlotAreBothKept() throws Exception {
        String body = """
                {
                  "courses":[{"ref":"n1","code":"OCR-OE","name":"实验课"}],
                  "schedules":[
                    {"courseRef":"n1","weekday":2,"startTime":"14:00","endTime":"15:40","location":"单周实验A",
                     "semesterStartDate":"2026-09-07","startWeek":1,"endWeek":16,"weekPattern":"ODD"},
                    {"courseRef":"n1","weekday":2,"startTime":"14:00","endTime":"15:40","location":"双周实验B",
                     "semesterStartDate":"2026-09-07","startWeek":1,"endWeek":16,"weekPattern":"EVEN"}
                  ]
                }
                """;
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdSchedules").value(2))
                .andExpect(jsonPath("$.skippedSchedules").value(0));

        assertThat(scheduleRepository.count()).isEqualTo(2);
        // 单周那天只有 A、双周那天只有 B
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .get("/api/schedules/by-date").param("date", "2026-09-08"))
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].location").value("单周实验A"));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .get("/api/schedules/by-date").param("date", "2026-09-15"))
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].location").value("双周实验B"));
    }

    @Test
    @DisplayName("与已有课表真实冲突（同一天时间重叠、都是每周）→ 409 明确报错，不静默跳过")
    void realConflictWithExistingIsRejected() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                        ApiTestSupport.course("CS201", "数据结构")))
                .andExpect(status().isCreated()).andReturn());
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.schedule(1, "08:00", "09:40", "教三 305")))
                .andExpect(status().isCreated());

        String body = """
                {
                  "courses":[],
                  "schedules":[{"courseId":%d,"weekday":1,"startTime":"09:00","endTime":"10:40","location":"教三 401"}]
                }
                """.formatted(courseId);
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), body))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("RESOURCE_IN_USE"))
                .andExpect(jsonPath("$.message", org.hamcrest.Matchers.containsString("课表冲突")));

        assertThat(scheduleRepository.count()).isEqualTo(1);
    }

    @Test
    @DisplayName("同一批导入内部真实冲突 → 409")
    void conflictWithinRequestIsRejected() throws Exception {
        String body = """
                {
                  "courses":[{"ref":"n1","code":"OCR-CF","name":"冲突课"}],
                  "schedules":[
                    {"courseRef":"n1","weekday":3,"startTime":"08:00","endTime":"09:40","location":"A101"},
                    {"courseRef":"n1","weekday":3,"startTime":"09:00","endTime":"10:40","location":"A102"}
                  ]
                }
                """;
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), body))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.message", org.hamcrest.Matchers.containsString("自相冲突")));

        assertThat(courseRepository.count()).isZero();
        assertThat(scheduleRepository.count()).isZero();
    }

    @Test
    @DisplayName("新增课程没有任何课表引用 → 不创建，只给出提示")
    void unreferencedNewCourseIsIgnored() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                        ApiTestSupport.course("CS201", "数据结构")))
                .andExpect(status().isCreated()).andReturn());

        String body = """
                {
                  "courses":[{"ref":"unused","code":"OCR-UNUSED","name":"没人用的课"}],
                  "schedules":[{"courseId":%d,"weekday":3,"startTime":"08:00","endTime":"09:40"}]
                }
                """.formatted(courseId);
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdCourses").value(0))
                .andExpect(jsonPath("$.createdSchedules").value(1))
                .andExpect(jsonPath("$.notices[0]", org.hamcrest.Matchers.containsString("已忽略")));

        assertThat(courseRepository.count()).isEqualTo(1);
        assertThat(courseRepository.findAll().get(0).getCode()).isEqualTo("CS201");
    }

    @Test
    @DisplayName("数据库里已存在同课同时间的相邻安排（不重叠）→ 允许导入")
    void adjacentNonOverlappingIsAllowed() throws Exception {
        long courseId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                        ApiTestSupport.course("CS202", "操作系统")))
                .andExpect(status().isCreated()).andReturn());
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId),
                        ApiTestSupport.schedule(1, "08:00", "09:40", "A101")))
                .andExpect(status().isCreated());

        String body = """
                {"courses":[],"schedules":[{"courseId":%d,"weekday":1,"startTime":"10:00","endTime":"11:40","location":"A102"}]}
                """.formatted(courseId);
        mvc.perform(ApiTestSupport.json(post("/api/schedules/import"), body))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.createdSchedules").value(1));
        assertThat(scheduleRepository.count()).isEqualTo(2);
    }
}
