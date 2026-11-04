package com.ddlmate.service;

import java.util.List;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.AppUser;
import com.ddlmate.repository.AppUserRepository;
import com.ddlmate.web.dto.ProfileResponse;
import com.ddlmate.web.dto.ProfileUpdateRequest;

/**
 * 本地用户资料服务。
 *
 * <p>V1 没有登录鉴权，本服务只保证"本机有且只有一个用户档案"，作为以后加
 * Spring Security + user_id 外键时的迁移锚点。</p>
 */
@Service
public class UserService {

    private final AppUserRepository repository;

    private final String defaultUsername;

    private final String defaultDisplayName;

    public UserService(
            AppUserRepository repository,
            @Value("${ddlmate.user.username:local}") String defaultUsername,
            @Value("${ddlmate.user.display-name:本机同学}") String defaultDisplayName) {
        this.repository = repository;
        this.defaultUsername = defaultUsername;
        this.defaultDisplayName = defaultDisplayName;
    }

    /** 取当前（唯一）用户，不存在则创建。 */
    @Transactional
    public AppUser currentUser() {
        List<AppUser> users = repository.findAllOrdered();
        if (!users.isEmpty()) {
            return users.get(0);
        }
        return repository.findByUsername(defaultUsername)
                .orElseGet(() -> repository.save(new AppUser(defaultUsername, defaultDisplayName,
                        TimeZones.zone().getId())));
    }

    @Transactional(readOnly = true)
    public ProfileResponse profile() {
        return ProfileResponse.from(currentUser());
    }

    @Transactional
    public ProfileResponse updateProfile(ProfileUpdateRequest request) {
        AppUser user = currentUser();
        user.setDisplayName(request.displayName().trim());
        AppUser saved = repository.save(user);
        return ProfileResponse.from(saved);
    }

    @Transactional(readOnly = true)
    public AppUser requireUser(Long id) {
        return repository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("本地用户", id));
    }
}
