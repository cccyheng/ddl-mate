package com.ddlmate.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 只为本地开发放行前端 dev server（127.0.0.1:5173）的跨域请求。
 *
 * <p>生产/演示模式下前端由后端静态托管，同源访问，不需要 CORS。
 * V1 不启用任何鉴权，因此不配置 allowCredentials。</p>
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOrigins("http://127.0.0.1:5173", "http://localhost:5173")
                .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .maxAge(3600);
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        // 前端构建产物（frontend/dist 或 Maven 构建时复制的静态资源）由后端托管：
        // 访问 http://127.0.0.1:8080/ 即可看到界面，无需再开前端服务。
        registry.addResourceHandler("/**")
                .addResourceLocations("classpath:/static/")
                .setCachePeriod(3600);
    }
}
