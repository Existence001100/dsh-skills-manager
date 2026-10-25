# RESEARCH — dsh-skills-manager 安装前确认门控：现状调研

> 状态：调研已完成，**未修改任何代码**。本文是设计与实现的证据基线，供 PR 引用。
> 行号基准：DSH `0.2.1-rc.2` + 插件 `1.0.6` 的工作区快照。后续改动导致行号漂移时，**以 API 名 / 函数名为准，不以行号为准**。
> 调研时间：2026-10-25 · 工作区：`项目四\dsh-skills-manager-plugin-main`

## 0. 环境与取证方法

| 项 | 值 | 证据 |
|---|---|---|
| DSH 版本 | `0.2.1-rc.2` | `<asar>/dsh/package.json` |
| DSH 形态 | Electron 打包，源码在 `app.asar` 内（`dsh/node_modules/@deepseek-ai/*`） | `...\resources\app.asar`（182 MB） |
| 插件版本 | `1.0.6` | `dsh-skills-manager-plugin-main/package.json:3` |
| 当前 profile | `desktop` = `dsh-base` + `dsh-web-app` + 第三方 bundle | `~/.dsh/profiles/desktop/package.json:19-32` |
| 审批策略 | `ask`（`workspace-write` 模式下） | `<asar>/.../dsh-base/cordis.patch.yml:259-263` |

`<asar>` 指 `C:\Users\17453\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`。

**取证可信度**：DSH 以 ASAR 归档分发，内含每个文件的 SHA-256。本次用只读解析器读出 `dsh/` 子树，并对 16726 个文件逐一比对归档内 hash：**0 处不匹配**，4,686 个文件因未归档 hash（二进制/符号链接）跳过。因此下文引用的 `文件:行号` 是对已发布产物的直接观察，不是推测。

---

## 1. 现有代码结构

### 1.1 匹配器：打分与 top-N 分流

| 环节 | 位置 | 事实 |
|---|---|---|
| 打分 | `lib.js:162-188` `scoreSkill()` | 名称命中 **+12**；trigger 命中 **+7**；描述 token 重叠 ≥0.5→**+6** / ≥0.25→**+4**；命中 ≥2 条理由再 **+1** |
| 排序 | `lib.js:232-251` `rankSkills()` | 只遍历 `ctx.skills.snapshot()` 的**已安装技能**；按分数降序 |
| 分流 | `lib.js:261-273` `selectActivations()` | `mode==='auto'` 且 `score>=autoThreshold(7)` → auto；`score>=suggestThreshold(4)` → suggest；上限 `maxAuto=2` / `maxSuggest=3` |
| 默认值 | `lib.js:28-36` `defaultConfig()` | `{enabled:true, maxAuto:2, maxSuggest:3, autoThreshold:7, suggestThreshold:4}` |

调用链：`agent/pre-step` 处理器（`index.js:805-947`）→ `ctx.skills.snapshot()`（`index.js:820`）→ 逐名 `ctx.skills.get()`（`index.js:832`）→ `rankSkills`（`:842`）→ `selectActivations`（`:843`）→ 注入 `createUserMessage` + `source.kind='plugin:dsh-skills-manager'`（`:881-911`）→ 返回 `{kind:'enter', messages:[...decision.messages, ...injections]}`（`:939-942`）。

**关键事实（D1）**：匹配器只对"已安装技能"打分。全仓库与 DSH 均无"未安装但可安装"的技能清单，`snapshot()` 是唯一数据源。

### 1.2 `skill_manager install` 的注册与调用路径

