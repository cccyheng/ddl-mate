package com.ddlmate.config;

import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.Course;
import com.ddlmate.domain.CourseSchedule;
import com.ddlmate.domain.Task;
import com.ddlmate.domain.TaskSource;
import com.ddlmate.domain.TaskType;
import com.ddlmate.repository.CourseRepository;
import com.ddlmate.repository.CourseScheduleRepository;
import com.ddlmate.repository.TaskRepository;
import com.ddlmate.repository.TaskSourceRepository;

/**
 * dev profile 的示例数据：只在课程表为空时插入一次，方便第一次打开界面就能看到内容。
 * 正式（mysql）profile 不会执行。
 */
@Configuration
@Profile("dev")
public class DevDataSeeder {

    private static final Logger log = LoggerFactory.getLogger(DevDataSeeder.class);

    @Bean
    ApplicationRunner seedDevData(CourseRepository courseRepository, CourseScheduleRepository scheduleRepository,
            TaskRepository taskRepository, TaskSourceRepository sourceRepository) {
        return args -> {
            if (courseRepository.count() > 0) {
                log.info("dev 示例数据已存在，跳过初始化");
                return;
            }
            ZoneId zone = TimeZones.zone();
            OffsetDateTime now = TimeZones.now();

            Course dataStructure = courseRepository.save(newCourse("CS201", "数据结构", "王老师", "#4f7cff"));
            Course linearAlgebra = courseRepository.save(newCourse("MA102", "线性代数", "李老师", "#22a06b"));
            Course english = courseRepository.save(newCourse("EN101", "大学英语", "Amy", "#e0873a"));

            scheduleRepository.save(schedule(dataStructure, 2, LocalTime.of(8, 0), LocalTime.of(9, 40), "教三 305", 1, 2));
            scheduleRepository.save(schedule(dataStructure, 5, LocalTime.of(13, 30), LocalTime.of(15, 10), "实验楼 B204", 5, 6));
            scheduleRepository.save(schedule(linearAlgebra, 4, LocalTime.of(10, 10), LocalTime.of(11, 50), "教二 108", 3, 4));
            scheduleRepository.save(schedule(english, 3, LocalTime.of(14, 0), LocalTime.of(15, 40), "外语楼 402", 7, 8));

            Task lab = new Task("数据结构实验二");
            lab.setCourse(dataStructure);
            lab.setType(TaskType.LAB);
            lab.setDeadline(now.plusDays(2).withHour(23).withMinute(59).withSecond(0).withNano(0));
            lab.setEstimatedMinutes(180);
            lab.setPriority(com.ddlmate.domain.TaskPriority.HIGH);
            lab.setSubmitRequirement("源代码 + 实验报告，打包成 zip");
            lab.setSubmitMethod("学习通");
            lab.setDescription("图的最短路径实现与实验报告");
            taskRepository.save(lab);

            Task homework = new Task("线性代数第四章作业");
            homework.setCourse(linearAlgebra);
            homework.setType(TaskType.HOMEWORK);
            homework.setDeadline(now.plusDays(1).withHour(10).withMinute(0).withSecond(0).withNano(0));
            homework.setEstimatedMinutes(40);
            homework.setPriority(com.ddlmate.domain.TaskPriority.URGENT);
            homework.setSubmitRequirement("课本 P88 习题 1-12");
            homework.setSubmitMethod("课堂提交");
            taskRepository.save(homework);

            Task essay = new Task("大学英语作文 Draft 2");
            essay.setCourse(english);
            essay.setType(TaskType.HOMEWORK);
            essay.setDeadline(now.plusDays(5).withHour(22).withMinute(0).withSecond(0).withNano(0));
            essay.setEstimatedMinutes(120);
            essay.setPriority(com.ddlmate.domain.TaskPriority.NORMAL);
            essay.setSubmitRequirement("500 词议论文，PDF 提交");
            essay.setSubmitMethod("邮箱");
            taskRepository.save(essay);

            TaskSource source = new TaskSource("数据结构课程群",
                    "数据结构实验二本周日晚十二点之前上传，要求源代码和实验报告一起打包。（2026-02 示例数据，非真实通知）");
            source.setSourceType("WECHAT_GROUP");
            source.setCapturedAt(now.minusHours(3));
            source.setTask(lab);
            sourceRepository.save(source);

            log.info("dev 示例数据初始化完成：3 门课程、4 条课表、3 个任务、1 条原通知（未含附件）");
        };
    }

    private Course newCourse(String code, String name, String instructor, String color) {
        Course course = new Course(code, name);
        course.setInstructor(instructor);
        course.setSemester("2025-2026 第二学期");
        course.setColor(color);
        return course;
    }

    private CourseSchedule schedule(Course course, int weekday, LocalTime start, LocalTime end, String location,
            int periodStart, int periodEnd) {
        CourseSchedule schedule = new CourseSchedule(course, weekday, start, end);
        schedule.setLocation(location);
        schedule.setPeriodStart(periodStart);
        schedule.setPeriodEnd(periodEnd);
        schedule.setWeekRange("1-16");
        return schedule;
    }
}
