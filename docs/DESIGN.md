# DESIGN — 安装前确认门控与能力缺口提案

> 版本：v1（2026-10-25）· 状态：P0/P1 已实现，P2 仅决策记录
> 配套：[RESEARCH.md](./RESEARCH.md)（只读事实基线）· 代码：`dsh-skills-manager-plugin-main/`
> 本文随实现迭代；调研事实不改写，只在本文件追加决策与实现结果。
> 副本关系：`docs/DESIGN.md`（仓库，规范副本）与工作区 `DESIGN.md`（起草原件）内容一致。P2 起以仓库副本为准，改完同步回起草件。

---

## 0. 决策记录

### 0.1 已拍板（Q1–Q5）

| 编号 | 决策 | 结果 |
|---|---|---|
| Q1 | 门控走「返回 `{kind:'ask'}`」还是「自己映射 `ctx.approval.request()`」 | **B：自己映射**。只有 B 能控制拒绝 payload（降级说明 + 结构化 `info`）。审批 UI 与审计不变，因为调用的是同一个 `request()` |
| Q2 | `installGate` 默认值 | **`ask`**。配套三件事：CHANGELOG 标 BREAKING、README 首屏提示、`off` 作为精确回滚开关放在显要位置 |
| Q3 | P0 是否同时 gate `update` | **是**。`update` 与 `install` 同级风险（拉远端代码、可引入新 hooks）。供应链攻击路径正是"先装无害版，再 update 到恶意版" |
| Q4 | 是否加"30 秒无应答自动拒绝" | **不做，也不加配置项**。无内建超时的语义已是安全侧（不回应就不装）。需要超时请在 agent 层用 `AbortSignal` 控制 |
| Q5 | 设计文档 | **落 `DESIGN.md`**；`RESEARCH.md` 只读 |

### 0.2 补充修正采纳情况（S1–S7）

| 编号 | 修正 | 采纳 | 落地 |
|---|---|---|---|
| S1 | `off` 改为 listener 常驻 + 入口 `if` 短路，不做动态绑定 | **采纳** | listener 始终注册；入口读 `installGate`，`off` 直接 `return decision`。无 disposer 生命周期，无"改值不生效"。`off` 时每次 `tools/pre-execute` 仍读一次 state（依赖 `loadState()` 的一次性缓存），**不是零开销** |
| S2 | 卡片禁用含糊的 "hooks unknown"，展开为完整句子 | **采纳** | 固定文案：`executable lifecycle hooks unverifiable before install`（P0 英文，语言策略见 §4.4） |
| S3 | `invalid-source` 前置 deny 是体验优化，文案逐字复用 `installSource` 报错 | **采纳** | 两条原文：`install requires url`、`unsupported git source (use owner/repo, https://, or git@)`；不另写文案。控制字符清理属**防御性第二层**：主路径 label 已过 URL 校验，`invalid-source` 分支走 `reasonOverride`、label 不进 reason |
| S4 | propose 借用 auto/suggest 的 `snapshot.complete` 判定，需显式说明 | **采纳（P1）** | 语义一致：清单不完整不推断能力缺口。实现时不得移动该 early-return |
| S5 | catalog 失败日志加频率控制 | **采纳（P1）** | 首次失败 warn 一次，后续静默，直到文件 mtime 变化或进程重启 |
| S6 | 明确测试脚手架现状并交付可执行测试 | **采纳** | 仓库已有 `node --test`（`package.json` 的 `test` 脚本 + `test.mjs`/`host.test.mjs`）。P0 附自动化单测，不交"手工清单" |
| S7 | `update` 卡片的当前 hooks 要区分"已实测 N"与"未知" | **采纳** | 能读到技能定义时输出 `N（已实测）`，读取异常时输出 `未知`；不统一写"未知" |

### 0.3 方案选型（B）的取舍

`{kind:'ask'}` 由宿主完成四态映射，模型只能收到宿主固定句（`dsh-tools/lib/types/index.js:1124-1139`），拿不到"降级说明"。因此门控自己调用 `approval.request()`，把 outcome 映射为 `allow` / `deny`：

