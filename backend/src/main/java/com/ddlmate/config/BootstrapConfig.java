package com.ddlmate.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import com.ddlmate.service.UserService;

/**
 * 启动时确保本机存在唯一的用户档案（V1 无鉴权，仅本地资料；也是未来多用户迁移的锚点）。
 */
@Configuration
public class BootstrapConfig {

    private static final Logger log = LoggerFactory.getLogger(BootstrapConfig.class);

    @Bean
    ApplicationRunner ensureLocalUser(UserService userService) {
        return args -> {
            var user = userService.currentUser();
            log.info("本地用户资料就绪：id={} username={} displayName={}（V1 未启用登录鉴权）",
                    user.getId(), user.getUsername(), user.getDisplayName());
        };
    }
}
