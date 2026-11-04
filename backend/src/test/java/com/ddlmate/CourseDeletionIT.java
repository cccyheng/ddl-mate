package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** 课程删除保护：默认拒绝，force=true 时按明确的安全行为执行。 */
class CourseDeletionIT extends BaseIntegrationTest {

    @Test
    @DisplayName("课程被任务引用时删除 → 409，任务与课程都还在")
    void refuseDeleteWhenReferencedByTask() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        long taskId = createTaskFor(courseId, "数据结构实验二");

        mvc.perform(delete("/api/courses/{id}", courseId))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("RESOURCE_IN_USE"))
                .andExpect(jsonPath("$.message", containsString("仍有 1 个任务")));

        assertThat(courseRepository.findById(courseId)).isPresent();
        assertThat(taskRepository.findById(taskId)).isPresent();
    }

    @Test
    @DisplayName("课程被课表引用时删除 → 409")
    void refuseDeleteWhenReferencedBySchedule() throws Exception {
        long courseId = createCourse("MA102", "线性代数");
        mvc.perform(ApiTestSupport.json(post("/api/courses/{id}/schedules", courseId), """
                        {"weekday":4,"startTime":"10:10","endTime":"11:50","location":"教二 108"}
                        """))
                .andExpect(status().isCreated());

        mvc.perform(delete("/api/courses/{id}", courseId))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.message", containsString("1 条课表")));
    }

    @Test
    @DisplayName("force=true：任务解除课程关联、课表删除、课程删除")
    void forceDeleteUnbindsTasksAndDropsSchedules() throws Exception {
        long courseId = createCourse("CS201", "数据结构");
        long taskId = createTaskFor(courseId, "数据结构实验二");
        long scheduleId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(
                        post("/api/courses/{id}/schedules", courseId), """
                                {"weekday":2,"startTime":"08:00","endTime":"09:40","location":"教三 305"}
                                """))
                .andExpect(status().isCreated()).andReturn());

        mvc.perform(delete("/api/courses/{id}", courseId).param("force", "true"))
                .andExpect(status().isNoContent());

        assertThat(courseRepository.findById(courseId)).isEmpty();
        assertThat(scheduleRepository.findById(scheduleId)).isEmpty();

        // 任务被保留下来，只是不再属于任何课程
        mvc.perform(get("/api/tasks/{id}", taskId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.title").value("数据结构实验二"))
                .andExpect(jsonPath("$.course").doesNotExist());
        assertThat(taskRepository.findById(taskId).orElseThrow().getCourse()).isNull();
    }

    @Test
    @DisplayName("没有引用的课程可以直接删除 → 204")
    void deleteUnreferencedCourse() throws Exception {
        long courseId = createCourse("EN101", "大学英语");

        mvc.perform(delete("/api/courses/{id}", courseId)).andExpect(status().isNoContent());
        mvc.perform(get("/api/courses/{id}", courseId)).andExpect(status().isNotFound());
    }

    @Test
    @DisplayName("删除不存在的课程 → 404")
    void deleteUnknownCourse() throws Exception {
        mvc.perform(delete("/api/courses/{id}", 555555))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));
    }

    @Test
    @DisplayName("删除课表后课程可正常删除（关联计数归零）")
    void deleteScheduleThenCourse() throws Exception {
        long courseId = createCourse("PH101", "大学物理");
        long scheduleId = ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(
                        post("/api/courses/{id}/schedules", courseId), """
                                {"weekday":3,"startTime":"14:00","endTime":"15:40"}
                                """))
                .andExpect(status().isCreated()).andReturn());

        mvc.perform(delete("/api/courses/{courseId}/schedules/{scheduleId}", courseId, scheduleId))
                .andExpect(status().isNoContent());
        mvc.perform(delete("/api/courses/{id}", courseId)).andExpect(status().isNoContent());
    }

    private long createCourse(String code, String name) throws Exception {
        return ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/courses"),
                        ApiTestSupport.course(code, name)))
                .andExpect(status().isCreated()).andReturn());
    }

    private long createTaskFor(long courseId, String title) throws Exception {
        return ApiTestSupport.idOf(mvc.perform(ApiTestSupport.json(post("/api/tasks"),
                        ApiTestSupport.task(title, courseId, "2026-10-15T10:10:00+08:00", "LAB", 4, 180)))
                .andExpect(status().isCreated()).andReturn());
    }
}