- UI 与审计不变：同一张卡，同一对 `approval/asked` + `approval/decided`。
- 宿主不会再二次 `serviceAsk`：我们返回的 `gate.kind` 永远不是 `ask`，所以**不会双卡**。单测钉死该断言。
- fail-closed 由我们自己举证：4 条分支（缺失/异常/拒绝/取消）全部 deny。

---

## 1. 与原始需求的差异

### 1.1 调研修正（D1–D8）

| # | 原始需求 | 实际 | 处理 |
|---|---|---|---|
| D1 | 匹配器能识别"未安装但相关"技能 | `rankSkills()` 只吃已装 `snapshot()`；DSH 无可安装技能目录 | 新增本地 catalog（P1）；P0 不依赖 |
| D2 | 清单以技能名为单位 | 安装单元是 `owner/repo`，整仓全量装入 | 数据结构以 repo 为主键；卡片写明"整仓安装" |
| D3 | 卡片复用 Settings 的 hook count/source/commit | 未安装时 `hooksCount` 不可得 | 只允许"预声明（未验证）"或展开句（S2）；禁止 `hooksCount: 0` |
| D4 | PreToolUse 不能阻断时有两条退路 | 能阻断 | 退路作废 |
| D5 | `dsh-hitl` / `dsh-plugin-installer` 可用 | 均不存在 | 只用 `user-approval` |
| D6 | 提议阈值经 `set-config` 暴露 | 现只认 3 字段 | 扩 `set-config`（runAction + 工具 schema + 客户端文案）；`validateState` 缺省回退不抛错 |
| D7 | 决策卡 approve/**modify**/reject | 卡片只有 allow-once / reject | **modify 删除**，改二元 |
| D8 | Settings 安装也受门控 | Settings RPC 不过工具管线 | **有意为之**：用户亲手操作即已决策。代码注释 + README 写明 |

### 1.2 需求侧删除与新增

| 项 | 结论 |
|---|---|
| 三态 Approve/modify/reject | **删除 modify**，改 `allow-once` / `reject`。这是需求修正，不是妥协 |
| P2 静默安装 | **不做，不只是默认关闭**。与"最终决策权留给用户"直接冲突。写入"明确不做的决策" |
| 超时自动拒绝 | **不做，也不加配置项**（Q4） |
| `update` 纳入 P0 门控 | **新增**（Q3），文案独立 |
| 卡片换行 | 审批卡折叠换行（`client-ui-approval/lib/client.js:11`），所以卡片单行、清单走注入消息 |

---

## 2. 数据流

```
用户输入
  │
  ├─ agent/pre-step（既有 index.js:805；P1 只在内部增量）
  │    ├─ decision = await next()；reject → 原样返回
  │    ├─ [既有] auto / suggest 打分注入（不动）
  │    └─ [P1] propose 分支（仅 proposeEnabled）
  │          ├─ snapshot.complete === false → 静默（与 auto/suggest 同语义，S4）
  │          ├─ 读 catalog（失败 → 记账 + 静默）
  │          ├─ scoreSkill 打分 → 排除已装 → 门槛 → turn 去重 → maxPropose
  │          └─ 注入 1 条 form:'proposal' 消息
  │
  ├─ 模型决定是否调用 skill_manager install / update
  │
  └─ tools/pre-execute（P0 新增 listener，常驻注册）
       ├─ decision = await next()
       ├─ 非 skill_manager 或非 gated action → 让位
       ├─ installGate === 'off' → 让位（S1 短路）
       ├─ 上游已 ask → 让位 + warn（§9.1 已知局限）
       ├─ 上游已 deny → 让位（静默）
       ├─ installGate === 'deny' → deny(policy-deny)
       ├─ install：空白 url / 非法 URL → deny(invalid-source，逐字复用，S3)
       ├─ update：来源数为 0 → 让位（无 Git 操作可做）
       └─ installGate === 'ask'
            ├─ 无 agent / 无 approval 服务 → deny(no-agent | approval-unavailable)
            ├─ approval.request() 抛错 → deny(approval-error)
            ├─ allowed-once → 返回 allow（工具体执行）
            └─ rejected / cancelled / unavailable → deny(对应 code + 降级说明)
       │
       └─ 放行后：installSource / updateSources → 写 <DSH_HOME>/skills → watcher invalidate
            → 下一步 snapshot 可见（闭环）
```