- 注册：`index.js:950-1002`，`defineTool({name:'skill_manager', parameters.action.enum = ACTIONS})`；`ACTIONS` 见 `index.js:90`。
- 执行：`execute()`（`index.js:986-993`）→ `runAction()`（`index.js:696-802`）→ `case "install"`（`:712-723`）→ `installSource()`（`:576-630`）。
- 落地：`normalizeGitSourceUrl()`（`lib.js:537-549`）→ `runGit()`（`execFile` + argv，`index.js:107-123`）→ `git clone --depth 1` → `findSkillDirs()`（深度 3）→ `installSkillFromSource()` 复制到 `<DSH_HOME>/skills/<name>`（`:538-574`）→ `applyState`/`saveState` → `notifyUpdate()`。
- **第二条 install 入口**：Settings RPC `POST /api/skill-manager`，`endpoint:"install"`（`index.js:1025-1026`）直接调 `runAction`，**不经过工具管线**。
- **粒度（D2）**：`installSource()` 把仓库中发现的所有 SKILL.md 全量装入（`:601-629`）。安装单元是 `owner/repo`；只有 `uninstall` 按技能名（`:680-694`）。

### 1.3 可用钩子

| Skill hook | DSH 事件 | 挂载处 | 可否阻断 |
|---|---|---|---|
| UserPromptSubmit | `agent/pre-step` | `index.js:805` | 可 `reject`（本插件未用） |
| **PreToolUse** | **`tools/pre-execute`** | **`index.js:383-403`** | **可 `deny` / `ask`** |
| PostToolUse / Failure | `tools/post-execute` | `index.js:407-446` | 可 `block` |
| SessionStart | `agent/created` / `agent/session-start` | `index.js:365-380` | — |
| SessionEnd / Stop | `agent/disposed` / `agent/turn-stopping` | 未实装 | — |

写法（`index.js:383-403`）：`ctx.on("tools/pre-execute", async (exec, next) => {...})`，先 `await next()`，仅在 `decision.kind === 'allow'` 时覆盖，返回 `{kind:'deny'|'ask', reason}`，可读 `exec.name` / `exec.arguments`。

### 1.4 配置接口

- `set-config`（`index.js:785-796`）**只接受** `enabled` / `maxAuto` / `maxSuggest`（各自钳制 0..8）。
- 工具 schema 的 `config` 同样只声明这三个字段（`index.js:964-973`）。
- state 中已存在 `autoThreshold` / `suggestThreshold` 且 `validateState()` 校验（1..20，`lib.js:584-585`），但**未通过 set-config 暴露**，只能手改 `skill-manager.json`。
- Settings RPC 的 `set-config`（`index.js:1023-1024`）同样只透传这三个。

### 1.5 Settings UI 的 source / hook count / commit

- 数据面：`managerView()` 每技能产出 `{source, scope, hooksCount, triggers, git:{sourceUrl, ref, commit, installedAt}}`（`index.js:478-505`）。
- 渲染面：`client/client.js:383` `sourceText = \`${skill.git.sourceUrl} @ ${skill.git.commit.slice(0,7)}\``；`:399` `sourceLabel(skill.source)` chip；`:403` `Hooks: ${skill.hooksCount}` chip；`:410-424` 按 Git source 聚合的 plugin 卡片（同样渲染 commit 与总 hooks）。

### 1.6 护栏

| 护栏 | 位置 |
|---|---|
| Git 来源白名单 | `lib.js:537-549`（长度 ≤2048、非 `-` 开头、仅 `owner/repo` / `http(s)://` / `git@` / `ssh://`） |
| argv 数组执行（无 shell） | `index.js:107-123`（git）、`index.js:253-285`（hook：`execFile(process.execPath, [script])`） |
| 钩子路径校验 | `lib.js:410-418` `safeRepoPath()`、`lib.js:421-427` `parsePluginHookCommand()`（只认 `node ${PLUGIN_ROOT}/x.js`，禁绝对路径与 `..`）、`lib.js:408,453` 仅 `SessionStart`/`UserPromptSubmit` 可执行 |
| 状态读入净化 | `lib.js:573-637`（`sanitizeHooks`、`safeRepoPath`、名称/枚举白名单） |

---

## 2. 调研结论（逐条，带证据）

### 2.1 Agent Loop 有无 `agent/pre-step`？签名/返回值？

**有，且同名。** `<asar>/.../dsh-agent-loop/lib/index.js:902-927`：

```js
const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal },
  () => ({ kind: "enter", messages: /* 已含 runtime-context 投影 */ }));
if (decision.kind === "reject") return decision;
```

