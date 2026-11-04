package com.ddlmate;

import java.util.TimeZone;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * DDL Mate 后端入口（V1：任务 / 课表 / 日历 / 原通知）。
 *
 * <p>业务默认时区固定为 Asia/Shanghai：JVM 默认时区、Jackson 序列化时区、
 * Hibernate JDBC 写入时区在启动最早期统一设置，保证 API 输出的时间一律带 +08:00 偏移。</p>
 */
@SpringBootApplication
public class DdlMateApplication {

    public static void main(String[] args) {
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"));
        SpringApplication.run(DdlMateApplication.class, args);
    }
}