**汇合点**：`模型调用 skill_manager install|update`。
P0 单独存在时门控已生效（独立价值）；P1 必须叠在 P0 之上评审。

---

## 3. 数据结构

### 3.1 catalog（P1，`<DSH_HOME>/skill-manager-candidates.json`）

```jsonc
{
  "version": 1,
  "entries": [
    {
      "repo": "owner/repo",                      // 必填，须通过 normalizeGitSourceUrl
      "name": "code-review-hardening",           // 可选，须满足 isSkillName
      "description": "评审 diff、找出过度设计",    // 必填
      "whenToUse": "当用户要求 review/审计时",      // 可选
      "triggers": ["review", "re:exit code [1-9]"], // 可选，与 metadata.triggers 同构
      "skills": ["code-review-hardening"],       // 可选，预声明（未验证）
      "hooks": { "PreToolUse": true },           // 可选，预声明（未验证）
      "verified": false                          // 可选，维护者是否人工核对
    }
  ]
}
```

上限：`entries ≤ 200`、`description ≤ 300`、`triggers ≤ 32`（单条 `≤ 200`）。
**硬约束：catalog 是广告牌，不是注册表。** 只允许"可安装来源 + 意图描述"；技能真实元数据只能来自 `ctx.skills`。

### 3.2 门控目标（P0 运行时）

```js
{ action: "install" | "update",
  label: "owner/repo" | "3 Git sources",   // 卡片与拒绝文案的可读标识（P0 英文）
  hooksSummary: "2 (measured)" | "unknown", // 仅 update 使用（S7）
  invalid: "install requires url" | "unsupported git source (…)"  // 命中即前置 deny
}
```

### 3.3 propose 注入消息（P1）

```js
createUserMessage({
  content: [{ type: "text", text: renderProposalText(entries) }],
  source: { kind: "plugin:dsh-skills-manager", form: "proposal",
            repos: [...], names: [...], turn, step },
})
```

模板（多行；模型侧不折叠）：

```text
[skill-manager · capability gap]
Trigger: "…≤160 chars…"
Suggested equipment (1/1 this turn):
1. owner/repo — description (≤200 chars)
   Score 7 (trigger:review)
   Gap: the installed skills do not fully cover this request
   Hooks: catalog declares PreToolUse (unverified)
   Source: allowlisted only
   Repository skills (catalog-declared, may be incomplete): code-review-hardening

Installing needs the user to approve this tool call. I will not install on my own.
If the user rejects or does not answer: continue with the installed skills and state the remaining gap.
```

模型可见文本一律英文（§4.4）。

### 3.4 拒绝 payload（P0，模型可见）

```js
{ kind: "deny",
  reason: "<多行：发生了什么 → 降级 → 可选下一步>",
  info: { name: "SkillInstallBlocked", code: "<§6 的 code>" } }
```

注册表把它渲染为 `Error: <reason>`，因此 `reason` 不带 `Error:` 前缀。
`code` 取值：`user-rejected` · `approval-cancelled` · `approval-unavailable` · `approval-error` · `policy-deny` · `invalid-source` · `no-agent`。

`invalid-source` 是唯一不写降级说明的 code：它的 `reason` 逐字复用 `installSource` 的报错（S3），保证模型只看到一种"非法来源"文案。

---

## 4. 决策卡文案

卡片折叠换行，所以**只发单行**；完整清单在 §3.3 的消息里。

### 4.1 `install`

```
Install <label> — whole repo, may include extra skills, executable lifecycle hooks unverifiable before install, source allowlisted. Allow once?
```

### 4.2 `update`（档位恒为 full）

```
Update <label> — pulls remote code, may add hooks, current hooks: <N (measured) | unknown>. Allow once?
```

### 4.3 可信度标注硬规则

