package com.ddlmate.web;

import java.util.ArrayList;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.FieldError;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.support.MissingServletRequestPartException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import com.ddlmate.common.ApiError;
import com.ddlmate.common.ErrorCodes;
import com.ddlmate.common.FileStorageException;
import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.ResourceInUseException;
import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.common.TimeZones;

import jakarta.servlet.http.HttpServletRequest;

/**
 * 统一错误响应。所有 4xx/5xx 都返回同一个 ApiError 结构，前端只需实现一套错误处理。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiError> handleValidation(MethodArgumentNotValidException ex, HttpServletRequest request) {
        List<ApiError.FieldError> fieldErrors = new ArrayList<>();
        for (FieldError error : ex.getBindingResult().getFieldErrors()) {
            fieldErrors.add(new ApiError.FieldError(error.getField(), error.getDefaultMessage()));
        }
        for (var error : ex.getBindingResult().getGlobalErrors()) {
            fieldErrors.add(new ApiError.FieldError(error.getObjectName(), error.getDefaultMessage()));
        }
        return build(HttpStatus.BAD_REQUEST, ErrorCodes.VALIDATION_FAILED, "请求参数校验失败", request, fieldErrors);
    }

    @ExceptionHandler(InvalidRequestException.class)
    public ResponseEntity<ApiError> handleInvalid(InvalidRequestException ex, HttpServletRequest request) {
        List<ApiError.FieldError> fieldErrors = ex.getField() == null
                ? null
                : List.of(new ApiError.FieldError(ex.getField(), ex.getMessage()));
        return build(HttpStatus.BAD_REQUEST, ErrorCodes.INVALID_ARGUMENT, ex.getMessage(), request, fieldErrors);
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<ApiError> handleTypeMismatch(MethodArgumentTypeMismatchException ex,
            HttpServletRequest request) {
        String message = "参数 " + ex.getName() + " 格式非法：" + ex.getValue();
        return build(HttpStatus.BAD_REQUEST, ErrorCodes.INVALID_ARGUMENT, message, request,
                List.of(new ApiError.FieldError(ex.getName(), message)));
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public ResponseEntity<ApiError> handleMissingParam(MissingServletRequestParameterException ex,
            HttpServletRequest request) {
        String message = "缺少必填参数：" + ex.getParameterName();
        return build(HttpStatus.BAD_REQUEST, ErrorCodes.INVALID_ARGUMENT, message, request,
                List.of(new ApiError.FieldError(ex.getParameterName(), message)));
    }

    @ExceptionHandler(MissingServletRequestPartException.class)
    public ResponseEntity<ApiError> handleMissingPart(MissingServletRequestPartException ex,
            HttpServletRequest request) {
        String message = "缺少上传字段：" + ex.getRequestPartName();
        return build(HttpStatus.BAD_REQUEST, ErrorCodes.INVALID_ARGUMENT, message, request, null);
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiError> handleUnreadable(HttpMessageNotReadableException ex, HttpServletRequest request) {
        String detail = ex.getMostSpecificCause().getMessage();
        return build(HttpStatus.BAD_REQUEST, ErrorCodes.INVALID_ARGUMENT,
                "请求体不是合法 JSON：" + detail, request, null);
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<ApiError> handleTooLarge(MaxUploadSizeExceededException ex, HttpServletRequest request) {
        return build(HttpStatus.PAYLOAD_TOO_LARGE, ErrorCodes.FILE_TOO_LARGE,
                "上传文件超过大小限制，请压缩后重试", request, null);
    }

    @ExceptionHandler(FileStorageException.class)
    public ResponseEntity<ApiError> handleStorage(FileStorageException ex, HttpServletRequest request) {
        HttpStatus status = HttpStatus.resolve(ex.getStatus());
        return build(status == null ? HttpStatus.INTERNAL_SERVER_ERROR : status, ex.getCode(), ex.getMessage(),
                request, null);
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<ApiError> handleMediaType(HttpMediaTypeNotSupportedException ex,
            HttpServletRequest request) {
        return build(HttpStatus.UNSUPPORTED_MEDIA_TYPE, ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
                "不支持的 Content-Type：" + ex.getContentType(), request, null);
    }

    @ExceptionHandler(ResourceNotFoundException.class)
    public ResponseEntity<ApiError> handleNotFound(ResourceNotFoundException ex, HttpServletRequest request) {
        return build(HttpStatus.NOT_FOUND, ErrorCodes.RESOURCE_NOT_FOUND, ex.getMessage(), request, null);
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ApiError> handleNoResource(NoResourceFoundException ex, HttpServletRequest request) {
        return build(HttpStatus.NOT_FOUND, ErrorCodes.RESOURCE_NOT_FOUND,
                "接口或资源不存在：" + request.getRequestURI(), request, null);
    }

    /** 不支持的请求方法（多半是网上的扫描器乱发的 POST / 或自造方法）：405，不当成服务器错误记日志。 */
    @ExceptionHandler(org.springframework.web.HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ApiError> handleMethodNotAllowed(org.springframework.web.HttpRequestMethodNotSupportedException ex,
            HttpServletRequest request) {
        return build(HttpStatus.METHOD_NOT_ALLOWED, ErrorCodes.METHOD_NOT_ALLOWED,
                "不支持的请求方法：" + ex.getMethod(), request, null);
    }

    @ExceptionHandler(com.ddlmate.common.ForbiddenException.class)
    public ResponseEntity<ApiError> handleForbidden(com.ddlmate.common.ForbiddenException ex, HttpServletRequest request) {
        return build(HttpStatus.FORBIDDEN, ErrorCodes.FORBIDDEN, ex.getMessage(), request, null);
    }

    @ExceptionHandler(ResourceInUseException.class)
    public ResponseEntity<ApiError> handleInUse(ResourceInUseException ex, HttpServletRequest request) {
        return build(HttpStatus.CONFLICT, ex.getCode(), ex.getMessage(), request, null);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiError> handleIllegalArgument(IllegalArgumentException ex, HttpServletRequest request) {
        return build(HttpStatus.BAD_REQUEST, ErrorCodes.INVALID_ARGUMENT, ex.getMessage(), request, null);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> handleUnexpected(Exception ex, HttpServletRequest request) {
        log.error("未预期的服务端错误 path={}", request.getRequestURI(), ex);
        return build(HttpStatus.INTERNAL_SERVER_ERROR, ErrorCodes.INTERNAL_ERROR,
                "服务器内部错误，请查看后端日志", request, null);
    }

    private ResponseEntity<ApiError> build(HttpStatus status, String code, String message, HttpServletRequest request,
            List<ApiError.FieldError> fieldErrors) {
        ApiError body = new ApiError(TimeZones.now(), status.value(), status.getReasonPhrase(), code, message,
                request.getRequestURI(), fieldErrors == null || fieldErrors.isEmpty() ? null : fieldErrors);
        return ResponseEntity.status(status).body(body);
    }
}
