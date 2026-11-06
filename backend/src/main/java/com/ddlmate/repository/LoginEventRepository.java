package com.ddlmate.repository;

import java.util.List;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import com.ddlmate.domain.LoginEvent;

public interface LoginEventRepository extends JpaRepository<LoginEvent, Long> {

    List<LoginEvent> findByUserIdOrderByIdDesc(Long userId, Pageable pageable);

    /** 每个账号的登录次数：[userId, count] */
    @Query("select e.userId, count(e) from LoginEvent e group by e.userId")
    List<Object[]> countByUser();
}
