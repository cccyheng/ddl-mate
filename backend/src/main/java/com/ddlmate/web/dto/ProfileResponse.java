package com.ddlmate.web.dto;

import com.ddlmate.domain.AppUser;

/** 本地用户资料（V1 无鉴权，仅本机单人使用）。 */
public record ProfileResponse(
        Long id,
        String username,
        String displayName,
        String timeZone,
        boolean authenticationEnabled,
        String note) {

    public static ProfileResponse from(AppUser user) {
        return new ProfileResponse(
                user.getId(),
                user.getUsername(),
                user.getDisplayName(),
                user.getTimeZone(),
                false,
                "V1 为仅绑定 127.0.0.1 的单人开发版本，未启用登录鉴权；多用户鉴权将在正式上线前加入。");
    }
}
