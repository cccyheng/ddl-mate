<script setup>
import { onMounted, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { profileApi } from '@/api'
import AppIcon from '@/components/AppIcon.vue'
import LoadingState from '@/components/LoadingState.vue'

const loading = ref(true)
const error = ref('')
const saved = ref('')
const busy = ref(false)
const profile = ref(null)
const form = reactive({ displayName: '' })

const roadmap = [
  {
    version: 'V1（已实现并验收）',
    items: [
      '课程、课表（星期 / 起止时间 / 地点）管理',
      '单双周与教学周规则：学期第一周周一 + 起止周 + 每周/单周/双周，今日课程与日历都按规则过滤',
      '任务 CRUD：标题、课程、类型、DDL、优先级、状态、预计耗时、提交要求与方式',
      'DDL 排序与筛选、按月 / 按日查询、今日任务、首页概览统计',
      '月历视图：课程与 DDL 一起看，点任意日期进入当天详情（可刷新、可分享链接）',
      '原通知留存：文字 + 来源名 + 图片附件上传与下载',
      '本地单人资料，全部数据持久化在本地 H2 文件库',
    ],
  },
  {
    version: 'V1.1（本轮已实现：课表照片 OCR + 通知截图/文字转待办）',
    items: [
      '✅ 已实现：上传课表照片 → 浏览器本地 OCR（中文 + 英文）→ 可编辑候选 → 勾选确认后批量导入课表',
      '✅ 已实现：整图识别 + 框选单门课重新识别 + 查看 OCR 原文手工补候选；识别不到就留空提示，不臆测时间',
      '✅ 已实现：「从通知创建任务」(/tasks/import-notices)：粘贴文字或一次最多 8 张截图 → 浏览器本地 OCR → 可编辑候选 → 勾选确认后创建任务 + 原通知 + 原图附件',
      '✅ 已实现：通知候选由本地保守规则生成（课程完全同名才关联、只有完整日期 + 时刻才填 DDL、其余留空并提示核对），保存的截止时间显式带 +08:00',
      '⚠️ 边界：本轮**没有接入大模型 AI**，通知解析本身也没有做自然语言时间理解；「明天 / 下周五 / 下节课前」这类相对时间在**通知候选里仍然留空提示**，需要手工确认',
      '明确约束：抽取失败或未确认都不落库，原图始终保留；没有被勾选候选引用的来源与图片不会上传、也不会写库',
    ],
  },
  {
    version: 'V1.2（时间助手已实现，待独立验收）',
    items: [
      '✅ 已实现：只读接口 POST /api/tasks/resolve-time —— 简短时间短语 + 带偏移量的参考时间（+ 可选课程）→ 明确北京时间候选 / 需补信息 / 不支持 / 课表无匹配',
      '✅ 已实现：支持「今天 / 明天 / 后天 + 明确时刻」「本周X / 这周X / 下周X」「精确日期 YYYY-MM-DD HH:mm」，以及「下节课前 / 下次上课前 / 本周五上课前 / 下周五上课前 / 下周这门课前」',
      '✅ 已实现：课程说法复用真实课表的教学周与单双周规则；正在上的课不算下一次；下周严格下个自然周、没有课不越周；多节取最早一节，截止 = 上课开始边界（不提前扣分钟）',
      '✅ 已实现：新建 / 编辑任务与通知候选里的可折叠「时间助手」；参考时间默认现在的北京时间（可改为通知发布时间）；**点「采用此时间」才写入**，改依赖后旧建议作废、保存期间禁用',
      '⚠️ 边界：这是**本地确定性规则**，不是大模型。只有日期 / 只有时刻 / 今晚 / 尽快 / 周末 / 范围 / 多重时间 → 提示补全（绝不补 23:59）；否定 / 延期 / 更改 / 「…以前」/ 「下下周五」/ 多余数字 / 「下节课前两小时」等额外修饰 → 保守拒绝',
      '⚠️ 边界：带课程名或类型限定的「课前」（如「下次数学课前」「下周实验课前」）会被拒绝 —— 课表没有可靠的理论 / 实验分类字段，不替你猜是哪一节；请明确选择课程或写明确时间',
      '规划中：「国庆回来第一节课」这类需要校历，作为学期周次（semesters）扩展；整段通知的语义抽取仍属未实现的大模型部分',
    ],
  },
  {
    version: 'V2（方案已写，未实现）',
    items: [
      '大任务拆分成子任务，子任务进入日历',
      'DDL 冲突检测：按天汇总预计耗时并给出错峰建议',
      '每日学习计划：在课表空档里按 DDL + 耗时 + 优先级排时间块',
      '手机 / 桌面提醒：固定节点 + 根据任务状态动态提醒',
      '多用户与登录鉴权（正式上线前必须完成）',
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
        <h1>路线图与说明</h1>
        <p class="page-head__sub">当前版本的真实能力边界，以及后续三期的计划</p>
      </div>
    </div>

    <section class="card">
      <div class="card__head">
        <div>
          <div class="card__title">
            <AppIcon name="compass" :size="18" />
            功能分期
          </div>
          <p class="card__hint">原需求的十个功能分四期实现，避免同时铺开</p>
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
          本地资料
        </div>
        <LoadingState v-if="loading" title="正在读取本地资料…" :rows="1" />
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
            <dt>登录鉴权</dt>
            <dd>
              <span class="badge badge--warn">未启用</span>
              本版本仅绑定 127.0.0.1，单人本机使用
            </dd>
          </dl>
          <p class="small muted" style="margin-top: 8px">
            服务只监听 127.0.0.1，没有登录、没有密码、也请不要暴露到公网。多用户鉴权会在正式上线前加入。
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
          </ul>
        </div>
        <div>
          <h3 style="margin-bottom: 6px">前端</h3>
          <ul style="margin: 0; padding-left: 20px">
            <li>Vue 3 + Vite + Vue Router，无额外 UI 框架</li>
            <li>真实 REST 客户端，含加载 / 空态 / 错误反馈</li>
            <li>浅色响应式界面，桌面与手机浏览器均可用</li>
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
