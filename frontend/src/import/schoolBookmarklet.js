/**
 * 「课程抓取 / 考试抓取」书签（bookmarklet）：一次点击同时带上本学期课表和考试安排。
 *
 * 用户在**自己的浏览器**里登录学校教务系统（EAMS）后点击书签：
 *   1. 先同步打开 DDL Mate 的导入页（必须在点击当下打开，否则会被当成弹窗拦截）；
 *   2. 以用户自己的登录状态，在教务网站同源下请求「我的课表」（与页面自身的请求完全一样）；
 *   3. 导入页加载好后发来 ddlmate:ready，书签用 postMessage 把课表 HTML 交给它（只发给 DDL Mate 的源）。
 *
 * 学校的账号密码、Cookie 都不会离开教务网站，也不会经过 DDL Mate 的服务器；课表在导入页里本地解析。
 *
 * 注意：下面的函数会被 toString() 后放进 javascript: 链接里执行，
 * 所以**不能引用这个文件里的任何其他变量**，所有东西都要写在函数体内。
 */

/* eslint-disable no-var */
function ddlmateSchoolImport(APP) {
  var win = window.open(APP + '/courses/import-schedule?from=school', 'ddlmate_school_import')
  if (!win) {
    window.alert('浏览器拦截了新窗口。请允许本网站打开新窗口（地址栏右侧通常有提示），然后再点一次书签。')
    return
  }
  var payload = null
  var failure = null
  var done = false

  function post(message) {
    try {
      win.postMessage(message, APP)
    } catch (e) {
      /* 窗口已关闭 */
    }
  }
  function flush() {
    if (done) return
    if (failure) post({ type: 'ddlmate:school-error', message: failure })
    else if (payload) post({ type: 'ddlmate:school-timetable', payload: payload })
  }
  window.addEventListener('message', function (event) {
    if (event.origin !== APP || !event.data) return
    if (event.data.type === 'ddlmate:ready') flush()
    if (event.data.type === 'ddlmate:received') done = true
  })

  var at = location.pathname.indexOf('/eams/')
  if (at < 0) {
    failure = '请先登录学校教务系统，在网址里带 /eams/ 的页面（例如「我的课表」）上再点这个书签。'
    flush()
    return
  }
  var base = location.origin + location.pathname.slice(0, at + 6)
  var semesterId = ''
  var form = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
  }

  /** 本学期考试安排：先像页面一样选定学期，再取考试列表；失败不影响课表。 */
  function fetchExams() {
    return fetch(base + 'stdExamTable.action', {
      method: 'POST',
      credentials: 'include',
      headers: form,
      body: 'examBatch.id=&project.id=1&semester.id=' + semesterId,
    })
      .then(function () {
        return fetch(base + 'stdExamTable!examTable.action?examBatch.id=&sf_request_type=ajax', { credentials: 'include' })
      })
      .then(function (response) {
        return response.text()
      })
      .then(function (text) {
        return text.indexOf('考试日期') >= 0 ? text : ''
      })
      .catch(function () {
        return ''
      })
  }

  fetch(base + 'courseTableForStd.action', { credentials: 'include' })
    .then(function (response) {
      return response.text()
    })
    .then(function (html) {
      var semester = /semesterCalendar\(\{[^}]*value\s*:\s*"(\d+)"/.exec(html)
      var ids = /addInput\(\s*form\s*,\s*"ids"\s*,\s*"(\d+)"\s*\)/.exec(html)
      if (!semester || !ids) {
        throw new Error('在教务页面里没有找到学期或学生编号，可能登录已过期。请刷新教务页面、重新登录后再点书签。')
      }
      semesterId = semester[1]
      var body = 'ignoreHead=1&setting.kind=std&startWeek=&semester.id=' + semester[1] + '&ids=' + ids[1]
      return fetch(base + 'courseTableForStd!courseTable.action?sf_request_type=ajax', {
        method: 'POST',
        credentials: 'include',
        headers: form,
        body: body,
      })
    })
    .then(function (response) {
      return response.text()
    })
    .then(function (text) {
      if (text.indexOf('TaskActivity') < 0) {
        throw new Error('教务系统没有返回课表：可能这个学期还没排课，或者登录已过期。')
      }
      return fetchExams().then(function (examText) {
        payload = { source: 'dlmu-eams', host: location.host, text: text, examText: examText }
        flush()
      })
    })
    .catch(function (error) {
      failure = (error && error.message) || String(error)
      flush()
    })
}
/* eslint-enable no-var */

/** 生成书签链接：appOrigin 是 DDL Mate 的网址（例如 https://ddlmate.example.com）。 */
export function buildBookmarklet(appOrigin) {
  const source = `(${ddlmateSchoolImport.toString()})(${JSON.stringify(appOrigin)})`
  return `javascript:${encodeURIComponent(source)}`
}

/** 导入页只接受这些网站发来的课表（学校域名；本机开发时也允许本机页面，方便测试）。 */
export function isTrustedSchoolOrigin(origin, appHostname = '') {
  let host = ''
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  if (host === 'dlmu.edu.cn' || host.endsWith('.dlmu.edu.cn')) return true
  const local = (h) => h === 'localhost' || h === '127.0.0.1'
  return local(appHostname) && local(host)
}

export const MAX_SCHOOL_PAYLOAD_CHARS = 8 * 1024 * 1024
