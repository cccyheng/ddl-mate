package com.ddlmate.repository;

import java.time.OffsetDateTime;
import java.util.List;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import com.ddlmate.domain.PasswordResetRequest;

public interface PasswordResetRequestRepository extends JpaRepository<PasswordResetRequest, Long> {

    List<PasswordResetRequest> findAllByOrderByIdDesc(Pageable pageable);

    long countByStatus(String status);

    long countByClientKeyAndCreatedAtAfter(String clientKey, OffsetDateTime after);

    long countByCreatedAtAfter(OffsetDateTime after);

    void deleteByUserId(Long userId);
}