| 信息 | 允许 | 禁止 |
|---|---|---|
| hooks（未安装） | `executable lifecycle hooks unverifiable before install`（S2） | 裸 `hooks unknown`、`hooksCount: 0` |
| hooks（已安装） | `current hooks: 2 (measured)` | 把实测值写成未验证 |
| hooks（读取异常） | `current hooks: unknown` | 编造数字 |
| 来源 | `source allowlisted`（仅表示通过 `normalizeGitSourceUrl`） | `safe source`、`trusted source` |
| 技能列表 | `whole repo, may include extra skills` | 断言仓库完整内容 |

`allowlisted` 只表示 URL 通过协议白名单，不表示内容可信。README 与卡片都不得把它读成"安全来源"。

### 4.4 语言策略（三层，不混用）

| 层 | 受众 | P0 语言 | 变化路径 |
|---|---|---|---|
| 拒绝 payload `reason` | 模型 | 英文 | 固定英文。英文拒绝语义跨模型最可预测 |
| 审批卡 `reason` | 用户 | 英文 | P1 若要本地化，只能走 `displayReason` + client locale 键。`reason` 是自由文本，不经 locale |
| README / CHANGELOG | 维护者 | 中英双份 | 沿用 `AGENTS.md` |

**不要用同一套 locale 机制同时服务模型与用户。** P0 选"卡片英文"是最小可交付；卡片本地化归入 §10 的 P2 成本项。

---

## 5. 配置项与兼容性

| 键 | 默认 | 取值域 | 依据 |
|---|---|---|---|
| `installGate` | `ask` | `ask` / `deny` / `off` | 门控默认开，否则出厂即失效。破坏性变更用 `off` 精确回滚 |
| `proposeEnabled`（P1） | `false` | bool | **P1 上线后默认体验与 P0 完全相同，需手动开启** |
| `proposeThreshold`（P1） | `7` | 1–20 | 与 `autoThreshold` 同源：7 = trigger 级强证据 |
| `maxPropose`（P1） | `1` | 1–4 | 一次一张卡，避免连弹 |
| `candidateCatalogPath`（P1） | `""` → `<DSH_HOME>/skill-manager-candidates.json` | 路径 | 空串回落默认 |

### 兼容矩阵

| 组合 | 行为 |
|---|---|
| 旧 state + 新插件 | `validateState()` 逐键回退默认，不抛错 |
| 新 state + 旧插件 | 旧 `validateState()` 重建 config 只保留旧键，新键被丢弃，不崩 |
| 旧客户端 + 新服务端 | 服务端多返回的字段被忽略 |
| 新客户端 + 旧服务端 | `set-config` 只挑已知键，新键静默忽略 |
| `installGate:'off'` | listener 让位，行为与改造前一致 |

---

## 6. fail-closed 矩阵

| # | 场景 | 用户看到 | 模型看到 | 安装/更新发生 |
|---|---|---|---|---|
| 1 | `approval` 服务不存在 | 无卡 | deny `approval-unavailable` + 降级说明 | 否 |
| 2 | `approval.request()` 抛错 | 无卡 | deny `approval-error` + 降级说明 | 否 |
| 3 | 用户 reject | 卡消失 | deny `user-rejected` + 降级说明 | 否 |
| 4 | 用户 allow-once | 卡消失 | 正常工具结果 | **是** |
| 5 | 用户取消 / turn 中止 | 卡消失 | deny `approval-cancelled` | 否 |
| 6 | 无人应答（无内建超时） | 卡持续挂着 | 无结果（挂起），直到 turn abort 转 #5 | 否 |
| 7 | `exec.agent` 缺失 | 无卡 | deny `no-agent` | 否 |
| 8 | `installGate:'deny'` | 无卡 | deny `policy-deny`（含 Settings 指引） | 否 |
| 9 | URL 非法 / 缺失 | 无卡 | deny `invalid-source`（逐字原文） | 否 |
| 10 | `installGate:'off'` | 无卡 | 无（原样放行） | 是（改造前行为） |
| 11 | 上游 listener 先 `ask` | 宿主卡（无审查文案） | 宿主映射 | **是（已知局限，§9.1）** |
| 12 | `update` 但来源数为 0 | 无卡 | **无（让位：原样返回 `next()` 的 decision，不代写报错）** | 否（本就无事可做） |

