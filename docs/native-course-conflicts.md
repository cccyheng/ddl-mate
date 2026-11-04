# 课表冲突检查（原生）

「课表冲突检查」回答一个问题：**从今天起 14 天（含今天）里，哪两条课表在同一天有真实重叠的上课时间。**

它是一页**只读**检查：

- 不写数据库、不改课表、不合并课程、不删除任何记录；
- 不自动调整时间，也不提供「一键修复」；
- 不发通知、不接 AI、不联网、不检查任务或 DDL 冲突；
- 不把结果说成整个学期的结论：页面始终显示固定窗口的真实起止日期。

## 从哪里进

「课程」标签页 →「课表冲突检查」→「检查未来 14 天课表冲突」。

路由名是 `CourseConflicts`，属于 `CourseStack`，没有参数。返回按钮与原生返回手势都能回到课程列表。

## 检查范围

- 固定 **14 个上海自然日**：`fromDateKey` 是进入 / 回到前台 / 跨零点时读到的上海今天，
  `toDateKey = fromDateKey + 13`，首尾都包含。
- 检查**今天已经过去的时段**也包含在内：检查的是日期窗口，不按当前时刻截断。
- 页面始终显示「今天起 14 天（含今天）」以及具体起止日期；不会暗示检查了整个学期。
- 课程或课表修改后返回本页，会重新读取本机快照并重算。

## 冲突怎么判定

### 1. 某天是否上课：直接复用既有规则

对每一天，用全应用唯一的 `occursOn` 判断某条课表当天是否上课，尊重已保存的：

- `weekday`（1=周一 … 7=周日）；
- `semesterStartDate`（学期第一周周一）；
- `startWeek` / `endWeek`（起止教学周）；
- `weekPattern`（`ALL` / `ODD` / `EVEN`，奇偶相对学期第一周）。

**没有新增 `weekNumberSet` 之类的按周集合模型。** 截图导入时选择的离散周次，仍然由导入后持久化的多条课表记录 / 起止周范围表达；本功能只读这些真实记录。

旧数据「学期首周一与起止周全空」沿用既有语义：按每周上课，不做周次限制。
**部分填写**（例如只有学期首周一、只有起止周、学期首周一不是周一、起止周反转或越界）不会被 `occursOn` 的旧数据兜底悄悄放过，而是整条跳过并逐条说明原因。

### 2. 同一天两条课表是否冲突：严格重叠

对同一天都上课的两条课表：

```text
重叠开始 = max(两条的开始时间)
重叠结束 = min(两条的结束时间)
重叠开始 < 重叠结束  →  冲突
```

因此：

- 08:00–09:00 与 09:00–10:00 **只是相邻，不算冲突**；
- 部分重叠、包含、完全相同都按上面公式给出真实重叠区间与分钟数；
- 三条课表同时重叠会输出三对（1–2、1–3、2–3），每对每天只出现一次；
- 同一条课表（相同课表 id）不会和自己配对；
- **同一门课的两条不同课表记录也会冲突**（例如重复导入，或同一门课分成两段）；
- `pairCount` 是**冲突对**数，`dateCount` 是**有冲突的不同日期**数，都不等于冲突课程数。

### 3. 坏数据：跳过并说明，不猜

以下记录整条跳过，`warnings` 逐条给出课表 id、类型与中文原因，`skippedCount` 是跳过条数：

- 课表 id 不是正整数（0、负数、小数、NaN、Infinity 都不行，避免生成打不开的编辑入口）；
- 星期不是 1–7 的整数；
- 时间不是 `HH:mm` / `H:mm`，或旧数据的 `HH:mm:ss` 带了**非零秒**
  （`:00` 秒仍接受；`:30` / `:99` 不会被静默截断）；结束时间不晚于开始时间（含零长度）；
- 学期首周一 / 起止周部分填写、日期不存在、首周一不是周一、起止周越界或反转；
- 单双周值不是字符串 `ALL` / `ODD` / `EVEN`；只有真正的 `null` / `undefined` / 空白字符串
  才按旧数据 `ALL` 处理，数字 / 布尔值 / 对象一律报无效。

只要有跳过项，页面就进入「部分数据」状态，明确写出「结果只覆盖通过校验的课表」；
如果全部课表都被跳过，页面显示「没有可参与比较的课表」，而不是「没有冲突」。

### 4. 课程记录缺失

课表引用的课程已不在本机时：

- 仍然使用这条课表的星期 / 时间 / 教学周参与冲突检测（不丢数据）；
- 课程名显示安全兜底「未知课程（可能已删除）」；
- **不提供**「查看课程 / 编辑课表」入口，避免跳到打不开的页面；
- 计入 `missingCourseCount`，页面进入「部分数据」状态并说明原因。

课程 id 本身无效（0、负数、小数等）也按「课程缺失」处理：不匹配任何课程对象，不提供跳转，
但课表仍参与时段比较。

正常课程显示 `Course.instructor`；未填写时显示「未填写」。地点未填写同样显示「未填写」。界面不显示内部课程代码。

## 页面状态

页面把以下状态分开，不用同一个「空」概括：

