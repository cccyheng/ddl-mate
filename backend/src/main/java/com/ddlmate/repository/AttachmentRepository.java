package com.ddlmate.repository;

import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.ddlmate.domain.Attachment;

public interface AttachmentRepository extends JpaRepository<Attachment, Long> {

    @Query("select a from Attachment a join fetch a.taskSource s left join fetch s.task t where a.id = :id")
    Optional<Attachment> findByIdWithSource(@Param("id") Long id);
}
