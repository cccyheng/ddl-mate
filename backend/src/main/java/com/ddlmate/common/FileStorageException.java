package com.ddlmate.common;

/** 附件类型/大小不合规 → 415 或 413。 */
public class FileStorageException extends RuntimeException {

    private final int status;

    private final String code;

    public FileStorageException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public int getStatus() {
        return status;
    }

    public String getCode() {
        return code;
    }

    public static FileStorageException unsupportedType(String contentType) {
        return new FileStorageException(415, ErrorCodes.UNSUPPORTED_MEDIA_TYPE,
                "仅支持图片附件（png/jpeg/webp/gif），实际类型：" + contentType);
    }

    public static FileStorageException tooLarge(long size, long max) {
        return new FileStorageException(413, ErrorCodes.FILE_TOO_LARGE,
                "附件过大：" + size + " 字节，上限 " + max + " 字节");
    }

    public static FileStorageException invalidName(String name) {
        return new FileStorageException(400, ErrorCodes.INVALID_ARGUMENT, "文件名非法：" + name);
    }

    public static FileStorageException ioFailure(String detail) {
        return new FileStorageException(500, ErrorCodes.INTERNAL_ERROR, "附件读写失败：" + detail);
    }
}
