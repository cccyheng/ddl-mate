package com.ddlmate.common;

import java.time.OffsetDateTime;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonInclude;

/** 统一错误响应体。所有 4xx/5xx 都返回这个结构。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ApiError(
        OffsetDateTime timestamp,
        int status,
        String error,
        String code,
        String message,
        String path,
        List<FieldError> fieldErrors) {

    public record FieldError(String field, String message) {
    }

    public static ApiError of(int status, String error, String code, String message, String path) {
        return new ApiError(TimeZones.now(), status, error, code, message, path, null);
    }

    public static ApiError withFields(int status, String error, String code, String message, String path,
            List<FieldError> fieldErrors) {
        return new ApiError(TimeZones.now(), status, error, code, message, path,
                fieldErrors == null || fieldErrors.isEmpty() ? null : fieldErrors);
    }
}
