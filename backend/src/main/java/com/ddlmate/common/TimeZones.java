package com.ddlmate.common;

import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;

/**
 * 业务时区工具。全系统默认 Asia/Shanghai，所有"今天/本月"的判断都以此为准。
 */
public final class TimeZones {

    public static final String DEFAULT_ZONE_ID = "Asia/Shanghai";

    private TimeZones() {
    }

    public static ZoneId zone() {
        String configured = System.getenv("DDLMATE_TIME_ZONE");
        String id = (configured == null || configured.isBlank()) ? DEFAULT_ZONE_ID : configured;
        try {
            return ZoneId.of(id);
        } catch (RuntimeException ex) {
            return ZoneId.of(DEFAULT_ZONE_ID);
        }
    }

    public static OffsetDateTime now() {
        return ZonedDateTime.now(zone()).toOffsetDateTime();
    }
}
