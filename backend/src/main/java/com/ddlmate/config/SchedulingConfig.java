package com.ddlmate.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** 打开定时任务（每晚自动备份等）。 */
@Configuration
@EnableScheduling
public class SchedulingConfig {
}