| 状态 | 用户看到 |
| --- | --- |
| 正在读本机数据 | `LoadingState` + 检查范围 |
| 本机数据读取失败 | `ErrorState` + 重试引导（仍显示检查范围） |
| 起止日期无法确定 | 明确「无法给出结论，这不是没有冲突」+ 重试读取 |
| 没有任何课表 | 「还没有课表」+ 返回课程列表 |
| 有课表但全部被跳过 | 「没有可参与比较的课表」+ 逐条原因 |
| 有可比较课表、没有冲突 | 「这 14 天没有发现时间冲突」，并注明只覆盖这 14 天与可比较部分 |
| 有冲突 | 按日期分组，展示全部冲突对，不截断 |
| 有跳过项 / 缺失课程 | 独立的「有数据未能完整参与检查」区块 |
| 刷新失败 | 保留上一次成功快照，页头标「可能是旧快照」，结果区标「可能不是最新」+ 重新读取 |
| 全部课表都无效 | 页头写「当前无法给出结论」，不显示「0 对冲突」这种假结论 |

页头摘要在数据真正就绪后才显示冲突对数；加载中 / 读取失败时不会拿空快照算出「0 对冲突」。
结果区同时显示「通过校验条数 / 课表总条数」，被跳过的条数在警告区逐条列出，不把无效课表算进检查数。

刷新失败**不会**把上一次的快照清空，也**不会**显示成「没有冲突」或「读取成功」。

## 每条冲突显示什么

每个冲突对显示：

- 日期与星期；
- 重叠开始–结束时间、重叠分钟数；
- 两条课表各自的课程名、教师、地点、完整起止时间、教学周说明；
- 两条课表各自的「查看课程」与「编辑课表」按钮（课程记录存在时）。

跳转参数与既有页面一致：

- `CourseDetail`：`{ id: entry.courseId }`
- `ScheduleForm`：`{ courseId: entry.courseId, scheduleId: entry.scheduleId }`

所有按钮使用既有 `AppButton`，触控目标 ≥ 44pt，并带中文 `accessibilityLabel`；
冲突对整体也有可播报的摘要标签。

## 刷新与时钟

- 进入页面（focus）：调用 store 的 `refresh()` 重读本机快照；同时 `useFocusClock(readShanghaiClock)`
  立刻同步一次上海日期。
- 回到前台（AppState active）：`useFocusClock` 同步日期，**用当前已加载的数据重算**；
  它不会额外再发一次数据库读取（只有进入页面会 refresh）。
- 跨零点：时钟读数变化，`fromDateKey` 跟着变，窗口整体后移；页面没有自建定时器。
- 离开页面：`useFocusClock` 清理定时器与 AppState 监听，不在后台空转。

## 公开 API

`mobile/src/domain/courseConflicts.ts`：

```ts
buildCourseConflicts({
  schedules,   // readonly Schedule[]
  courses,     // readonly Course[]
  fromDateKey, // YYYY-MM-DD（上海自然日）
}): CourseConflictsResult
```

`CourseConflictsResult` 是明确的判别联合：

- `status: 'ok'`：`fromDateKey` / `toDateKey` / `pairs` / `pairCount` / `dateCount` /
  `conflictDates` / `warnings` / `skippedCount` / `scheduleCount` / `validScheduleCount` /
  `missingCourseCount` / `hasIncompleteData`；
- `status: 'unavailable'`：`reason` 明确说明无法检查；`fromDateKey` / `toDateKey` 为 `null`，
  `pairCount` 为 0，但**不是**「成功检查后没有冲突」。

纯函数不修改输入，输出按「日期 → 重叠开始 → 课表 id」稳定排序。

## 边界（刻意不做的事）

- 不写数据库、不新建表、不改 schema、不需要迁移；
- 不新增依赖、不改全局配置、不改识别服务 / 伴侣服务；
- 不做自动合并、自动改时间、自动删除、批量修复；
- 不提供「忽略此冲突」的持久设置；
- 不检查任务 / DDL / 教室容量 / 教师冲突；
- 不把同一门课的两条记录自动去重（它们可能都是真实存在的课表）。

## 验证

本轮实际运行（固定 Node）：

```text
# mobile/
node node_modules/typescript/bin/tsc --noEmit
# exit 0

node --import ./tests/setup.mjs --test --experimental-test-isolation=none \
  tests/courseConflicts.test.mjs tests/courseConflictsWiring.test.mjs
# tests 43 / pass 43 / fail 0
```

受影响既有测试（课程批量保存、课表规则、日历、实时课表、三条导航接线）：

```text
node --import ./tests/setup.mjs --test --experimental-test-isolation=none \
  tests/scheduleRules.test.mjs tests/scheduleBatch.test.mjs tests/calendar.test.mjs \
  tests/timetableLive.test.mjs tests/ddlPressureWiring.test.mjs \
  tests/todayPlanWiring.test.mjs tests/taskStepsWiring.test.mjs
# tests 117 / pass 117 / fail 0
```

监督方独立 oracle（只运行，不修改）：

```text
# repo root
node --import ./mobile/tests/setup.mjs .supervision/native-course-conflicts-review.mjs
# 12 / 12 pass
```

**限制**：测试是纯函数与源码接线检查，没有在模拟器 / 真机上跑视觉与手势；
真实 SQLite / Expo 原生绑定未参与本功能（本功能不写库）。冲突检查只覆盖这里定义的
14 天窗口，以及通过数据校验的课表。
