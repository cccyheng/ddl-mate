package com.ddlmate.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.ddlmate.service.UserService;
import com.ddlmate.web.dto.ProfileResponse;
import com.ddlmate.web.dto.ProfileUpdateRequest;

import jakarta.validation.Valid;

/**
 * 本地用户资料。V1 没有登录鉴权（响应里的 authenticationEnabled=false 明确说明这一点），
 * 接口只提供"当前是谁"的信息，方便以后接多用户时平滑迁移。
 */
@RestController
@RequestMapping("/api/profile")
public class ProfileController {

    private final UserService userService;

    public ProfileController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping
    public ProfileResponse get() {
        return userService.profile();
    }

    @PutMapping
    public ProfileResponse update(@Valid @RequestBody ProfileUpdateRequest request) {
        return userService.updateProfile(request);
    }
}
