package com.ddlmate.repository;

import java.time.OffsetDateTime;
import java.util.List;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import com.ddlmate.domain.Feedback;

public interface FeedbackRepository extends JpaRepository<Feedback, Long> {

    List<Feedback> findByUserIdOrderByIdDesc(Long userId, Pageable pageable);

    List<Feedback> findAllByOrderByIdDesc(Pageable pageable);

    List<Feedback> findByStatusOrderByIdDesc(String status, Pageable pageable);

    long countByStatus(String status);

    long countByUserIdAndCreatedAtAfter(Long userId, OffsetDateTime after);
}
