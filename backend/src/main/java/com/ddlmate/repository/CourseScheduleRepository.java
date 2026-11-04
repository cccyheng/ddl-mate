package com.ddlmate.repository;

import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.ddlmate.domain.CourseSchedule;

public interface CourseScheduleRepository extends JpaRepository<CourseSchedule, Long> {

    @Query("select s from CourseSchedule s join fetch s.course c where c.id = :courseId order by s.weekday asc, s.startTime asc")
    List<CourseSchedule> findByCourseIdOrdered(@Param("courseId") Long courseId);

    @Query("select s from CourseSchedule s join fetch s.course c order by s.weekday asc, s.startTime asc")
    List<CourseSchedule> findAllOrdered();

    @Query("select s from CourseSchedule s join fetch s.course c where s.weekday = :weekday order by s.startTime asc")
    List<CourseSchedule> findByWeekdayOrdered(@Param("weekday") Integer weekday);

    long countByCourseId(Long courseId);
}
