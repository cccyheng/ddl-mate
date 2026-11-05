package com.ddlmate.repository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

import com.ddlmate.domain.UserSetting;

/** 查询都自动限定在当前用户名下（{@code @TenantId}）。 */
public interface UserSettingRepository extends JpaRepository<UserSetting, Long> {

    Optional<UserSetting> findByKey(String key);

    List<UserSetting> findByKeyStartingWithOrderByKeyAsc(String prefix);

    void deleteByKey(String key);

    void deleteByKeyIn(Collection<String> keys);
}