- 入参：`{ agent, messages, turn, step, signal }`（`agent` 由 dispatch 注入；插件 `index.js:805` 正是这么解构）。
- 返回值：`{kind:'enter', messages}` 放行（可增删消息）／`{kind:'reject'}` 拒绝 → 不开 step（`dsh-agent-loop/README.md:120`）。
- 同点注入先例：`dsh-tool-skill/lib/index.js:896-930`（技能目录与 `/name` 调用均在此注入），与本插件同构。

### 2.2 如何列出已安装技能、读元数据？

`ctx.skills`（`@deepseek-ai/dsh-skill`）：
- `snapshot(lookup)` → `{skills:[summary], complete:boolean}`，合并所有 provider（`dsh-skill/README.md:50,94`）。
- `get(name, lookup)` → 完整定义（`metadata` / `whenToUse` / body），每次重读不缓存（`:98`）。
- 注册/失效：`register()` / `registerProvider()` / `invalidate()` + `skills/change`（`:52-53,102`）。
- 根与优先级：`dsh-skill-filesystem/README.md:46-56`；`watch:true`（`:74`）变更自动失效（`:81`）。

结论：**不自建技能注册表**，`snapshot+get` 即唯一真源。

### 2.3 插件安装审批入口？能否编程发起安装建议？

- 官方插件包安装走 `@deepseek-ai/dsh-plugin-manager`（`plugin_manager` 工具），门控是沙箱权限级："Every tool action requires `danger-full-access` or approval for that call."（`dsh-plugin-manager/README.md:31`）。
- 本插件的 `skill_manager install` **不走** `plugin_manager`，目前**无任何审批**（缺口即在此）。
- 编程发起：可注入消息（推荐）或直接调 `ctx.approval.request()` / `ctx.userQuestions.ask()`。**审批请求不携带工具参数**，只有 `toolName / callId / reason / displayReason`（`dsh-user-approval/README.md:52,155`；`dsh-tools/lib/types/index.js:1116-1123`）。

### 2.4 插件挂在哪个扩展点、如何注入提醒？

`export const inject = ["skills","tools"]`（`index.js:81`）→ 注册 pre-step / pre-execute / post-execute / `ctx.tools.register` / `ctx.inject(["connection","agentPresets"])`（`:1005-1062`）／跨插件事件 `ctx.events.dispatch("emit", …)`（`:198,248`）。
注入载体：`createUserMessage({content:[{type:'text'}], source:{kind:'plugin:dsh-skills-manager', form, …}})`（`:103-105,311-320`）。

### 2.5 插件间通信/依赖？

- 强依赖：`export const inject = [...]`。
- 软依赖：`ctx.get('approval')`（`dsh-tools` 即如此判空，`types/index.js:1103`）、`ctx.inject([...], cb)`。
- 事件总线：`ctx.on` / `ctx.emit`。
- 依赖声明：`package.json` `peerDependencies`（`package.json:52-57`）+ `dsh.bundle.patch`（`package.json:65-68`）。

### 2.6 `PreToolUse` 能否在 `skill_manager install` 前拦截并阻断？

**能。** 三段证据：

1. 管线（`<asar>/.../dsh-tools/lib/types/index.js:875-917`）：
   ```js
   const gate = await this.ctx.waterfall(carrier, 'tools/pre-execute', exec, () => ({kind:'allow'}));
   const askResolution = gate.kind === 'ask' ? await this.serviceAsk(exec, gate) : {decision: gate, …};
   if (denialReason !== undefined) return next({kind:'post-result', exec, result: /* `Error: ${denialReason}`，isError:true */});
   return next({kind:'dispatch', exec});   // 只有到这里才跑工具体
   ```
   `deny` ⇒ 工具体不执行，模型收到 `Error: <reason>`；`ask` ⇒ `serviceAsk()`（`:1102-1140`）→ `ctx.approval.request()`。
2. 本插件已在该钩子上（`index.js:383-403`），README `:214` 明示 `PreToolUse → tools/pre-execute`。
3. 对自身工具同样生效（`skill_manager` 是普通注册工具，全部调用过同一管线）。

