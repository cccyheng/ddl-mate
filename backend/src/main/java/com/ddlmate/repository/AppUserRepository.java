package com.ddlmate.repository;

import java.util.List;
import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import com.ddlmate.domain.AppUser;

public interface AppUserRepository extends JpaRepository<AppUser, Long> {

    Optional<AppUser> findByUsername(String username);

    Optional<AppUser> findByUsernameIgnoreCase(String username);

    boolean existsByUsernameIgnoreCase(String username);

    /** 账号存在且没有被封禁。 */
    @Query("select count(u) > 0 from AppUser u where u.id = :id and (u.disabled is null or u.disabled = false)")
    boolean isActive(@org.springframework.data.repository.query.Param("id") Long id);

    @Query("select u from AppUser u order by u.id asc")
    List<AppUser> findAllOrdered();
}
