package com.ddlmate.repository;

import java.util.List;

import org.springframework.data.jpa.repository.JpaRepository;

import com.ddlmate.domain.AppSetting;

public interface AppSettingRepository extends JpaRepository<AppSetting, String> {

    List<AppSetting> findByKeyStartingWithOrderByKeyAsc(String prefix);
}