补充：`ctx.tools.guard(fn)`（`types/index.js:521-533`）= 同步、单调、不可翻盘的 deny，适合硬开关，但不能 `ask`。

---

## 3. 审批接缝选型

| 候选 | 实际情况 | 结论 |
|---|---|---|
| `dsh-hitl` | **未找到**。`@deepseek-ai/` 下无此包，`dsh-base`/`dsh-web-app` 组合亦无 | 不存在，不可依赖 |
| `dsh-plugin-installer` | **未找到**。最接近的是 `dsh-plugin-manager`（`plugin_manager` 工具 / 侧边栏 Plugins 页）与 `dsh-plugin-market` + `dsh-plugin-market-index`（可安装 **plugin bundle** 的索引，非 skill 目录） | 命名不存在；单位不同（bundle ≠ skill） |
| `user-approval` | **存在**：`@deepseek-ai/dsh-user-approval`，服务键 `approval`；本环境已挂载，`policy: ask`（`dsh-base/cordis.patch.yml:259-263`）；浏览器应答器 `dsh-client-ui-approval`（`dsh-web-app/cordis.patch.yml:329-330`） | **选定** |

### 3.1 审批 UI 的两个硬限制（实测）

1. **换行被折叠**：主文案容器样式 `.j_8BDW_headline { color: …; font-size:15px; font-weight:500; line-height:24px }`，**无 `white-space: pre-wrap`**（`dsh-client-ui-approval/lib/client.js:11`）。⇒ `reason` 中的 `\n` 渲染为空格，多行载荷**不可能**在卡片里保留。
2. **`displayReason` 走本地化解析**：`displayReason === undefined ? approval.reason : props.resolveReason(approval.displayReason)`，而 `resolveReason = (reason) => ctx.locale.resolveText(reason)`（`client.js:43,349`）。⇒ 该字段语义是**本地化文案键**，不适合塞自由文本（仓库名/描述）。

样式里只有详情容器 `.j_8BDW_command` 带 `word-break: break-all` 与等宽字体，它渲染的是 `conversation.approval.detail` slot（`client.js:40`，按 `callId` 关联的工具调用详情）——即**卡片会自带"哪次工具调用"的详情**。

### 3.2 无内建超时

`request()`（`dsh-user-approval/lib/index.js:128-130`）要求 turn 打开（否则抛错），`decide()` 只把 answerer waterfall 与 `signal` 竞速（`:167-200`）：**没有 `setTimeout`**。没人回答 ⇒ 一直挂起；只有 `signal` abort 才 settle 为 `cancelled`。⇒ 未应答**不会自动放行**，但会一直等待。

---

## 4. 与原始设想的差异（D1–D8）

| # | 原设想 | 实际 | 影响 |
|---|---|---|---|
| **D1** | 匹配器能发现"未安装但相关"技能 | 不能；`rankSkills()` 只吃已装 `snapshot()`；DSH 与插件均无可安装技能目录 | **propose 缺候选数据源**，必须新增（本期定为本地 JSON catalog） |
| **D2** | 安装单元是技能名 | 是 `owner/repo`，整仓全量装入（`index.js:601-629`） | "技能名 ↔ repo" 多对一；卡片须说明"批准的是整仓安装" |
| **D3** | 卡片可复用 Settings 的 hook count/source/commit | 未安装时 `hooksCount` 不可得（来自 `ctx.skills.get()`，装完才有）；commit 需先 clone | 卡片只能标"预声明（未验证）"或"未知"，不得写 `hooksCount: 0` |
| **D4** | PreToolUse 也许不能阻断 | 能阻断且能 `ask`；fail-closed 由宿主内建 | 无需"改造分流层"或"包装 install 工具"两条退路 |
| **D5** | `dsh-hitl` / `dsh-plugin-installer` 可选 | 两者均不存在 | 选型只剩 `user-approval`（+ 可选 `user-questions`） |
| **D6** | 提议阈值可经现有 `set-config` 暴露 | `set-config` 只认三字段；阈值在 state 里但未暴露 | 需扩 `set-config`（`runAction` + 工具 schema + 客户端文案三处同步） |
| **D7** | 决策卡支持 approve/modify/reject | 审批卡只有 **allow-once / reject**（`client-ui-approval/README.md:36`；`dsh-user-approval/README.md:154`）；且卡片为纯文本、换行折叠 | **modify 无落点**，三态改二元；富卡片需另走 `userQuestions` |
| **D8** | Settings 的 install 也受门控 | Settings RPC 的 `install` 直接调 `runAction`（`index.js:1025-1026`），不过工具管线 | 门控只覆盖"模型发起的安装"；**用户在 Settings 点安装 = 用户亲自决定**（有意为之，需写明） |

