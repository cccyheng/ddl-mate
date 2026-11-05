package com.ddlmate.service;

import org.springframework.stereotype.Component;

import com.ddlmate.auth.AuthService;
import com.ddlmate.common.ForbiddenException;

/** 站长判断：登录版看角色；本机单人版（未启用登录）里唯一的用户就是站长。 */
@Component
public class AdminGuard {

    private final UserService userService;
    private final AuthService authService;

    public AdminGuard(UserService userService, AuthService authService) {
        this.userService = userService;
        this.authService = authService;
    }

    public boolean isAdmin() {
        return !authService.enabled() || userService.currentUser().isAdmin();
    }

    public void requireAdmin() {
        if (!isAdmin()) {
            throw new ForbiddenException("只有站长可以进行这个操作。");
        }
    }
}
