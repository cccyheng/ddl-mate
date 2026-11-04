package com.ddlmate.common;

/** 资源被引用、无法直接删除 → HTTP 409。 */
public class ResourceInUseException extends RuntimeException {

    private final String code;

    public ResourceInUseException(String message) {
        this(message, ErrorCodes.RESOURCE_IN_USE);
    }

    public ResourceInUseException(String message, String code) {
        super(message);
        this.code = code;
    }

    public String getCode() {
        return code;
    }
}