良性确认：**watcher 闭环成立**。安装后文件落在 `<DSH_HOME>/skills`（`user-dsh`，rank 400），`watch:true` 自动 `invalidate()`，下一步 `snapshot()` 即可见（`dsh-skill-filesystem/README.md:74,81`；插件每步重读 `index.js:820`）。

---

## 5. 证据索引（供 PR 引用）

```
<asar>/dsh/package.json                                         DSH 版本
<asar>/dsh/node_modules/@deepseek-ai/
  dsh-agent-loop/lib/index.js:902-927                           agent/pre-step waterfall + reject
  dsh-agent-loop/README.md:120                                  pre-step 语义
  dsh-tools/lib/types/index.js:875-917                          pre-execute 门控 + deny 落地
  dsh-tools/lib/types/index.js:1102-1140                        serviceAsk → approval 映射（fail-closed）
  dsh-tools/lib/types/index.js:521-533                          ctx.tools.guard()
  dsh-user-approval/lib/index.js:128-130,167-200                request() 需 open turn；无 timeout
  dsh-user-approval/README.md:52,154,155                        请求字段／一次性／无参数
  dsh-client-ui-approval/lib/client.js:11,40,43,111,349         卡片 CSS（无 pre-wrap）、detail slot、displayReason→locale
  dsh-client-ui-approval/README.md:36                           allow-once / reject
  dsh-skill/README.md:50,94,98                                  snapshot/get 契约
  dsh-skill-filesystem/README.md:46-56,74,81                    根优先级、watch、变更检测
  dsh-tool-skill/lib/index.js:896-930                           pre-step 注入先例
  dsh-user-questions/README.md:29-31,33                          structured ask 能力与限制
  dsh-plugin-manager/README.md:31                               官方插件安装的权限门控
  dsh-base/cordis.patch.yml:259-263,308-315                     approval + skill 挂载与策略
  dsh-web-app/cordis.patch.yml:329-330,454-455                  ui-approval / ui-user-questions

dsh-skills-manager-plugin-main/
  index.js:81                                                   inject
  index.js:383-403                                              tools/pre-execute（PreToolUse）
  index.js:407-446                                              tools/post-execute
  index.js:696-802                                              runAction（install/set-config…）
  index.js:712-723                                              case install
  index.js:576-630                                              installSource（整仓安装）
  index.js:785-796                                              set-config（三字段）
  index.js:805-947                                              agent/pre-step（匹配与注入）
  index.js:950-1002                                             skill_manager 工具定义
  index.js:1005-1062                                            Settings RPC
  index.js:478-505                                              managerView（hooksCount/git 字段）
  lib.js:28-36 / 162-188 / 232-251 / 261-273                    配置默认值／打分／排序／分流
  lib.js:537-549 / 410-427                                      来源白名单／钩子路径校验
  lib.js:573-637                                                validateState
  client/client.js:383-424                                      Settings 渲染（source/commit/hooks）
```

## 6. 复现方法

1. 只读解析 `app.asar`：读 offset 0 起的 pickle 头（`u32@0=4`, `u32@4=headerPayloadSize`, `u32@12=jsonLen`, JSON 起于 16），`DATA_START = 8 + u32@4`。
2. 用归档内 `integrity.hash` 对每个文件做 SHA-256 校验，确认读到的就是发布字节（本次 16726/16726 通过）。
3. 按上表路径取 `README.md` 与 `lib/*.js` 交叉验证：**README 描述契约，lib 是实际执行体**，两者行号均已核对。
