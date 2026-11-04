package com.ddlmate.web.dto;

import java.time.OffsetDateTime;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 设置读取结果。从未写过的键返回 {@code value=null, revision=0}，而不是 404，
 * 这样前端"读取 → 解码 → 显示空状态"只有一条路径。
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record SettingResponse(String key, String value, long revision, OffsetDateTime updatedAt) {
}
