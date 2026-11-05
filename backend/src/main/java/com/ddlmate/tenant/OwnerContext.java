package com.ddlmate.tenant;

import java.util.function.Supplier;

/**
 * 当前线程临时指定的数据归属用户（启动迁移、示例数据等没有登录会话的场景）。
 * 正常请求不用它：归属来自登录会话，见 {@link OwnerResolver}。
 */
public final class OwnerContext {

    /** 系统身份：不按用户过滤（只用于迁移等后台任务，绝不对外请求使用）。 */
    public static final long SYSTEM = 0L;

    /** 未登录：匹配不到任何数据，写入也不会落到真实用户名下。 */
    public static final long ANONYMOUS = -1L;

    private static final ThreadLocal<Long> OVERRIDE = new ThreadLocal<>();

    private OwnerContext() {
    }

    static Long override() {
        return OVERRIDE.get();
    }

    public static <T> T runAs(long ownerId, Supplier<T> action) {
        Long previous = OVERRIDE.get();
        OVERRIDE.set(ownerId);
        try {
            return action.get();
        } finally {
            if (previous == null) {
                OVERRIDE.remove();
            } else {
                OVERRIDE.set(previous);
            }
        }
    }

    public static void runAs(long ownerId, Runnable action) {
        runAs(ownerId, () -> {
            action.run();
            return null;
        });
    }
}