> #12 的"让位"是精确语义：返回 `next()` 的 decision 对象本身，不调用 `installSource`，也不构造拒绝文案。`updateSources()` 对空来源本来返回 `no changes`，由既有逻辑给出。
>
> #9 的等价性（A1）：`isGitSourceUrl(url)` 是 `normalizeGitSourceUrl(url) !== null` 的**纯 wrapper**（`lib.js:570-572`），等价性在定义层面成立，不需要测试来证明。`test.mjs` 的 17 行期望值表钉的是**共享规则的边界**（协议前缀、`-` 前缀、长度、空串、控制字符），所以规则改动、或 wrapper 被改成独立实现，都会变红。

---

## 7. 风险分级 → 卡片详略

| 条件（首个命中） | 档位 | 卡片必须含 |
|---|---|---|
| P0（无 catalog）任意 install | **full** | `whole repo, may include extra skills` + hooks 未验证句 |
| 任意 `update` | **full** | 拉远端 + `current hooks: N (measured)` 或 `unknown` |
| catalog 未声明 hooks（P1） | **full** | S2 展开句 |
| 声明 hooks 非空（P1） | **full** | 事件名 + 预声明（未验证） |
| 来源未验证（P1） | **full** | `source unverified` |
| 其余（P1 才可能命中 light） | light | 纯指令型 + 未声明 hooks |

原则：**未知按最坏处理**。P0 恒为 full。

---

## 8. README 改动清单

1. 首屏（`Quick start` 紧邻处）加一行：模型发起的 `skill_manager install|update` 现在需要一次性审批。
2. 显著位置给出回滚开关：`skill_manager set-config config={"installGate":"off"}`，并说明语义是"回到 1.0.x 行为"。
3. 新章节 `Install consent gate`：三态、默认 `ask`、拒绝后模型收到什么、Settings 手动安装免门控（有意为之）。
4. 新章节 `Candidate catalog`（P1）。
5. 新章节 `Decisions we deliberately do not make`：静默安装（不做）、modify 三态（卡片不支持）、安装前 hooks 探测（不做）、超时自动拒绝（不做也不配）、技能元数据写入 catalog（禁止）。
6. `Permissions and data`：新增"模型发起的安装"一行（已实现）。
7. "门控是插件策略，不依赖 skill hooks"与"上游 ask 会让审查文案失效"的说明：合并写进 `Install consent gate` 章节，不单独改 `Hook compatibility` 表，避免同一事实两处维护。
8. `Decisions we deliberately do not make`：新增章节（五项）。

---

## 9. 已知局限

### 9.1 上游 `ask` 优先（Q1）

若在门控 listener 之前已有别的 listener 对 `skill_manager install` 返回 `{kind:'ask'}`，本门控让位，宿主 `serviceAsk()` 会弹出**没有审查文案**的卡；用户批准即放行。

- 无法在 B 内修补：`gate.reason` 不可改写。
- 缓解：让位时记一条 warn（`skill_manager install intercepted by an earlier ask; review card skipped`），让运维可见。
- 当前环境（`dsh-base` + `dsh-web-app`）没有此类 listener，概率低，但不假装不存在。

### 9.2 无超时

见 Q4。卡片可能长时间挂起；这是安全侧。

### 9.3 未做安装前探测

未安装仓库的真实 hooks / commit 无法在不 clone 的前提下得知。卡片只能声明"未知"或引用 catalog 预声明。

### 9.4 门控与安装器一致，但不保证 git 可执行

`normalizeGitSourceUrl` 是前缀白名单，不是 URL 有效性校验。`https://`、含空格的 URL 等通过门控，`git clone` 随后失败。这是"门控只复用安装器判定、不引入第二套规则"的代价。把 URL 有效性校验下沉到 `normalizeGitSourceUrl` 属 P2，不在本期。

