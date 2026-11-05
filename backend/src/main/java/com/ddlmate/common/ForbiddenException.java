package com.ddlmate.common;

/** 已登录但没有权限（例如普通用户访问站长接口）→ HTTP 403。 */
public class ForbiddenException extends RuntimeException {

    public ForbiddenException(String message) {
        super(message);
    }
}
