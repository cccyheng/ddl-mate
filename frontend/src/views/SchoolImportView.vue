<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import { buildBookmarklet } from '@/import/schoolBookmarklet'

const bookmarklet = computed(() => buildBookmarklet(window.location.origin))
const link = ref(null)
const copied = ref('')

// 直接用 DOM 设置 href，确保拖到书签栏的就是完整的 javascript: 链接
onMounted(() => {
  if (link.value) link.value.setAttribute('href', bookmarklet.value)
})

async function copyCode() {
  try {
    await navigator.clipboard.writeText(bookmarklet.value)
    copied.value = '已复制。新建一个书签，把网址那一栏换成刚复制的内容即可。'
  } catch {
    copied.value = '复制失败：请手动选中下面的代码复制。'
  }
}

function explainClick() {
  window.alert('这个按钮要拖到浏览器的书签栏里使用：登录学校教务系统后，在教务页面上点这个书签。')
}
</script>

<template>
  <div>
    <header class="page-head">
      <div>
        <span class="page-head__eyebrow"><AppIcon name="download" :size="15" />工具</span>
        <h1>学校一键导入</h1>
        <p class="page-head__sub">
          登录学校教务系统后点一下书签，课表自动送到 DDL Mate 的导入页，核对后确认即可。目前支持大连海事大学教务系统（EAMS）。
        </p>
      </div>
    </header>

    <section class="card">
      <h2 class="card__title" style="margin-bottom: 10px"><AppIcon name="spark" :size="18" />第一步：把按钮拖到书签栏（只需一次）</h2>
      <p class="card__hint" style="margin-bottom: 14px">
        用电脑上的 Edge / Chrome：先按 <span class="mono">Ctrl+Shift+B</span> 显示书签栏，再按住下面的按钮拖到书签栏上。
      </p>
      <div class="row" style="gap: 12px; align-items: center; flex-wrap: wrap">
        <a ref="link" class="btn btn--primary bookmarklet" draggable="true" @click.prevent="explainClick">
          <AppIcon name="download" :size="16" />
          导入到 DDL Mate
        </a>
        <button type="button" class="btn btn--sm" @click="copyCode">拖不动？复制书签代码</button>
      </div>
      <p v-if="copied" class="small" style="margin: 10px 0 0">{{ copied }}</p>
    </section>

    <section class="card">
      <h2 class="card__title" style="margin-bottom: 10px"><AppIcon name="list" :size="18" />第二步：每次导入</h2>
      <ol class="steps">
        <li>在同一个浏览器里登录学校教务系统（校外经统一身份认证进入），打开「我的课表」或任意教务页面。</li>
        <li>点书签栏里的「导入到 DDL Mate」。会打开一个新标签页；如果提示要登录 DDL Mate，先登录。</li>
        <li>新标签页里出现候选课表：核对课程、时间、地点、教师和起止周，点底部的「确认导入」。</li>
      </ol>
      <p class="small muted" style="margin: 8px 0 0">
        学期第一周周一取自 <RouterLink to="/tools/teaching-week">教学周</RouterLink> 的校准（教务网页上没有这个日期），导入前请确认已校准。
        已有的同名课程默认以学校数据为准：教师改成学校登记的，原来的课表被替换（会先弹窗确认）。
      </p>
    </section>

    <section class="card">
      <h2 class="card__title" style="margin-bottom: 10px"><AppIcon name="check" :size="18" />安全说明</h2>
      <ul class="steps">
        <li>你的学校账号和密码只在学校网站上输入，DDL Mate 不会看到，也不会保存。</li>
        <li>书签在教务网站上用你自己的登录状态读取「我的课表」，和你手动打开课表页面是一样的请求。</li>
        <li>课表只在你的浏览器里从教务页面交给 DDL Mate 的导入页，在导入页本地解析；导入页只接收学校域名（*.dlmu.edu.cn）发来的数据。</li>
        <li>点「确认导入」之前，什么都不会写进你的账号。</li>
      </ul>
    </section>

    <section class="card">
      <h2 class="card__title" style="margin-bottom: 10px"><AppIcon name="alert" :size="18" />常见问题</h2>
      <ul class="steps">
        <li><b>点书签没反应 / 提示拦截了新窗口</b>：允许教务网站打开新窗口后再点一次。</li>
        <li><b>提示没有找到学期或学生编号</b>：教务系统登录过期了，刷新教务页面、重新登录后再点。</li>
        <li><b>手机上</b>：手机浏览器很难点书签，请用照片导入页里的「导入教务数据」，选抓包导出的 .har 文件。</li>
      </ul>
      <details style="margin-top: 10px">
        <summary class="small muted">查看书签代码</summary>
        <textarea class="mono" readonly rows="4" style="width: 100%; margin-top: 8px; font-size: 11px">{{ bookmarklet }}</textarea>
      </details>
    </section>
  </div>
</template>

<style scoped>
.steps {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 6px;
  font-size: 14px;
  line-height: 1.6;
}
.bookmarklet {
  cursor: grab;
}
</style>