fail-closed 的语义是"未被批准的不执行"，不是"批准的一定成功"。用户可能看到"批准了却安装失败"，此时是 `installSource` 的报错，与门控无关。

---

## 10. 交付分层

| 层 | 内容 | 状态 |
|---|---|---|
| **P0** | `tools/pre-execute` 门控（install + update）+ 四种 outcome 映射 + 七个 code + `installGate` 三态 + `set-config` 扩展 + 单测 + README/CHANGELOG | 已实现 |
| **P1** | catalog 加载（含 S5 频率控制）+ `scoreSkill` 复用 + propose 注入 + turn 去重 + `maxPropose` + 静默降级 + 文案分工 | 已实现，已通过 P1 评审。**欠项：Settings 客户端控件未实现**（`installGate` 与 propose 四项只能经 `set-config`/state 文件配置），见 §10.1 |
| **P2** | 静默安装（不做）、**Settings 配置界面 + `userQuestions` 富卡片（同一 P2 里程碑，不接受拆分提交）**、`update` 的 SHA 预比对（不做）、层次化检索（备注） | 仅决策记录 |

**P2 追加记录（S-B，2026-10-25 评审）**：`parseCandidateCatalog` 只返回 `{ entries, dropped }`，无法区分"部分丢弃"与"全部丢弃"。当所有条目都被丢弃时，用户只看到 `dropped N invalid entries`，不易察觉"整个 catalog 失效"。修复需额外返回原始条目数 `total`，并在 `dropped === total` 时改用 `catalog unusable: all N entries dropped`。属措辞改进，不影响安全，留待 P2。

**P2 里程碑约束**：Settings 配置界面与 `userQuestions` 富卡片同属 client 层（共享 i18n 文件与渲染路径的测试范围），打包为**同一个 P2 里程碑，不接受拆分提交**。拆开做要跑两遍 `client-locales.test.mjs`，且第二次改动可能破坏第一次的渲染假设。

### 10.1 P1 的交付范围收窄：Settings 客户端控件（移入 P2）

**这是有意收窄 P1 的交付范围，不是遗漏。** P1 的范围声明包含 Settings 客户端控件，实际交付只覆盖 host 可配 + 工具 schema 可配。README 未声称 UI 可用（已 grep 核对），`set-config` 是完整的配置路径。本轮评审决定：UI 与 `userQuestions` 富卡片同属 client 层，打包为同一个 P2 里程碑。

受影响的五个配置键（UI 缺口的确切范围）：

| 键 | 默认 | 当前配置路径 | 图形入口 |
|---|---|---|---|
| `installGate` | `ask` | `set-config` / state 文件 | 无（P0 交付时即为 host-only；UI 从属 P1 的范围声明） |
| `proposeEnabled` | `false` | 同上 | 无 |
| `proposeThreshold` | `7` | 同上 | 无 |
| `maxPropose` | `1` | 同上 | 无 |
| `candidateCatalogPath` | `""` | 同上 | 无 |

| 项 | 现状 |
|---|---|
| 回滚路径 | 完整。README 首屏给出 `skill_manager set-config config={"installGate":"off"}` |
| 影响 | 功能、配置、文档完整；只缺图形入口，不影响安全语义 |
| 处理 | **移入 P2**，与 `userQuestions` 富卡片同一里程碑，不单独提交 |

### 10.2 里程碑流程建议（P2 立项时适用）

本轮出现过"范围声明含 UI、实际只交付 host 层"的偏差。P2 及后续里程碑立项时，范围声明按四层写清每层的"本期做 / 不做 / 收窄"，让"是否通过"可以逐层判定：

| 层 | P1 实例 |
|---|---|
| 功能层 | propose 注入、catalog、turn 去重、`maxPropose` 截断（本期做） |
| 配置层 | 五个键 host 可配 + 工具 schema 可配（本期做） |
| UI 层 | Settings 控件（收窄，移入 P2） |
| 文档层 | README 双语 + CHANGELOG + DESIGN 章节（本期做） |

---

## 11. P0 验证记录（2026-10-25）

