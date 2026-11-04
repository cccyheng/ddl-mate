/**
 * `expo-notifications` 的**本机适配器**（只在原生运行时动态加载）。
 *
 * 这里不做任何业务判断：权限结果、排队列表、取消 / 新建都原样交给
 * `domain/taskReminderService.ts`。因此 node 测试可以换成假端口，不会 import 原生模块。
 *
 * 明确没做的事：
 * - 不申请远程推送 token、不配置 APNs / EAS / 凭据；
 * - 不操作角标（前台行为里 `shouldSetBadge: false`，内容里也不设 badge）；
 * - 不调用任何「取消全部通知」的接口，取消只按精确 ID；
 * - 启动时只安装前台展示 handler，**不**申请权限。
 */

import { Platform } from 'react-native'
import type { NotificationTriggerInput } from 'expo-notifications'

import { SHANGHAI_ZONE, offsetIsoToShanghaiParts } from './datetime'
import type { ReminderNotificationPort, ReminderScheduleContent } from './taskReminderService'
import { triggerAtMsFromNotificationTrigger, type ReminderPermissionState } from './taskReminder'

type NotificationsModule = typeof import('expo-notifications')

let modulePromise: Promise<NotificationsModule> | null = null
let handlerInstalled = false
// All notification producers share this final capacity-check + schedule queue.
let schedulingQueue: Promise<unknown> = Promise.resolve()

function loadNotifications(): Promise<NotificationsModule> {
  if (!modulePromise) {
    modulePromise = import('expo-notifications')
  }
  return modulePromise
}

async function ensureHandler(Notifications: NotificationsModule): Promise<void> {
  if (handlerInstalled) return
  handlerInstalled = true
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        // 明确不碰角标：这个模块只管理用户显式设置的任务提醒。
        shouldSetBadge: false,
      }),
    })
  } catch {
    // handler 安装失败不影响读取 / 排程；前台展示可能按系统默认处理。
  }
}

function unavailable(detail: string): ReminderPermissionState {
  return { status: 'unavailable', canAskAgain: false, detail }
}

function mapPermission(settings: Awaited<ReturnType<NotificationsModule['getPermissionsAsync']>>): ReminderPermissionState {
  const iosStatus = settings.ios?.status
  // 直接使用数值枚举：与安装的 SDK 57 类型一致（NOT_DETERMINED=0, DENIED=1,
  // AUTHORIZED=2, PROVISIONAL=3, EPHEMERAL=4）。不引入额外全局状态。
  if (typeof iosStatus === 'number') {
    if (iosStatus === 3 || iosStatus === 4) {
      return { status: 'provisional', canAskAgain: Boolean(settings.canAskAgain), detail: null }
    }
    if (iosStatus === 2) return { status: 'granted', canAskAgain: Boolean(settings.canAskAgain), detail: null }
    if (iosStatus === 1) return { status: 'denied', canAskAgain: Boolean(settings.canAskAgain), detail: null }
    return { status: 'undetermined', canAskAgain: Boolean(settings.canAskAgain), detail: null }
  }
  if (settings.granted) return { status: 'granted', canAskAgain: Boolean(settings.canAskAgain), detail: null }
  if (settings.status === 'denied') {
    return { status: 'denied', canAskAgain: Boolean(settings.canAskAgain), detail: null }
  }
  if (settings.status === 'undetermined') {
    return { status: 'undetermined', canAskAgain: Boolean(settings.canAskAgain), detail: null }
  }
  return { status: 'denied', canAskAgain: Boolean(settings.canAskAgain), detail: null }
}

export function createExpoTaskReminderPort(): ReminderNotificationPort {
  return {
    getPermission: async () => {
      try {
        const Notifications = await loadNotifications()
        await ensureHandler(Notifications)
        return mapPermission(await Notifications.getPermissionsAsync())
      } catch (cause) {
        return unavailable(
          `本机通知模块暂时不可用：${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    },

    requestPermission: async () => {
      try {
        const Notifications = await loadNotifications()
        await ensureHandler(Notifications)
        // 只请求提醒 / 声音；不请求角标，也不请求 provisional（安静授权由系统自行决定）。
        return mapPermission(
          await Notifications.requestPermissionsAsync({
            ios: { allowAlert: true, allowSound: true, allowBadge: false },
          }),
        )
      } catch (cause) {
        return unavailable(
          `申请通知权限失败：${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    },

    listPending: async () => {
      const Notifications = await loadNotifications()
      const scheduled = await Notifications.getAllScheduledNotificationsAsync()
      return scheduled.map((request) => ({
        identifier: request.identifier,
        data: request.content.data,
        trigger: request.trigger,
        title: request.content.title,
      }))
    },

    schedule: async (content: ReminderScheduleContent) => {
      if (!Number.isFinite(content.triggerAtMs) || content.triggerAtMs <= Date.now()) {
        // 最后一道防线：绝不让已经过去的时刻被系统当成「立即补发」。
        throw new Error('提醒时刻已经过去，没有安排通知。')
      }
      const Notifications = await loadNotifications()
      await ensureHandler(Notifications)
      /**
       * iOS 用**显式上海时区 + 完整日历组件**的一次性 CALENDAR trigger：
       * - 回读时系统会返回同样的 dateComponents，可精确验证绝对时刻；
       * - 不用 DATE trigger，因为它在 iOS 内部会变成 timeInterval(seconds)，
       *   而 seconds 是原生侧按 Date() 计算的，JS 侧的排程时刻无法证明真实绝对时间。
       * Android 继续用 DATE（回读 timestamp 可精确比较）。
       */
      const trigger: NotificationTriggerInput =
        Platform.OS === 'ios'
          ? (() => {
              const parts = offsetIsoToShanghaiParts(new Date(content.triggerAtMs).toISOString())
              if (!parts) throw new Error('提醒时刻无法换算成北京时间，没有安排通知。')
              return {
                type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
                timezone: SHANGHAI_ZONE,
                repeats: false,
                year: parts.year,
                month: parts.month,
                day: parts.day,
                hour: parts.hour,
                minute: parts.minute,
                second: parts.second,
              }
            })()
          : {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: new Date(content.triggerAtMs),
            }
      // 动态 import / handler 安装可能耗时；在真正调用原生 API 前再检查一次，
      // 避免慢准备把 Android DATE 推成「立即补发」。
      if (content.triggerAtMs <= Date.now()) {
        throw new Error('提醒时刻在等待原生模块时已经过去，没有安排通知。')
      }
      const schedule = async () => {
      const pending = await Notifications.getAllScheduledNotificationsAsync()
      if (pending.length >= 60 && !pending.some(p => p.identifier === content.identifier)) {
        throw new Error('本机通知队列已满，请稍后重新同步提醒。')
      }
      if (content.triggerAtMs <= Date.now()) throw new Error('提醒时刻已经过去，没有安排通知。')
      await Notifications.scheduleNotificationAsync({
        identifier: content.identifier,
        content: {
          title: content.title,
          body: content.body,
          sound: 'default',
          data: content.data as unknown as Record<string, unknown>,
        },
        trigger,
      })
      }
      const result = schedulingQueue.then(schedule, schedule)
      schedulingQueue = result.catch(() => undefined)
      await result
    },

    cancel: async (identifier: string) => {
      const Notifications = await loadNotifications()
      await Notifications.cancelScheduledNotificationAsync(identifier)
    },
  }
}

/** 仅用于以后可能的点击路由：判定 pending trigger 是否与期望时刻一致。 */
export function pendingTriggerAt(trigger: unknown): number | null {
  return triggerAtMsFromNotificationTrigger(trigger)
}
