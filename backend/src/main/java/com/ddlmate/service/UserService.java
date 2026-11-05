package com.ddlmate.service;

import java.util.List;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.AppUser;
import com.ddlmate.repository.AppUserRepository;
import com.ddlmate.tenant.OwnerResolver;
import com.ddlmate.web.dto.ProfileResponse;
import com.ddlmate.web.dto.ProfileUpdateRequest;

/**
 * 用户资料：当前登录用户（服务器版）或本机唯一用户（单人版）的资料读写。
 */
@Service
public class UserService {

    private final AppUserRepository repository;

    private final String defaultUsername;

    private final String defaultDisplayName;

    private final OwnerResolver ownerResolver;

    public UserService(
            AppUserRepository repository,
            OwnerResolver ownerResolver,
            @Value("${ddlmate.user.username:local}") String defaultUsername,
            @Value("${ddlmate.user.display-name:本机同学}") String defaultDisplayName) {
        this.repository = repository;
        this.ownerResolver = ownerResolver;
        this.defaultUsername = defaultUsername;
        this.defaultDisplayName = defaultDisplayName;
    }

    /**
     * 当前用户：服务器版为登录会话里的用户；本机单人版（未启用登录）为最早的那个用户。
     */
    @Transactional
    public AppUser currentUser() {
        long id = ownerResolver.resolveCurrentTenantIdentifier();
        if (id > 0) {
            return repository.findById(id)
                    .orElseThrow(() -> new com.ddlmate.common.ForbiddenException("账号不存在或已注销，请重新登录"));
        }
        return firstUser();
    }

    /** 最早的用户（本机单人版唯一的那个），不存在则创建。 */
    @Transactional
    public AppUser firstUser() {
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
