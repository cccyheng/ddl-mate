package com.ddlmate.common;

/** 资源不存在 → HTTP 404。 */
public class ResourceNotFoundException extends RuntimeException {

    private final String resource;

    private final Object id;

    public ResourceNotFoundException(String resource, Object id) {
        super(resource + " 不存在：id=" + id);
        this.resource = resource;
        this.id = id;
    }

    public String getResource() {
        return resource;
    }

    public Object getId() {
        return id;
    }
}
