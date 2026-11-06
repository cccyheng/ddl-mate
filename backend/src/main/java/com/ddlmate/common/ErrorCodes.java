package com.ddlmate.common;

/** 业务错误码，与 API 错误响应中的 code 字段一一对应。 */
public final class ErrorCodes {

    public static final String VALIDATION_FAILED = "VALIDATION_FAILED";
    public static final String INVALID_ARGUMENT = "INVALID_ARGUMENT";
    public static final String RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND";
    public static final String RESOURCE_IN_USE = "RESOURCE_IN_USE";
    public static final String SETTING_CONFLICT = "SETTING_CONFLICT";
    public static final String UNAUTHENTICATED = "UNAUTHENTICATED";
    public static final String LOGIN_FAILED = "LOGIN_FAILED";
    public static final String LOGIN_LOCKED = "LOGIN_LOCKED";
    public static final String FORBIDDEN_ORIGIN = "FORBIDDEN_ORIGIN";
    public static final String REGISTRATION_LIMITED = "REGISTRATION_LIMITED";
    public static final String QUOTA_EXCEEDED = "QUOTA_EXCEEDED";
    public static final String FORBIDDEN = "FORBIDDEN";
    public static final String METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED";
    public static final String PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";
    public static final String RESET_LIMITED = "RESET_LIMITED";
    public static final String FEEDBACK_LIMITED = "FEEDBACK_LIMITED";
    public static final String FILE_TOO_LARGE = "FILE_TOO_LARGE";
    public static final String UNSUPPORTED_MEDIA_TYPE = "UNSUPPORTED_MEDIA_TYPE";
    public static final String INTERNAL_ERROR = "INTERNAL_ERROR";

    private ErrorCodes() {
    }
}
