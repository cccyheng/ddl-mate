package com.ddlmate.web.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;

/**
 * 写入设置。
 *
 * @param value            原样保存的取值（通常是紧凑 JSON 字符串）
 * @param expectedRevision 调用方读到的版本号；第一次写入传 0。与库里不一致时返回 409
 */
public record SettingRequest(
        @NotNull(message = "取值不能为空") String value,
        @NotNull(message = "缺少版本号") @PositiveOrZero(message = "版本号不能为负数") Long expectedRevision) {
}
