package com.ddlmate.service;

import java.util.Locale;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;

import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.TimeZones;

/** 把接口上的排序/分页参数转成 Spring Data 的 Sort，并做白名单校验。 */
@Service
public class QuerySupport {

    private final int maxPageSize;

    public QuerySupport(@Value("${ddlmate.query.max-page-size:200}") int maxPageSize) {
        this.maxPageSize = maxPageSize;
    }

    public int normalizePage(int page) {
        return Math.max(page, 0);
    }

    public int normalizeSize(int size) {
        if (size < 1) {
            return 20;
        }
        return Math.min(size, maxPageSize);
    }

    /**
     * 任务排序白名单，默认按 DDL 升序（截止时间最早的在最前）。
     * 截止时间为空的排在最后，避免"没写 DDL 的任务"顶到最上面。
     */
    public Sort taskSort(String sort, String direction) {
        String key = sort == null ? "deadline" : sort.trim().toLowerCase(Locale.ROOT);
        boolean desc = direction != null && direction.equalsIgnoreCase("desc");
        return switch (key) {
            // 注意：不要用 Sort.Order.nullsLast()。
            // Spring Data JPA 会把它翻译成 Criteria 的 NULLS LAST，而 Hibernate 6.6 会抛
            // "Applying Null Precedence using Criteria Queries is not yet supported"。
            // 空值偏好由 TaskService 在内存比较器里实现（见 TaskService#search）。
            case "deadline" -> Sort.by(desc ? Sort.Order.desc("deadline") : Sort.Order.asc("deadline"))
                    .and(Sort.by(Sort.Order.desc("priority")));
            case "priority" -> Sort.by(
                    desc ? Sort.Order.desc("priority") : Sort.Order.asc("priority"))
                    .and(Sort.by(Sort.Order.asc("deadline")));
            case "createdat", "created_at" -> Sort.by(
                    desc ? Sort.Order.desc("createdAt") : Sort.Order.asc("createdAt"));
            case "updatedat", "updated_at" -> Sort.by(
                    desc ? Sort.Order.desc("updatedAt") : Sort.Order.asc("updatedAt"));
            case "title" -> Sort.by(desc ? Sort.Order.desc("title") : Sort.Order.asc("title"));
            case "course" -> Sort.by(Sort.Order.asc("course.code"))
                    .and(Sort.by(Sort.Order.asc("deadline")));
            default -> throw new InvalidRequestException("sort",
                    "不支持的排序字段：" + sort + "，可选：deadline、priority、createdAt、updatedAt、title、course");
        };
    }

    public java.time.ZoneId zone() {
        return TimeZones.zone();
    }
}