| 检查 | 命令 | 结果 |
|---|---|---|
| 语法 | `node --check index.js lib.js test.mjs host.test.mjs` | 全部通过 |
| 纯逻辑单测 | `node test.mjs` | 38 通过 / 0 失败（含新增 8 条门控用例） |
| 宿主接线单测 | `node --test-name-pattern "gate:" host.test.mjs` | 15 通过 / 0 失败 |
| 包契约 | `node package-contract.test.mjs` | 3 通过 / 0 失败 |

三条环境事实，供复现：

1. 本工作区的 `node --test <files>` 会 spawn 子进程，被沙箱以 EPERM 阻断。改用 `node <file>` 单文件内联执行，测试语义相同。
2. 该 checkout 没有宿主依赖树。`pnpm install --frozen-lockfile` 只装 4 个直接 peer，`dsh-tools` 的传递 peer（`cordis`、`dsh-scope`、`dsh-session` 等）无法在冻结锁文件下解析。
3. 为验证门控路径，`host.test.mjs` 用最小 stub 替换 `index.js` 顶部导入的 4 个宿主模块（`dsh-tools`、`dsh-llm`、`dsh-skill`、`dsh-home-paths`）。**该 stub 只验证 listener 语义：decision 形状、`code`、`approval.request` 调用次数、以及让位行为。它不验证 `dsh-tools` 管线对 `deny` / `info` 的渲染，也不验证真实审批 UI。** 这两段属于宿主职责，由 CI 的真实 peer 覆盖。

验证后已删除 `node_modules` 与 `.pnpm-store`，仓库回到干净状态。

---

## 12. P1 设计（catalog 分支，已实现）

### 12.1 三问定案

| 问题 | 定案 | 理由 |
|---|---|---|
| turn 去重的 key | `WeakMap<Agent, number>`，值 = 上次提议的 `turn`；判据 `proposals.get(agent) !== turn` | 与 `pluginTurns` **不共享**：auto/suggest 每轮可重复，propose 每轮一次，共享会让一方改另一方语义。key 用 `agent`（`pre-step` 直接可见），随 agent GC。语义 = **每 turn 最多一张**，与 `maxPropose` 的"单轮上限"表述一致 |
| mtime 频率控制层 | `loadCatalog()` 内部；返回 `{ entries, error, errorMtime }`；propose 分支用闭包 `lastErrorMtime` 决定是否 warn | 只有 loader 同时拿到路径 + mtime + 解析结果，listener 不必二次 stat。"首次失败 warn、mtime 变化再 warn、进程重启重置"由闭包变量实现；**不用模块级全局**（多 profile 会串味） |
| `source.form`（实现期更正） | 线上**恒为** `"notice"`（`managerSource()`）；`"proposal"` 是 `summary` JSON 内的**载荷级** form | 实现时核对：`managerSource()` 固定 `form: "notice"`，插件自己的 form 存在 `summary` 里；`activation` / `suggestion` / `hook-inject` 都是载荷级。P1 沿用该结构，**不新增顶层 form**。`client/client.js` 对 `.form` 零引用，宿主无枚举 |

### 12.2 `loadCatalog` 契约

```js
// index.js（host）。lib.js 只保留纯函数 parseCandidateCatalog(text)。
async function loadCatalog(path) -> { entries, error, errorMtime }
```

| 状态 | 返回 |
|---|---|
| 成功 | `{ entries, dropped, mtimeMs }` |
| 读取/解析失败 | `{ entries: [], error: Error, errorMtime: <观察到的 mtime 或 undefined> }` |

- `version` 必须为 `1`；未知版本直接抛 `unsupported candidate catalog version`，避免 v2 文件被 v1 解析器静默接受（S1）。
- `dropped > 0` 时由 propose 分支按 `path::mtime` 警告一次，否则坏条目被静默丢弃、用户无从排查（S5）。

- 缓存：`Map<absPath, { mtimeMs, entries }>`；mtime 不变直接复用，不重复解析。
- 上限：`entries ≤ 200`、`description ≤ 300`、`triggers ≤ 32`（单条 `≤ 200`），超限按解析失败处理。
- 纯函数负责 schema 校验与上限，host 负责 FS 与缓存。
- **`errorMtime` 在文件缺失时为 `undefined`**，所以 listener 用 sentinel key（`errorMtime ?? "missing"`）判重。直接比较 `undefined !== undefined` 会让首次失败也不告警——该缺口由"缺失目录"用例抓出并修复。

