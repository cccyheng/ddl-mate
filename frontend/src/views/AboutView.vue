<script setup>
import { onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { profileApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import LoadingState from '@/components/LoadingState.vue'
import { authState } from '@/utils/authState'

const loading = ref(true)
const error = ref('')
const saved = ref('')
const busy = ref(false)
const profile = ref(null)
const form = reactive({ displayName: '' })

const roadmap = [
  {
    version: '已上线',
    items: [
      '课程与课表：周视图（显示教师）/ 月视图切换；单双周、起止教学周、教学周校准；课表冲突检查',
      '导入课表：照片 OCR（浏览器本地识别）；导入教务抓包文件（HAR / JSON）；「课程抓取」书签一键从教务系统导入',
      '考试：「考试抓取」导入考场、座位号，未排时间的先导入为未定日期；智能复习安排（避开课多的日子、DDL 和其他考试，越近越密）',
      'DDL：任务、步骤清单、模板、重复任务、批量操作、全局搜索；从通知截图 / 文字生成待办；时间助手',
      '规划：今日计划（在课表空档里排时间块）、DDL 压力、学习周报',
      '专注：番茄钟 / 正计时，选择课程和正在做的任务；每周目标与专注记录',
      '提醒：截止提醒和上课提醒（网页开着时的浏览器通知）',
      '账号：开放注册、各账号数据隔离；修改密码、注销账号；忘记密码由站长发临时密码',
      '其他：问题反馈（站长可回复）、备份与恢复、浅色 / 深色主题、新版本提示',
    ],
  },
  {
    version: '计划中',
    items: [
      'DDL 错峰建议：某天 DDL 太多时，建议把哪些挪到哪天',
      '任务步骤设日期，并出现在日历和周视图里',
      '网页关着也能收到提醒（需要推送通知）',
      '校历：「国庆回来第一节课」「考试周前」这类说法自动换算',
      '手机 App 与网页版数据同步',
    ],
  },
]

onMounted(async () => {
  try {
    profile.value = await profileApi.get()
    form.displayName = profile.value.displayName
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
})

async function save() {
  busy.value = true
  error.value = ''
  saved.value = ''
  try {
    profile.value = await profileApi.update(form.displayName.trim())
    saved.value = '已保存显示名称'
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>关于与路线图</h1>
        <p class="page-head__sub">已经上线的功能，以及接下来的计划</p>
      </div>
    </div>

    <section class="card">
      <div class="card__head">
        <div>
          <div class="card__title">
            <AppIcon name="compass" :size="18" />
            功能一览
          </div>
          <p class="card__hint">有想要的功能，可以在侧栏底部的「问题反馈」里告诉站长</p>
        </div>
      </div>
      <div class="stack">
        <div v-for="item in roadmap" :key="item.version" class="roadmap-item">
          <div class="roadmap-item__version">{{ item.version }}</div>
          <ul style="margin: 6px 0 0; padding-left: 20px">
            <li v-for="line in item.items" :key="line">{{ line }}</li>
          </ul>
        </div>
      </div>
    </section>

    <div class="grid grid--2">
      <section class="card">
        <div class="card__title" style="margin-bottom: 8px">
          <AppIcon name="clock" :size="18" />
          时间语义
        </div>
        <dl class="definition">
          <dt>业务时区</dt>
          <dd>Asia/Shanghai（后端固定）</dd>
          <dt>API 时间格式</dt>
          <dd class="mono">2026-10-15T10:10:00+08:00</dd>
          <dt>存储方式</dt>
          <dd>数据库按 UTC 存储，读取时转回业务时区</dd>
          <dt>课表时间</dt>
          <dd>本地墙钟时间（HH:mm），不含日期与时区</dd>
          <dt>星期约定</dt>
          <dd>1 = 周一 … 7 = 周日</dd>
          <dt>「今天」</dt>
          <dd>按业务时区的自然日计算</dd>
          <dt>时间助手（V1.2）</dt>
          <dd>固定北京时间 <span class="mono">+08:00</span>，不随运行电脑时区变化；只有点「采用此时间」才写入表单 / 候选</dd>
        </dl>
      </section>

      <section class="card">
        <div class="card__title" style="margin-bottom: 8px">
          <AppIcon name="user" :size="18" />
          个人资料
        </div>
        <LoadingState v-if="loading" title="正在读取个人资料…" :rows="1" />
        <template v-else>
          <div v-if="error" class="alert alert--danger" style="margin-bottom: 12px">{{ error }}</div>
          <div v-if="saved" class="alert alert--success" style="margin-bottom: 12px">{{ saved }}</div>
          <div class="field" style="margin-bottom: 12px">
            <span class="field__label">显示名称</span>
            <input v-model="form.displayName" type="text" maxlength="64" />
          </div>
          <button class="btn btn--primary" type="button" :disabled="busy" @click="save">
            {{ busy ? '保存中…' : '保存' }}
          </button>
          <dl class="definition" style="margin-top: 16px">
            <dt>用户名</dt>
            <dd class="mono">{{ profile ? profile.username : '—' }}</dd>
            <dt>登录</dt>
            <dd v-if="authState.enabled">
              <span class="badge badge--success">已启用</span>
              账号密码登录，每个账号的数据相互隔离
            </dd>
            <dd v-else>
              <span class="badge badge--warn">未启用</span>
              本机单人版，只在这台电脑上使用
            </dd>
          </dl>
          <p v-if="authState.enabled" class="small muted" style="margin-top: 8px">
            修改密码、注销账号在 <RouterLink to="/account">账号与安全</RouterLink>。
          </p>
          <p v-else class="small muted" style="margin-top: 8px">
            本机版没有登录和密码，请不要把它暴露到公网。
          </p>
        </template>
      </section>
    </div>

    <section class="card">
      <div class="card__title" style="margin-bottom: 8px">
        <AppIcon name="spark" :size="18" />
        技术说明（供答辩 / 复现）
      </div>
      <div class="grid grid--2">
        <div>
          <h3 style="margin-bottom: 6px">后端</h3>
          <ul style="margin: 0; padding-left: 20px">
            <li>Spring Boot 3.5.6 + Java 21 + Maven</li>
            <li>Spring Data JPA / Hibernate，MySQL profile + H2 文件 dev profile</li>
            <li>Bean Validation 输入校验，统一错误响应结构</li>
            <li>附件：类型嗅探、大小限制、服务器生成文件名、路径穿越防护</li>
            <li>多用户：Hibernate 多租户按账号隔离数据；PBKDF2 密码哈希、登录限流、同源校验</li>
            <li>运维：每晚自动备份（数据库导出 + 图片打包，保留 14 天）、HTTPS 证书自动续期</li>
          </ul>
        </div>
        <div>
          <h3 style="margin-bottom: 6px">前端</h3>
          <ul style="margin: 0; padding-left: 20px">
            <li>Vue 3 + Vite + Vue Router，无额外 UI 框架</li>
            <li>真实 REST 客户端，含加载 / 空态 / 错误反馈</li>
            <li>浅色 / 深色响应式界面，桌面与手机浏览器均可用</li>
            <li>OCR 与抓包解析都在浏览器本地完成，图片和抓包文件不上传</li>
            <li>刷新后数据仍保留（数据都在后端数据库里）</li>
          </ul>
        </div>
      </div>
      <p class="small muted" style="margin-top: 12px">
        接口自查：<RouterLink to="/tasks">任务</RouterLink> ·
        <RouterLink to="/courses">课程</RouterLink> ·
        <RouterLink to="/calendar">日历</RouterLink> ·
        <a href="/api/meta/enums" target="_blank" rel="noopener">/api/meta/enums</a> ·
        <a href="/api/profile" target="_blank" rel="noopener">/api/profile</a>
      </p>
    </section>
  </div>
</template>
