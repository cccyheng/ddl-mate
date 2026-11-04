package com.ddlmate.service;

import java.util.ArrayList;
import java.util.List;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.common.ResourceInUseException;
import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.domain.Course;
import com.ddlmate.domain.CourseSchedule;
import com.ddlmate.domain.Task;
import com.ddlmate.repository.CourseRepository;
import com.ddlmate.repository.CourseScheduleRepository;
import com.ddlmate.repository.TaskRepository;
import com.ddlmate.web.dto.CourseRequest;
import com.ddlmate.web.dto.CourseResponse;

@Service
public class CourseService {

    private final CourseRepository courseRepository;

    private final CourseScheduleRepository scheduleRepository;

    private final TaskRepository taskRepository;

    public CourseService(CourseRepository courseRepository, CourseScheduleRepository scheduleRepository,
            TaskRepository taskRepository) {
        this.courseRepository = courseRepository;
        this.scheduleRepository = scheduleRepository;
        this.taskRepository = taskRepository;
    }

    @Transactional(readOnly = true)
    public List<CourseResponse> list(String keyword) {
        List<Course> courses;
        if (keyword == null || keyword.isBlank()) {
            courses = courseRepository.findAllByOrderByCodeAsc();
        } else {
            String trimmed = keyword.trim();
            courses = courseRepository
                    .findByNameContainingIgnoreCaseOrCodeContainingIgnoreCaseOrderByCodeAsc(trimmed, trimmed);
        }
        List<CourseResponse> result = new ArrayList<>(courses.size());
        for (Course course : courses) {
            result.add(ApiMapper.course(course,
                    taskRepository.countByCourseId(course.getId()),
                    scheduleRepository.countByCourseId(course.getId())));
        }
        return result;
    }

    @Transactional(readOnly = true)
    public Course require(Long id) {
        return courseRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("课程", id));
    }

    @Transactional(readOnly = true)
    public CourseResponse get(Long id) {
        Course course = require(id);
        return ApiMapper.course(course,
                taskRepository.countByCourseId(id),
                scheduleRepository.countByCourseId(id));
    }

    @Transactional
    public CourseResponse create(CourseRequest request) {
        String code = request.code().trim();
        if (courseRepository.existsByCodeIgnoreCase(code)) {
            throw new ResourceInUseException("课程代码已存在：" + code, com.ddlmate.common.ErrorCodes.RESOURCE_IN_USE);
        }
        Course course = new Course(code, request.name().trim());
        apply(course, request);
        Course saved = courseRepository.save(course);
        return ApiMapper.course(saved, 0, 0);
    }

    @Transactional
    public CourseResponse update(Long id, CourseRequest request) {
        Course course = require(id);
        String code = request.code().trim();
        if (!course.getCode().equalsIgnoreCase(code) && courseRepository.existsByCodeIgnoreCase(code)) {
            throw new ResourceInUseException("课程代码已存在：" + code, com.ddlmate.common.ErrorCodes.RESOURCE_IN_USE);
        }
        course.setCode(code);
        course.setName(request.name().trim());
        apply(course, request);
        Course saved = courseRepository.save(course);
        return ApiMapper.course(saved,
                taskRepository.countByCourseId(id),
                scheduleRepository.countByCourseId(id));
    }

    /**
     * 删除课程。
     *
     * <p>默认安全行为：课程下还有任务或课表时拒绝删除（409），避免误删导致任务失去课程归属。
     * 显式 force=true 时先解绑任务、再级联删除课表。</p>
     */
    @Transactional
    public void delete(Long id, boolean force) {
        Course course = require(id);
        long taskCount = taskRepository.countByCourseId(id);
        long scheduleCount = scheduleRepository.countByCourseId(id);
        if (!force && (taskCount > 0 || scheduleCount > 0)) {
            throw new ResourceInUseException(String.format(
                    "课程「%s」仍有 %d 个任务、%d 条课表，禁止删除；确认要删除请加 ?force=true（任务会解除课程关联，课表会被删除）",
                    course.getName(), taskCount, scheduleCount));
        }
        if (taskCount > 0) {
            List<Task> tasks = taskRepository.findByCourseId(id);
            for (Task task : tasks) {
                task.setCourse(null);
            }
            taskRepository.saveAll(tasks);
        }
        if (scheduleCount > 0) {
            List<CourseSchedule> schedules = scheduleRepository.findByCourseIdOrdered(id);
            scheduleRepository.deleteAll(schedules);
        }
        courseRepository.delete(course);
    }

    private void apply(Course course, CourseRequest request) {
        course.setInstructor(blankToNull(request.instructor()));
        course.setSemester(blankToNull(request.semester()));
        course.setNote(blankToNull(request.note()));
        String color = blankToNull(request.color());
        course.setColor(color == null ? null : color.trim());
    }

    private String blankToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
