package com.ddlmate.repository;

import java.time.OffsetDateTime;
import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.ddlmate.domain.Task;

public interface TaskRepository extends JpaRepository<Task, Long>, JpaSpecificationExecutor<Task> {

    /** DDL 列表用：所有有截止时间的任务（含已完成，是否过滤由服务层决定）。 */
    @Query("select t from Task t left join fetch t.course where t.deadline is not null")
    List<Task> findAllWithDeadline();

    @Query("select t from Task t left join fetch t.course where t.deadline is not null and t.course.id = :courseId")
    List<Task> findWithDeadlineByCourse(@Param("courseId") Long courseId);

    @Query("select t from Task t left join fetch t.course where t.deadline >= :from and t.deadline < :to order by t.deadline asc")
    List<Task> findInWindow(@Param("from") OffsetDateTime from, @Param("to") OffsetDateTime to);

    @Query("select t from Task t left join fetch t.course where t.status not in (com.ddlmate.domain.TaskStatus.DONE, com.ddlmate.domain.TaskStatus.ARCHIVED) and t.deadline is not null and t.deadline < :now order by t.deadline asc")
    List<Task> findOverdueOpen(@Param("now") OffsetDateTime now);

    long countByCourseId(Long courseId);

    List<Task> findByCourseId(Long courseId);
}