### 12.3 静默降级 → 单测映射

| 条件 | 行为 | 单测断言 |
|---|---|---|
| `proposeEnabled:false` | 不读 catalog | spy 断言 `loadCatalog` 未被调用 |
| catalog 缺失 | 静默；首次失败 warn | 同 mtime 第二次调用不再 warn |
| 解析失败 / 超上限 | 同上 | 断言 `decision` 原样返回 |
| 全部低于 `proposeThreshold` | 不注入 | `messages` 长度不变 |
| 全部已安装 | 不注入 | 同上 |
| 同 turn 第二个 step | 不注入 | 连续两步同 turn → 只第一条注入 |
| `snapshot.complete === false` | 不注入（借用既有 early-return，S4） | 断言未读 catalog |
| 内部异常 | catch + warn，返回原 decision | 注入抛错 catalog，`decision` 不变 |

### 12.4 `maxPropose` 截断

- 排序沿用 `rankSkills`：score 降序、name 升序。
- 取前 `min(maxPropose, 命中阈值且未安装项数)`，`maxPropose` 钳制 1..4。
- 截断只作用于 propose 注入，不改 `auto` / `suggest` 的选择。
- 单测：`maxPropose=1` 且 3 个候选命中 → 只 1 条；`maxPropose=3` → 3 条。

### 12.5 注入消息

`source = managerSource({ form: "proposal", repos, names, turn, step })`，落盘为 `{ kind: "plugin:dsh-skills-manager", form: "notice", summary: "{\"form\":\"proposal\",…}" }`；正文见 §3.3（英文，§4.4）。

**不承诺用户可见**：它只是模型上下文，不新增 toast/弹窗/未读追踪。

### 12.6 验证（P1 已实现）

| 检查 | 结果 |
|---|---|
| `node test.mjs` | **45 通过 / 0 失败**（+7 条：catalog 解析与上限、未知 version 拒绝、candidates 打分、installed 判定、proposal 文案、verified 来源标注、空 query/无匹配） |
| `node --test-name-pattern "gate:\|propose:" host.test.mjs` | **26 通过 / 0 失败**（15 gate + 11 propose：默认关闭不读盘、坏目录每 mtime 只警告一次、目录缺失只警告一次、mtime 变化后再次警告、每 turn 一张、`maxPropose=1` 与 `=3` 两档、已安装跳过、`complete:false` 不读盘、弱证据静默、自定义 `candidateCatalogPath`、坏条目丢弃只警告一次） |

环境与 P0 相同（stub 边界见 §11）。`loadCatalog` 的 `{ error, errorMtime }` 契约由"每 mtime 只警告一次"用例覆盖；`maxPropose` 截断由"每 turn 一张且 capped"用例覆盖。

### 12.7 审查边界：V1/V2 的闭合方式

早期设计依赖三处**既有**代码，它们不在 P1 的 diff 内（属 P0 之前就存在的实现），所以只靠 patch 无法判定：

| 依赖 | 位置 | 事实 |
|---|---|---|
| `scoreSkill` 第三参 | `lib.js:184` | `extraTriggers = []`，与 `metadata.triggers` 合并；传 `[]` 等价于不传 |
| `reasons` 元素类型 | `lib.js:189`、`lib.js:196`、`lib.js:209` | 只 push 字符串（`"name"` / `` `trigger:${trigger.raw}` `` / `"description"`），返回 `{ score, reasons }` |
| `managerSource` | `index.js:113` | `data` 原样 `JSON.stringify`；顶层 `form` 硬编码 `"notice"`，无白名单 |

**闭合手段**：`proposal text` 与 `one per turn` 两条用例现在断言渲染文本包含 `trigger:review`、且不含 `[object Object]`。若将来 `reasons` 变成对象数组，这两条会立刻变红，不再依赖人工确认。
