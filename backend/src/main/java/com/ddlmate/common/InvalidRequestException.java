package com.ddlmate.common;

/** 参数语义非法（例如课表开始时间晚于结束时间）→ HTTP 400。 */
public class InvalidRequestException extends RuntimeException {

    private final String field;

    public InvalidRequestException(String message) {
        this(null, message);
    }

    public InvalidRequestException(String field, String message) {
        super(message);
        this.field = field;
    }

    public String getField() {
        return field;
    }
}
