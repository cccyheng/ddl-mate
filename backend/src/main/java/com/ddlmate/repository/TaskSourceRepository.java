package com.ddlmate.repository;

import java.util.Collection;
import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.ddlmate.domain.TaskSource;

public interface TaskSourceRepository extends JpaRepository<TaskSource, Long> {

    List<TaskSource> findByTaskIdOrderByCapturedAtDescIdDesc(Long taskId);

    List<TaskSource> findAllByOrderByCreatedAtDesc();

    /** 批量取来源 + 附件，避免列表页按任务逐个查询（N+1）。 */
    @Query("select distinct s from TaskSource s left join fetch s.attachments where s.task.id in :taskIds order by s.id asc")
    List<TaskSource> findByTaskIdInWithAttachments(@Param("taskIds") Collection<Long> taskIds);

    @Query("select distinct s from TaskSource s left join fetch s.attachments where s.task.id = :taskId order by s.id asc")
    List<TaskSource> findByTaskIdWithAttachments(@Param("taskId") Long taskId);

    long countByTaskId(Long taskId);

    void deleteByTaskId(Long taskId);
}
