# GoTavern v0.1.0-alpha.19 — 项目章程

**原始提示词 · 实测状态 · 最终目标 · 验收与证据纪律**

| 字段 | 值 |
|---|---|
| 文档路径 | `docs/alpha19/CHARTER.md` |
| 创建时间 | 2026-11-08（America/Los_Angeles；本机实测会话） |
| 创建者 | 首席工程执行 Agent（Lead） |
| 文档状态 | **DRAFT / 开工基线** — 这是 alpha.19 的开工章程，不是完成报告 |
| 事实来源 | 本机实测命令（附录 B），不采信记忆、不采信旧文档的自我声明 |
| 适用迭代 | `v0.1.0-alpha.19`（目标），基线 `v0.1.0-alpha.18` |

> **权威顺序（冲突时）**
>
> 1. 用户原始提示词（附录 A，逐字）
> 2. `GOAL.md`（锁定的项目目标）
> 3. `AGENTS.md`（验证规则与产品契约）
> 4. 本文件（alpha.19 的执行章程）
> 5. `HANDOFF.md` 的历史段落（仅作历史记录）
>
> 本文件与实测冲突时，以实测为准并立即修订本文件；本文件与用户提示词冲突时，以用户提示词为准。

---

## 0. 这份文件回答什么

1. 用户到底要求了什么 —— 附录 A 逐字保存原始提示词，不做摘要、不改写、不弱化。
2. 项目今天真实处在什么位置 —— 第 1 节，全部来自 2026-11-08 的本机实测。
3. alpha.19 的最终目标与“完成”的判定标准 —— 第 2、5、9 节。
4. 谁做什么、写哪些路径、按什么顺序做 —— 第 4、5 节。
5. 什么算证据、什么不算、哪些红线不可越过 —— 第 3、8、9、10、11 节。

一句话概括本文件的用途：**在开始写任何 alpha.19 代码之前，先把“我们在哪、要去哪、怎么算到”钉死在可核验的事实上。**

---

## 1. 实测状态（Status）

### 1.1 一句话状态

**`v0.1.0-alpha.18` 已发布，其 13 门同 SHA 证据成立；`v0.1.0-alpha.19` 尚未开工——产品代码改动 0 行、Subagent 0 个、Node-UI-Originated Corpus 0 份、alpha.19 CI 0 次、alpha.19 候选 0 个。本文件是 alpha.19 的第一个产物。**

这条状态必须被当作 alpha.19 的起点。任何后续报告若声称“已完成”，必须能指出本文件第 9 节中对应台账行从“未开始”变为“已证明”，并给出同一 SHA 的运行记录。

截至本文件提交时，alpha.19 唯一已完成的动作是：**工作分支 `alpha19/program` 已从 `52883e8` 创建，本文件作为该分支第一个提交**。其余一切（corpus、Oracle、修复、性能、并发、CI、发布）仍未开始。

### 1.2 仓库与远端（2026-11-08 实测）

| 项目 | 实测值 | 核验方式 |
|---|---|---|
| 工作目录 | `C:\Users\koishi\Desktop\GoTavern\gotavern` | 会话工作目录 |
| HEAD | `52883e8a048e4f29f6f574529d2491339106fe28` | `git rev-parse HEAD` |
| HEAD 标题 | `docs(goal): record that v0.1.0-alpha.18 is published (GOAL section 14 stays NOT MET)` | `git log -1` |
| 当前分支 | `main` | `git status -sb` |
| 与远端关系 | `## main...origin/main`（无 ahead / 无 behind） | `git status -sb` |
| 工作树 | 干净（`git status --short` 无输出） | `git status --short` |
| 远端 | `https://github.com/cocokoishi/GoTavern.git`（fetch + push） | `git remote -v` |
| origin/main | 与 HEAD 同为 `52883e8` | `git fetch origin --prune` + `git log --oneline origin/main -3` |
| 已有 tag（最新） | `v0.1.0-alpha.18`（annotated object `bc1289be633cffbf4808fd544bad6741757fc00c` → 候选 `a41772152a76cd3c42c52b63f2a377e2963de6fd`） | `git tag` / `git rev-list -n1` |
| 上一 tag | `v0.1.0-alpha.17` → `9b99fde0b0a9be0665cd93bc2143a3f495af31c2` | `git rev-list -n1` |
| 根目录本地构建产物 | `gotavern.exe`、`server.test.exe` 存在且被 `.gitignore` 忽略；`.\gotavern.exe version` 输出 `GoTavern 0.0.0-dev`，这是**未注入版本号**的本地构建，不是发布产物 | 直接运行 + `cmd/gotavern/main.go:28`（`var version = "0.0.0-dev"`） |
| alpha.19 工作分支 | `alpha19/program`（从 `52883e8` 创建；本文件是该分支第一个提交） | `git switch -c` / `git push -u origin` |

**结论：** 用户给出的“当前记录的 main：`52883e8`”与实测一致。远端没有出现需要重新定性的变动。不需要做“因远端变化先重新同步”的额外动作。

### 1.3 发布与验收现状

| 项目 | 实测/记录值 |
|---|---|
| alpha.18 是否已发布 | 是。`GoTavern Release` run `42477164985` 于 2026-11-08T11:48:35Z 发布 `https://github.com/cocokoishi/GoTavern/releases/tag/v0.1.0-alpha.18`，`draft=false`、`prerelease=false`、`latest=true`，含 6 个规范归档 + `checksums.txt` |
| alpha.18 同 SHA 门 | **PASS 13/13**，候选 `a41772152a76cd3c42c52b63f2a377e2963de6fd`（记录于 `docs/alpha18/same-sha-evidence.md`、`docs/alpha18/release-evidence.json`） |
| alpha.18 的 13 门（运行 ID） | `GoTavern CI` 42465368654；`GoTavern whole-session differential` 42465370968；`GoTavern world-info slot ordering` 42465373081；`GoTavern drop-in qualification` 42465375433；`Browser differential` 42465378269；`GoTavern release qualification` 42465380701；`GoTavern smoke metrics` 42465383084；`GoTavern Docker image` 42465385438；`Helper state differential` 42465387697；`Combination journey differential` 42465389791；`Third-party extension compatibility` 42465391902；`GoTavern long-lived corpus qualification` 42465394362；`GoTavern Node stock tree round trip` 42465396530 |
| 发布后独立验证 | 已记录（checksums 6/6、解包后二进制运行、installer smoke），见 `HANDOFF.md` 最新 checkpoint 的 B 段 |
| `GOAL.md` §14（强 drop-in 判定） | **NOT MET**（2026-11-08 记录）。原因：没有在“一个真实使用过的目录”上跑完 §14 的 6 条判定 |
| 当前 main 是否有红灯 | **有 1 个未定因红灯**：计划任务 `Third-party extension compatibility` run `42478967874`（2026-11-08T12:10:11Z，`main`，schedule）失败；失败 job 为 `soak`，失败步骤为 `Thirty-minute all-20 soak (both subjects)`。未定性为产品缺陷、驱动缺陷、CI 环境问题还是上游漂移。**alpha.19 开工必须先把这条分类并记录，不能假装 main 全绿。** |

### 1.4 语义 Oracle（pinned SillyTavern）状态

| 项目 | 实测值 | 核验方式 |
|---|---|---|
| Oracle 检出目录 | `C:\Users\koishi\Desktop\GoTavern\SillyTavern`（仓库外、只读） | 目录存在 |
| 检出 commit | `06bde939fb1e9c4c8d8641d810f0a916b5bce127` | `git rev-parse HEAD` |
| `git describe` | `1.19.0-1-g06bde939f` | `git describe --tags` |
| `package.json` 版本 | `1.19.0` | `ConvertFrom-Json` |
| 依赖 | `node_modules` 已安装 | `Test-Path node_modules` |
| 工作树 | 干净（核验时 `git status --short` 无输出） | `git status --short` |
| 是否允许修改 | **绝对禁止**。只能在独立临时目录中运行，用户数据由正常 UI 操作产生 | 用户提示词 §一.2 / `AGENTS.md` 硬规则 2 |

**这是本项目唯一合法的语义判定依据。** GoTavern 当前行为、手写 Mock 预期、现有测试通过、合成 JSON、猜测的 Node 语义，都不能作为最终 Oracle。

### 1.5 本机工具链与可用能力（实测）

| 能力 | 实测值 | 说明 |
|---|---|---|
| Go | `go1.27.3 windows/arm64` | 可本地构建与运行测试 |
| Node / npm | `v24.19.0` / `11.17.0` | 可运行 pinned SillyTavern 与探针 |
| GitHub CLI | `gh 2.102.0`，已登录 `cocokoishi`，token scopes：`read:org, repo, workflow, write:packages` | **具备推送分支、dispatch workflow、读取 run/job/artifact、创建 release 的能力** |
| Playwright | `tests/browser/node_modules` 存在；浏览器包位于 `.browser-bin` | 可运行真实无头 Chromium（必须遵守用户提示词 §一.4：headless、独立 context、不接管用户浏览器、结束关闭） |
| `-race` | **windows/arm64 不可用**（`HANDOFF.md` 已记录） | 并发数据竞争门只能由 Linux CI 的 `race` job 承担；本地不得伪称已跑 race |
| Docker | 本地能力未核验（alpha.18 的 Docker 门在 CI 上跑） | alpha.19 的 Docker 证据仍以 CI 为准 |
| 现有 CI 工作流 | `.github/workflows/` 共 21 个文件 | 其中 13 个是 `docs/release-manifest.json` 的 required gates |

### 1.6 已有可复用资产（**不得重复实现、不得推倒重来**）

alpha.19 不是从零开始。下列资产已经存在，正确做法是**复用、扩展、在同一语义上追加真实 UI 证据**，而不是新造一套：

| 领域 | 已有资产 | alpha.19 的正确用法 |
|---|---|---|
| 浏览器差分探针 | `tests/browser/` 下 100+ 个 `.mjs` 探针、比较器、自检器；`PAGE-CONTEXT.md` 记录“页面内代码在哪执行、读什么状态”的教训 | 复用其启动、端口租约、录制、比较器的成熟机制；新增 **UI-originated corpus 构建驱动**与**同输入双跑差分** |
| Provider wire Oracle | `tests/oracle/sillytavern-1.19.0-provider-wire.json`；`internal/server/*_oracle_test.go` 的逐场景回放 | 新 corpus 产生的 provider 请求必须与 pinned 逐字节比较；不得用 GoTavern 自己的输出定义预期 |
| 长寿命数据 | `tools/build-longlived-corpus.mjs`（**合成**生成器）、`tests/e2e/longlived_test.go`（Go 内合成） | **不能**把这两者冒充“真实 UI 使用产生的数据”；它们最多作为对照臂/负例 |
| 现有浏览器 journey | 整会话、Q20（swipe/regen/continue）、Q21（Node↔Go hand-back）、helper、regex、preset、worldinfo slots、group chat 等差分 | 复用其“同一输入、同两腿、同一比较器”的纪律；本次要求在**新 corpus**上重跑，而不是在旧 fixture 上重跑 |
| 性能 | `tools/perf/`、`internal/server` benchmark、`docs/alpha18/perf/`（profile + ABBA + soak 原始文件） | 以其为基线（第 7.3 节），先 profile 后改代码，同机同输入 ABBA |
| 发布轨道 | `docs/release-manifest.json`（13 门 + rails）、`scripts/verify-release-gates.mjs`、`.github/workflows/release.yml`、`scripts/classify-version-tag.sh`、installer、Dockerfile | alpha.19 新增门必须进入 manifest 并被 verifier 消费；版本由 `-X main.version=${VERSION}` 注入（见 `release.yml`），发布后必须验证产物 `gotavern version` |
| 证据台账 | `docs/goal-scorecard.md`（GOAL §7 的 22 个问题，唯一台账） | alpha.19 的证据必须更新这份唯一台账，不得另造第二份 scorecard |
| 历史决策 | `docs/alpha15/`、`docs/alpha16/`、`docs/alpha17/`、`docs/alpha18/`；alpha.17 的 R1–R6 拒绝决策 | 必须阅读并尊重；除非出现**全新的可复现证据**，否则不重开架构重构 |

### 1.7 Alpha.19 的增量缺口（必须新建，本文件列出的是“缺什么”）

1. **缺少 Node-UI-Originated Complex User Corpus。** 现有 `docs/longlived-corpus.md` 明确写了其语料是“synthetic and deterministic”（合成、确定性生成）；`tests/e2e/longlived_test.go` 是 Go 合成；`tests/browser` 的 fixture 也是合成/派生。用户提示词禁止把这些当作“LLM 真正作为用户在原版 UI 中长期操作产生的数据”。**这是 alpha.19 的第一优先级交付物。**
2. **缺少 Live Oracle。** 现有差分是在旧 fixture/旧 journey 上跑的。alpha.19 要求：真实 UI 产生的同一份数据目录 → 正常关闭 pinned → SHA256 manifest → 复制两份独立环境 → 一份跑 pinned Node、一份跑 GoTavern → 五层（浏览器 / HTTP / Provider Wire / 持久化 / 生命周期组合）逐项比较，并且**原版能在同一环境重跑、重新生成预期**，不是一次性静态 JSON。
3. **缺少真实的“从原版交接到 GoTavern 再交回原版”的同 SHA 端到端证据。** Q21 已有 hand-back，但输入是合成容器；alpha.19 的输入必须是本次 UI corpus。
4. **缺少 alpha.19 的候选与发布轨道。** 没有 `docs/alpha19/`（本文件是第一个）、没有 alpha.19 版本号、没有候选 commit、没有 alpha.19 的 CI wave、没有 release notes。
5. **缺少新增真实 UI Oracle 的 CI 执行入口。** 用户要求它在 CI 中有明确入口并能被发布门消费，而不是“本地脚本”。
6. **缺少 ≥8 用户并发与完整资源趋势的 alpha.19 证据。** alpha.16 的 8 用户性能行是 report-only；alpha.18 只有 60 分钟 soak 且泄漏判定为 UNPROVEN。
7. **缺少 24 小时级别运行的可行性结论。** 用户提示词说“必要时进行 24 小时级别测试”。要么真跑并记录，要么记录平台/预算限制，不得含糊。
8. **缺少 main 红灯 42478967874 的定性。**
9. **`GOAL.md` §14 仍是 NOT MET。** alpha.19 的目标是第一次用“真实 UI 使用过的目录”去满足 §14 的 6 条；但即使满足，也不能把它说成“某位真人多年目录已验证”（那台机器上没有），必须如实标注语料来源。

### 1.8 当前明确“尚未开始”的清单（防止把章程当成果）

- [x] alpha.19 分支创建、推送（`alpha19/program`，从 `52883e8` 创建；本文件是该分支第一个提交）
- [ ] 3 个长期 Subagent 创建（当前 0 个）
- [ ] pinned Node 在隔离临时目录启动并完成第一轮 UI 使用（当前 0 次）
- [ ] Node-UI-Originated Corpus 生成（当前 0 张卡、0 本世界书、0 份预设、0 条聊天、0 个群聊）
- [ ] corpus SHA256 manifest 与不可变副本（当前无）
- [ ] 真实 UI 五层差分（当前无）
- [ ] 任何 alpha.19 RED 测试 / 产品修复（当前 0）
- [ ] alpha.19 性能 profile / ABBA（当前 0）
- [ ] 8 用户并发 / 长稳（当前 0）
- [ ] alpha.19 CI 门（当前 0 次 dispatch）
- [ ] alpha.19 release notes / 候选冻结 / tag / 发布（当前无）

---

## 2. 最终目标（Final goal）

### 2.1 一句话目标

> **用 LLM 通过真实无头浏览器，在未修改的 pinned SillyTavern 1.19.0 中，从全新用户环境开始，长期、多轮、复杂地真实使用，产生一份复杂数据目录与完整观察记录；把这份目录交给 GoTavern 后，它在浏览器、HTTP、Provider Wire、持久化、生命周期五个层面的可观察行为与原版一致；同时用同机同输入的可复现测量证明 GoTavern 比 alpha.18 更省内存、更省 CPU、更快；并在同一个候选 SHA 上通过包含新增真实 UI Oracle 在内的全部门禁，按仓库规范发布 `v0.1.0-alpha.19`。**

### 2.2 产品目标（来自 `GOAL.md` §1a，alpha.19 不改变它）

GoTavern 是 **SillyTavern 服务器/后端的替代品**，不是重新发明一个酒馆。用户必须能够保留其现有前端、`config.yaml`、`data/`、角色卡、头像、背景、聊天、世界书、复杂预设、Quick Replies、Regex、STscript、变量、Personas 和扩展（含 Tavern Helper / JS-Slash-Runner），只替换后端。除明确的产品排除项外，GoTavern 必须在用户可观察的每个表面上等价。

判断兼容性的唯一句子（`GOAL.md` §3）：

> 对给定的角色、聊天、世界书、预设、helper 脚本、变量状态与用户输入，**最终到达模型后端的请求**在 pinned Node SillyTavern 与 GoTavern 之间相等——并且此后的持久化状态与浏览器状态也相等。

### 2.3 工程目标（来自 `GOAL.md` §1b）

- **轻、快**：启动、稳态与峰值 RSS、CPU 时间、尾延迟与大数据行为有可复现的改善；每项优化必须声明成本（`GOAL.md` §15）。
- **稳**：无 goroutine / 文件描述符 / 堆漂移，无缓存不一致或丢写类缺陷，无重试掩盖的失败，无隐藏的第二数据库。
- **清晰**：高内聚、明确所有权、可测试接缝；**不因文件长而拆分，不为好看而重构**。
- **诚实**：README、release notes、报告不得领先于证据；未证明的能力必须写 `partial` / `unproven` / `not implemented`。

### 2.4 alpha.19 的六项交付（缺一不可）

1. **Node-UI-Originated Complex User Corpus**（真实 UI 产生，非生成器伪造）
   - 通过 pinned 原版页面、导入按钮、设置面板、聊天界面与正常 API 路径产生；
   - 覆盖第 6 节的最低复杂度矩阵；
   - 至少三轮真实使用：创建 → 持续使用/修改 → 重启后继续使用；
   - 记录“Agent 实际执行了什么用户动作”，而不只是脚本名；
   - 产出 SHA256 manifest，原始输入不可变。

2. **Live Oracle（可重跑）**
   - 关闭 pinned、记录数据/配置/扩展与可变状态、计算完整 SHA256 manifest；
   - 同一输入复制到两个独立临时环境：一份 pinned Node、一份 GoTavern；
   - 不得同一可写目录同时跑两个服务；
   - 五层比较：浏览器层、HTTP 层、Provider Wire 层、持久化层、生命周期与组合层；
   - 归一化只允许“已被证实的非语义差异”（随机端口、明确可变时间戳、独立会话标识），每一项必须有原因、原版证据、字段、测试与负例验证。

3. **真实差分修复循环**
   - 每个不一致：原版复现 → GoTavern 复现 → 定位层 → 找到 GoTavern 根因 → 稳定失败的 RED 测试 → 最小修复 → RED→GREEN → 重跑相关 Oracle → 重跑组合 → 确认无性能回退；
   - 原版确有缺陷时，不得“修得更好”而擅自改变 GoTavern 语义；必须记录差异与兼容性决策。

4. **深度性能优化**
   - 先 profiling，再改代码；每项优化有优化前/优化后 profile、同机同输入 ABBA、冷/热缓存分别报告、Node 对照、完整语义回归、明确的退化项；
   - 严禁把 MB/op 误写为 Peak RSS；
   - 不得伪造样本、选择性报告或修改 benchmark 输入。

5. **复杂并发与长期稳定性**
   - 在原版创建的真实复杂数据上，而不是空白目录；
   - 多浏览器会话、多用户、并发保存不同聊天、并发更新世界书、并发群聊生成、并发角色列表、多个 SSE 长连接、Provider 超时与取消、重启后继续、扩展启停与状态保持、压力下读写文件；
   - 至少 8 用户并发场景与完整资源趋势；
   - Node 与 GoTavern 对照；不得用 RSS 单独证明无内存泄漏；
   - 平台限制必须诚实记录。

6. **CI 全量验收与发布**
   - 在固定分支、固定 commit 上；
   - Go 全量测试、`go vet`、Linux race、Oracle Fixture 差分、真实 Node UI Corpus、浏览器差分、Provider Wire 差分、复杂扩展组合、Node→Go→Node、大规模性能基准、真实发布包测试；
   - 原有 13 门 + 新增真实 UI Oracle 门，**同一 SHA 全绿**；
   - 每个关键 workflow 的实际 Job / Step / 日志 / Artifact 被检查；
   - 发布 `v0.1.0-alpha.19`：真实 Release URL、Tag、资产、checksums、已发布二进制运行证据；历史 tag 不得移动。

### 2.5 完成定义（DoD，alpha.19 结束前必须逐条可勾选）

**A. 真实 UI 语料**
- [ ] A1：pinned SillyTavern 在独立临时目录、独立数据/配置/端口/缓存中启动成功，未修改任何上游文件（用 SHA 证明 `public/`、`src/`、`package.json`、锁文件未变）。
- [ ] A2：≥30 张真实创建/编辑/复制/导入导出的角色卡，覆盖长描述、多 First Message、多 Alternate Greetings、示例对话、复杂字段、多头像、非 ASCII/中日文/Emoji/特殊字符。
- [ ] A3：≥8 本世界书、≥150 条复杂条目，覆盖常驻/关键词/递归/不同插入位置/深度/启停/角色绑定/全局/多世界书冲突。
- [ ] A4：≥10 套实质不同预设，且**证明不同预设真的产生不同 Provider Request**（不是 UI 上换名字）。
- [ ] A5：≥50 个独立聊天、累计 ≥1,000 条通过真实应用交互产生的消息，覆盖长度差异、分支、Swipe/Regenerate/Continue/Edit/Delete、刷新、服务器重启、导出导入、复杂元数据。
- [ ] A6：≥5 个不同群聊，覆盖不同成员、自动回复、手动指定、轮流生成、重排序、历史编辑、Swipe、Continue、重载持久化。
- [ ] A7：Personas、背景、Themes、Quick Replies、Regex、STscript、变量、宏、Tavern Helper、JS-Slash-Runner、扩展 iframe/事件/状态持久化，均通过原版支持的入口产生并可观察。
- [ ] A8：至少 8 类真实组合场景（见第 6.6 节）。
- [ ] A9：三轮使用记录（动作级，不是脚本名），含“原版 UI 中失败时如何定位”的记录。
- [ ] A10：语料 SHA256 manifest + 原始输入只读副本 + 可验证的生成/驱动代码版本。

**B. Live Oracle**
- [ ] B1：两独立环境（Node / Go）同输入、同前端、同扩展版本、同 Provider 模拟器行为。
- [ ] B2：浏览器层差分有 teeth（DOM 状态、图片真实解码、选中态、控制台错误、iframe、事件顺序、最终聊天状态）。
- [ ] B3：HTTP 层差分有 teeth（方法、URL/Query、Header、Body、状态码、响应头、响应体、SSE 字节边界）。
- [ ] B4：Provider Wire 层差分有 teeth（Messages 数组/角色/内容/System/世界书插入/Tool Calling/Reasoning/采样参数/Stop/Token Budget/截断/所有实际字段）。
- [ ] B5：持久化层差分有 teeth（新增/删除/修改、内容、JSONL、设置、角色卡、世界书、扩展状态、Persona、预设、跨重启）。
- [ ] B6：生命周期与组合层差分有 teeth（刷新、重启、插件加载、预设变更、聊天切换、多用户、Node→Go→Node 双向交接）。
- [ ] B7：每项归一化都有原因、原版证据、字段、对应测试、负例验证；禁止宽泛忽略。
- [ ] B8：不存在“Node 和 Go 都能聊天所以 PASS”的判定。

**C. 差分修复**
- [ ] C1：每个发现的不一致都有“原版复现 + Go 复现 + 分层 + 根因 + RED + 修复 + GREEN + 回归”。
- [ ] C2：RED 测试在修复前被实际观察到失败（`-count=1`；CI 中执行）。
- [ ] C3：修复后原版语义 Oracle 全部通过；未引入行为变化。

**D. 性能**
- [ ] D1：优化前 profile（CPU / heap / alloc）与优化后 profile，原始文件入库。
- [ ] D2：同机同输入 ABBA；热缓存与冷缓存分开；100 / 1,000 / 10,000 卡；长聊天；大世界书；多扩展；群聊；Provider SSE。
- [ ] D3：指标齐全：Startup p50/p95、列表 p50/p95/p99、Provider TTFT、SSE Relay Delay、CPU、Heap In-use、Total Allocated、Allocations/op、Peak RSS、Steady RSS、GC Pause、Goroutines、FD/Handle、Disk I/O、并发吞吐、取消后资源恢复。
- [ ] D4：Node 对照；每项退化明确列出；不得把 MB/op 当 Peak RSS。
- [ ] D5：所有优化不改变输出顺序、JSON 语义、Unicode 行为、Provider 请求或扩展事件；语义回归全绿。

**E. 并发与稳定**
- [ ] E1：≥8 用户混合负载；多浏览器上下文；并发保存/更新/群聊/列表；多 SSE；Provider 超时与取消。
- [ ] E2：重启后继续工作；扩展启停与状态保持；外部修改文件后的行为。
- [ ] E3：资源趋势（RSS/heap/goroutine/FD/CPU/延迟）有原始记录；不得用 RSS 单独证明无泄漏。
- [ ] E4：Node 与 Go 对照；平台限制如实记录；24h 级测试要么运行要么记录不可行原因。

**F. CI 与发布**
- [ ] F1：固定工作分支 + 固定候选 SHA。
- [ ] F2：Go 全量测试 / vet / Linux race / Oracle Fixture / 真实 UI Corpus / 浏览器差分 / Provider Wire / 复杂扩展 / Node→Go→Node / 大规模基准 / 真实发布包 全部通过。
- [ ] F3：新增真实 UI Oracle 有明确 CI 执行入口，并被 release gate 消费。
- [ ] F4：原有 13 门 + 新增门，**同一 SHA 全绿**；引用 `workflow name + run id + conclusion` 三者齐全。
- [ ] F5：发布包内容检查、发布二进制运行验证、Release URL / Tag / 资产 / checksum 记录。
- [ ] F6：历史 Release Tag 未移动；未 Force Push；未 Skip / 未降低断言 / 未改 Oracle / 未删失败测试。
- [ ] F7：`GOAL.md` §14 的 6 条判定在“本次真实 UI 语料”上运行并记录；若仍不满足，明确写 NOT MET 与缺口。

### 2.6 反 DoD（以下任何一条都不构成完成）

- ❌ 只有审计报告、计划、TODO、目录清单；
- ❌ 只有一次 Benchmark；
- ❌ 只有一次简单浏览器点击；
- ❌ “Go 测试全绿”；
- ❌ “CI 全绿”（而没有一个真实 UI 语料 journey）；
- ❌ “Node 和 Go 都能聊天”；
- ❌ 直接写 JSONL / 数据文件冒充用户操作；
- ❌ 用 GoTavern 当前输出或手写 Mock 预期当作 Oracle；
- ❌ 修改 pinned SillyTavern 的产品代码/前端/依赖/插件来让测试通过；
- ❌ 自动打开用户浏览器窗口；
- ❌ 通过 Skip、降低断言、修改 Oracle、扩大忽略列表、删除失败测试获得绿色；
- ❌ 把 MB/op 写成 Peak RSS；
- ❌ 把平台限制、不可用凭据、未执行的测试伪装成成功；
- ❌ 把“已发布 alpha.18”当作“alpha.19 已完成”。

### 2.7 `GOAL.md` §14 的判定规则（alpha.19 必须遵守）

`GOAL.md` §14 的强 drop-in 判定要求在同一 commit、同一真实目录上记录到 `docs/goal-scorecard.md`：

1. **真实目录，不是合成**：该目录确实被使用过，不是 Go 合成树 / 已提交合成语料 / 全新安装。
   - alpha.19 的 Node-UI-Originated Corpus **满足“确实被真实 UI 使用过”**，且不是生成器伪造，因此它可以作为 §14(1) 的输入；
   - 但它**不是**“某位真人多年使用的私有目录”，报告必须如实标注这一区别。
2. **字节普查**：数据根、可变安装树、扩展树在首次启动前与 journey 后全部哈希；每个差异要么是 pinned 在同一副本上做出的完全相同变更，要么是缺陷。
3. **journey 与 pinned 相等**：浏览器 journey、之后持久化状态、最终 provider 请求字节相等。
4. **Hand-back 与回滚**：GoTavern 写出的树交回 pinned 后继续可用；恢复启动前副本得到字节一致的树。
5. **失败路径安全**：被杀进程、满盘、只读目录、损坏聊天、并发写者都让用户数据可解析、可恢复，并保持 rule 12/24 的锁与原子写不变量。
6. **范围词随声明同行**：任何 README / release note / 图表 / 报告使用 “drop-in / compatible / safe / stable” 时，必须在同一处说明 1–5 哪些跑过、哪些没跑。

**结论：alpha.19 的最高目标是让 1–6 在本次 UI 语料上成立；若未全部成立，`GOAL.md` §14 继续写 NOT MET，且不得用“alpha.19 已发布”替代。**

---

## 3. 范围与硬边界

### 3.1 上游不可变（最高优先级）

不得修改 pinned SillyTavern 的任何：

- 生产源代码；前端 JavaScript / HTML / CSS；`package.json` / 依赖 / 构建配置；API 路由与服务端逻辑；插件源代码；原版语义或测试预期。

只允许：

- 在独立临时目录中运行原版；
- 由正常用户操作产生用户数据；
- 外部 Playwright、网络观察代理、进程监测等**不改变产品行为**的工具。

GoTavern 可以修改和优化；pinned SillyTavern 只能作为不可变 Oracle。

**证明方式**：对 pinned 检出的 `public/**`、`src/**`、`package.json`、锁文件、`default/**` 在 alpha.19 开始与结束各算一次 SHA256 manifest，必须字节一致；任何测试一旦发现上游工作树有改动，立即失败并停止。

### 3.2 禁止擅自添加功能（本轮不是功能扩张）

明确禁止：

- 自创 `.bak` 机制、额外备份系统、不属于原版语义的自动备份；
- 自创数据库、不必要的迁移层、无理由增加依赖、自创缓存框架；
- 为了“代码好看”重写成熟模块、重新设计前端、擅自更改接口或数据格式。

测试中可以使用隔离的临时目录副本做 A/B 差分；这些副本只是测试输入，**不得**成为 GoTavern 新增的产品备份功能。

### 3.3 浏览器规则

- 禁止自动弹出系统默认浏览器、打开桌面 GUI 浏览器、接管用户现有浏览器会话；
- 只允许独立测试环境中的 Playwright **Headless** Chromium；
- 完全无头、独立 Browser Context、独立 Cookie / LocalStorage / Profile、不显示窗口、不改默认设置；
- 测试结束正常关闭浏览器实例；
- **必须真正操作酒馆页面**，不能用直接写文件冒充用户操作。

### 3.4 Subagent 规则

- 最多 **3 个** Subagent，总量不得超过 3 个；
- 必须长期复用、按阶段持续派任务，禁止无限创建临时 Agent；
- 三个角色（见第 4 节）可并行推进独立任务，但**禁止同时修改相同文件或共享运行目录**；
- 每个测试数据集必须有独立所有权，避免并发工具互相污染证据；
- Subagent 报告是证据，不是摘要：必须列出检查过的文件、复现器、根因、不变量、改动文件、测试、CI run id、残余风险。

### 3.5 架构硬边界

- 不要因为文件长就拆文件；不要因为 `internal/server` 大就重构整个服务；不要因为看到重复代码就创建新框架；
- 保留已验证的关键结构、路径与接口；
- 若确需架构调整，必须同时满足：存在可复现缺陷或性能问题；有证据指向当前架构；可局部、可回滚；有可测量收益；所有语义差分通过；
- 必须阅读并尊重 alpha.17 的 R1–R6 拒绝决策，除非出现全新可复现证据。

### 3.6 证据纪律（来自 `AGENTS.md` 的差分测试教义，alpha.19 必须遵守）

1. **上游是 Oracle，差异按固定顺序回答**：pinned capture → 验证探针是否忠实 → 验证 fixture 是否有区分力 → 验证比较器/门是否有 teeth → 最后才问 Go 实现是否错。绝不从最后一步开始。
2. **Provider wire 保持字节导向**：`bodySha256`、`bodyLength`、原始 request target、方法、记录的头。禁止 canonicalise JSON、解析后重排、忽略成员顺序、丢弃未知头、用语义结构体比较替代原始字节。唯一可窄归一化的是真正非确定字段，且必须写明字段/路径、原因、上游证据。
3. **主体与 Oracle 不得共享预期**：可以共享进程生命周期、端口分配、临时目录、HTTP/SSE 工具、浏览器驱动机制、fixture 解析、报告机制；不得共享预期 provider body、预期响应映射、预期消息变换、预期状态/错误形状。
4. **每个门都必须有 teeth，且 teeth 要被演示**：添加或修改门之后，变异它守护的东西，展示具体失败的断言名，恢复后展示绿色。“命令退出 0”不是证据。Go 变异必须在 CI 中用 `-count=1` 跑。
5. **判定是分类学，不是布尔**：`match` / `mismatch` / `not-observed` / `pinned-unreachable` / `decided-exclusion` / `harness-error` / `candidate-error` / `nondeterministic-oracle`。浏览器腿没有产生 provider 请求、没有页面错误、也没有失败 HTTP 时，首先是 **HARNESS-FAITHFULNESS ALARM**，不是宣布产品坏了。
6. **禁止任何出网路径的 live network**（模块、全局 fetch、SDK 内部传输、原生 http/https、重定向、动态构造 host 都要替换）；每个 provider 探针必须能证明对端只收到 fixture 声称的请求。
7. **覆盖率是计算出来的，不是散文**；`N/A` 不是通过。
8. **窄化只降低成本，不降低强度**；只有全量 scheduled sweep 的绿色覆盖整个 oracle。
9. **绝不通过重录来把红变绿**；只有观察本身合法改变时才重录，并说明上游行为变了什么、为什么。
10. **证据必须可失败**：不能失败的断言、静默 no-op 的恢复、缓存的测试结果、从未执行的探针，都是“看起来像证据的假证据”。

---

## 4. 工作分解与所有权

### 4.1 三个长期 Subagent + Lead

| 角色 | 名称（工作代号） | 职责 | 独占写范围（建议） | 主要交付 |
|---|---|---|---|---|
| Subagent A | **Oracle / Real-UI 工程师** | 用无头浏览器真实操作 pinned 酒馆，建立复杂语料、探索真实行为、采集 Oracle；三轮持续使用；记录动作 | `tests/browser/a19-*.mjs`、`tools/a19-corpus/**`、仓库外 scratch（如 `C:\Users\koishi\Desktop\GoTavern\a19-oracle\`） | UI corpus、SHA manifest、动作日志、provider 捕获、浏览器 trace、失败分类 |
| Subagent B | **兼容性 / 差分修复工程师** | 读取 A 的语料与 Oracle，启动 GoTavern，定位真实差异；制作 RED 测试；最小修复产品代码；回归 | `internal/**`（产品代码，与 C 协商）、`tests/oracle/a19*`、`tests/e2e/a19*`、`docs/alpha19/findings*` | 差异台账、RED→GREEN 记录、产品修复、回归证据 |
| Subagent C | **性能与稳定性工程师** | profiling、CPU/RAM 优化、大规模数据性能、并发压测、性能回归；不得改语义 | `tools/perf/a19-*`、`internal/server` 中被 profiling 证明的热点文件（与 B 互斥）、`docs/alpha19/perf/**` | 优化前/后 profile、ABBA、RSS/CPU/GC/goroutine/FD 趋势、退化清单 |
| Lead（主 Agent） | 协调 / 集成 / 发布 | 冻结基线、分配任务、审阅证据、合并、CI、发布、最终判定；维护章程与台账 | `docs/alpha19/**`（章程/证据/发布记录）、`.github/workflows/**`、`scripts/**`、`docs/release-manifest.json`、release 相关 | 同 SHA 全绿、发布、最终报告 |

### 4.2 写路径所有权矩阵（防止并发互相污染）

| 路径 | 唯一 writer（同一时刻） | 说明 |
|---|---|---|
| `internal/**` 产品代码 | B（功能修复）或 C（性能优化），同一时刻只能一个 | 必须先在共享任务板声明本轮写范围；冲突时 Lead 仲裁 |
| `tests/browser/**` 新增 A 探针 | A | A 不碰既有探针，只新增 `a19-*` 文件 |
| `tests/browser/**` 既有比较器 | Lead 批准后由 A/B 中一人改 | 修改比较器必须证明 teeth 并重跑 selftest |
| `tools/a19-corpus/**` | A | B/C 只读 |
| `tools/perf/a19-*` | C | A/B 只读 |
| `docs/alpha19/**` | Lead | A/B/C 只提交各自子目录或由 Lead 汇总 |
| `.github/workflows/**`、`docs/release-manifest.json`、`scripts/**` | Lead | CI 入口与发布轨道只能 Lead 改 |
| 仓库外 scratch 目录 | 每个角色独立子目录 | 禁止共享运行目录；每个数据集的端口/目录/缓存独立 |

### 4.3 并行与顺序规则

- A、B、C 可以并行，但必须遵守：
  - B 在 A 产出第一版 corpus 之前，先做“读现状 + 搭 GoTavern 侧驱动 + 跑既有 Oracle 基线”，不得空等；
  - C 在 B 与 A 改动产品代码前先完成 alpha.18 基线 profile，避免基线被污染；
  - 任何产品代码改动前，B/C 必须在共享任务板登记写范围；Lead 确认无重叠后放行；
  - 每个数据集的端口、目录、缓存、浏览器 profile 全部隔离；
  - “同一可写目录同时跑两个服务”绝对禁止。
- 子 Agent 完成一项任务后，Lead 立即分配下一项未完成工作，禁止闲置。

---

## 5. 阶段计划（P0–P6）与门禁

> 每个阶段结束时必须产出可核验的证据文件（路径写进第 9 节台账），并在本文件或 `docs/alpha19/` 内记录“实际执行的命令 + 实际输出 + 未决问题”。

### P0 — 基线冻结与开工（Lead 主导，A/B/C 参与）

1. 从 `52883e8` 创建 alpha.19 工作分支（命名遵循仓库习惯，如 `alpha19/program`），**立即推送**，不堆积未推送提交。
2. 对 pinned SillyTavern 做 SHA256 manifest（`public/**`、`src/**`、`package.json`、锁文件、`default/**`），保存为 `docs/alpha19/oracle-pin.sha256` 或仓库外证据；alpha.19 结束时复核。
3. 构建当前 GoTavern（`go build ./...`、`go vet ./...` 的基线），记录本机耗时与二进制 SHA256。
4. 跑一组基准测试（`go test ./internal/server -count=1` 等，具体按耗时裁剪；最终以 Linux CI 为准），确认 52883e8 的基线状态。
5. 定性 `Third-party extension compatibility` run `42478967874` 的 `soak` 失败：是产品、驱动、CI 环境还是上游漂移；形成记录。
6. 创建 3 个 Subagent（A/B/C），把第 4 节职责与本文件路径交给它们；在共享任务板建任务并标注写范围。
7. 在 `docs/alpha19/` 建立：`README.md`（索引）、`decision-log.md`（决策与拒绝）、`evidence-contract.md`（证据契约）、`perf/`、`oracle/` 目录。

**P0 出门条件**：分支已推送；pinned manifest 已记录；构建基线已记录；main 红灯已定性；三个 Subagent 已启动并领取任务。

### P1 — Node-UI-Originated Corpus（A 主导）

1. 在独立临时目录检出/复制 pinned（保持 commit 不变），安装依赖，使用原版启动机制启动；独立数据目录、配置目录、端口、缓存。
2. 启动独立确定性 OpenAI-compatible Provider（只作为网络观察器与确定性响应器，不定义业务语义），记录其收到的每个请求（原始 body、头、目标 URL、时间）。
3. Playwright Headless 连接酒馆；从**全新用户环境**开始。
4. 按第 6 节矩阵，通过真实 UI 入口创建/编辑/导入/导出：
   - 角色卡与资源；世界书；预设与 Prompt；聊天与历史；群聊；UI/扩展/个人设置。
5. 至少三轮：
   - 第一轮：创建复杂环境；
   - 第二轮：作为真实用户持续使用（长聊天、改预设、编辑角色、改插件状态）；
   - 第三轮：重启原版后继续使用（历史遗留状态、缓存、持久化、复杂交互）。
6. 每轮记录 Agent **实际执行的用户动作**（页面、按钮、字段、结果），不只记录脚本名。
7. 若操作在原版 UI 中失败：调查是驱动问题、原版既有行为还是环境问题；**禁止**直接写文件伪造成功。
8. 正常关闭原版；记录数据目录、配置、扩展、所有可变状态；计算完整 SHA256 manifest；原始输入保持不可变（至少两份只读副本）。

**P1 出门条件**：语料数量达到第 6 节最低要求；三轮动作日志存在；manifest 存在；provider 请求原始记录存在；上游未被修改的 SHA 证明存在。

### P2 — Live Oracle 与五层差分（A 产出输入，B 主导比较）

1. 同一不可变输入复制到两个独立临时环境。
2. 一份运行 pinned Node；一份运行 GoTavern；两者使用相同前端文件、扩展版本、Provider 模拟器行为、配置语义。
3. 对同一组用户动作/同一组请求，采集五层观察：
   - A 浏览器层；B HTTP 层；C Provider Wire 层；D 持久化层；E 生命周期与组合层（详见第 8 节）。
4. 结果分类使用第 3.6 节第 5 条的 8 类判定，不许二值化。
5. 每个差异按第 2.4 节第 3 条进入修复循环。
6. 保存“原版重跑可重新生成预期”的证据：同一环境、同一动作、重跑得到相同预期（允许的归一化除外）。

**P2 出门条件**：五层差分报告；每个差异有分类与证据；无“未解释的 mismatch”；归一化清单完整且每项有负例。

### P3 — 差分修复循环（B 主导）

对每个不一致：

1. 在原版复现；2. 在 GoTavern 复现；3. 确定层；4. 找到 GoTavern 具体根因；5. 构造稳定失败的 RED 测试；6. 最小范围修改；7. RED→GREEN；8. 重跑相关 Oracle；9. 重跑复杂组合；10. 验证无性能回退。

无法复现的差异继续收集证据，禁止猜测修改生产代码。

原版确有缺陷时：记录差异与兼容性决策，明确是否属于已有许可的安全例外；不得为了“修得更好”改变 GoTavern 语义。

**P3 出门条件**：所有已发现可修差异 RED→GREEN；不可修差异有书面决策；语义回归全绿。

### P4 — 深度性能优化（C 主导，B 复核语义）

1. 先 profiling：CPU profile、heap profile、alloc profile，覆盖启动、列表、长聊天、大世界书、Provider SSE、群聊、多扩展。
2. 找到真实热点，写进 `docs/alpha19/perf/hotspots.md`；不得凭直觉改代码。
3. 每项优化：优化前/后 profile、同机同输入 ABBA、冷/热缓存分开、Node 对照、语义回归、退化项。
4. 指标按第 7 节；原始测量记录、硬件信息、OS 信息、测试代码版本必须保留。
5. 设立合理目标，但禁止为达标伪造样本、选择性报告、修改 benchmark 输入。

**P4 出门条件**：profile 文件齐全；ABBA 原始记录齐全；每项改动有语义回归；无未说明的退化。

### P5 — 并发与长期稳定（C 主导，A 提供多会话驱动，B 复核数据完整性）

1. 在 P1 的真实复杂数据上（不是空白目录）进行：
   - 多浏览器会话、多用户；同时保存不同聊天；同时更新世界书；同时群聊生成；同时读取角色列表；多个 SSE 长连接；Provider 超时与取消；重启后继续；扩展启停与状态保持；压力下读写文件。
2. 至少 8 用户并发场景 + 完整资源趋势。
3. Node 与 GoTavern 对照。
4. 资源趋势运行足够长；必要时 24 小时级；若不可行，记录具体限制。
5. 不得用 RSS 单独证明无内存泄漏；结合 heap、goroutine、FD、CPU、延迟。
6. 平台限制（如 Windows 无 race、macOS arm64 runner 不可用）如实记录。

**P5 出门条件**：8 用户场景记录；资源趋势原始数据；泄漏判定（证明/未证明）明确；Node 对照存在。

### P6 — CI 全量验收与发布（Lead 主导）

1. 冻结候选 SHA（所有代码、测试、文档、fixture 就位）。
2. 新增真实 UI Oracle 的 CI 执行入口：
   - 可以是新的 workflow，或现有 `Browser differential` 中的 required job；
   - 必须被 `docs/release-manifest.json` 消费（requiredGates 或 requiredJobs），使发布 verifier 真正强制它；
   - 必须有固定名 artifact，带 head SHA / pinned SHA / 选择证明；
   - 必须在同一候选 SHA 上真实运行并检查 Job/Step/日志/Artifact。
3. 更新 `docs/release-manifest.json`（门数从 13 变为 13 + 新增门）及所有断言门数的测试/文档/脚本；这是发布策略变更，必须单独提交并附理由。
4. 在候选 SHA dispatch 全部 required gates：
   - 原有 13 门 + 新增真实 UI Oracle 门；
   - 每门记录 `workflow name + run id + conclusion`；
   - 检查实际 Job / Step / 日志 / Artifact，不只信 run 级绿色。
5. 任何失败：判断产品故障 / 原版故障 / 驱动故障 / CI 环境问题；修真正根因；**同一候选 SHA** 重新验证；不准 Skip、降低断言、改 Oracle、扩大忽略、删失败测试。
6. 发布前：`scripts/verify-release-gates.mjs` 通过；release notes 不领先于证据；发布包内容检查；checksums。
7. 打 annotated tag `v0.1.0-alpha.19`（版本由 tag 名注入 `-X main.version`）；运行 `GoTavern Release`；记录 Release URL、Tag、资产、checksums。
8. 发布后独立验证：下载发布包、校验 checksum、解包、在干净环境启动、`gotavern version` 输出正确、读写闭环、installer smoke。
9. 历史 tag 不变；不 Force Push；不移动旧 tag；不删除失败日志。

**P6 出门条件**：同一 SHA 全部门绿（13 + 新增）；发布完成并验证；`docs/alpha19/` 记录齐全；最终报告 A–G 段完整。

---

## 6. 覆盖矩阵（最低要求，A 必须达到并可证明）

### 6.1 角色与资源

- ≥30 张真实角色卡；
- 不同描述长度；
- 多种 First Message；
- 多个 Alternate Greetings；
- 角色示例对话；
- 高复杂度角色卡字段；
- 多张头像；
- 角色编辑、复制、重命名、导入与导出；
- 正常 UI 支持的角色格式；
- Sprites、替换头像、多资源场景；
- 非 ASCII、日文、中文、Emoji；
- 特殊字符、换行、转义字符。

### 6.2 世界书与触发机制

- ≥8 本世界书；
- ≥150 条复杂条目；
- 常驻、关键词、递归触发；
- 不同插入位置；
- 多种深度；
- 条目启用与禁用；
- 角色绑定世界书；
- 全局世界书；
- 多世界书冲突；
- 故意构造上下文竞争场景。

### 6.3 预设与 Prompt

- ≥10 套实质不同预设；
- 不同上下文长度；
- 不同 Prompt Manager 排列；
- System Prompt；
- Author's Note；
- 不同示例对话插入模式；
- 不同 Token Budget；
- 不同世界书优先级；
- 不同模型来源和可用参数；
- 预设切换；
- 预设编辑后立即生成；
- 保存、重载后的状态恢复；
- **必须证明不同预设真的产生不同 Provider Request。**

### 6.4 聊天与历史

- ≥50 个独立聊天；
- 累计 ≥1,000 条通过真实应用交互产生的消息；
- 多种聊天长度；
- 多条历史分支；
- Swipe、Regenerate、Continue、Edit、Delete；
- 多次保存与重新打开；
- 页面刷新；
- 服务器重启；
- 聊天导出与重新导入；
- 复杂聊天元数据；
- 不得直接生成 JSONL 文件冒充完成。

### 6.5 群聊

- ≥5 个不同群聊；
- 每组不同成员；
- 自动回复；
- 手动指定成员；
- 多角色轮流生成；
- 群聊重新排序；
- 群聊历史编辑；
- 群聊 Swipe；
- 群聊 Continue；
- 群聊重载与持久化。

### 6.6 UI、扩展与个人设置

- Personas、背景、Themes、Quick Replies、Regex、STscript、变量、宏；
- 酒馆助手 / Tavern Helper；
- JS-Slash-Runner；
- 扩展 iframe、扩展事件、扩展状态持久化；
- 扩展使用原版实际支持的安装/启用/配置方式，固定可信版本，禁止自动升级；
- 每类操作必须证明确实影响了可观察状态。

### 6.7 必须构造的真实组合（至少 8 类）

1. 多角色卡 × 多世界书 × 多预设；
2. 酒馆助手变量 × 世界书 × Prompt 注入；
3. Regex × Swipe × Regenerate；
4. 多人群聊 × 上下文截断；
5. 多套预设 × Author's Note × Token Budget；
6. 插件变量 × 页面刷新 × 服务器重启；
7. 复杂角色卡 × 超长聊天 × 世界书递归；
8. 日文/中文/Emoji × JSON 序列化 × 文件名；
9. 扩展生命周期 × 用户设置 × 聊天持久化。

> 至少 8 类；每一类都要检查最终真正发送给模型的内容与顺序，不能只检查“页面显示成功”。

---

## 7. 性能测量计划

### 7.1 必须测量的指标（用户提示词 §4.2 原样保留）

- Startup p50/p95；
- 列表请求 p50/p95/p99；
- Provider TTFT；
- SSE Relay Delay；
- CPU Usage；
- CPU Profile；
- Heap Profile；
- Heap In-use；
- Total Allocated Bytes；
- Allocations/op；
- Peak RSS；
- Steady RSS；
- GC Pause；
- Goroutines；
- FD/Handle Count；
- Disk I/O；
- 高并发吞吐；
- 请求取消后的资源恢复。

对每个指标保留：原始测量记录、硬件信息、操作系统信息、测试代码版本。

### 7.2 测量协议

- 先 profiling，再改代码；
- 同机、同输入、同测试代码；ABBA（A/B/B/A 或 A,B / B,A / A,B）交替；
- 热缓存与冷缓存分别报告；
- 内存与 CPU 分别报告；
- Node 对照；
- 完整语义 Oracle 回归；
- 明确列出退化项；
- 每项优化至少一份优化前 profile、一份优化后 profile。

### 7.3 已记录的 alpha.18 基线（必须作为 alpha.19 的比较起点，不得重复实现已完成的优化）

来源：`docs/alpha18/perf/README.md`、`docs/alpha18/perf/abba-inprocess.json`（LOCAL Layer A，Windows arm64，2 逻辑核）。

| 臂/指标 | alpha.17 | alpha.18 | 变化 |
|---|---:|---:|---:|
| `/api/characters/all` 10,000 卡（热缓存）ns/op | 5,734.9 ms | **2,295.9 ms** | **−60.0%** |
| 同上 B/op | 1,038.7 MB | **619.9 MB** | **−40.3%** |
| 同上 allocs/op | 7,797,016 | **3,193,667** | **−59.0%** |
| `BenchmarkCharactersAllCold` 10,000 卡 ns/op | 6,127.9 ms | 5,542.9 ms | −9.6%（噪声内，未声明） |
| 同上 B/op | 1,234.6 MB | **879.0 MB** | **−28.8%** |
| 同上 allocs/op | 8,030,352 | **3,500,341** | **−56.4%** |
| 1,000 卡 ns/op | 606.8 ms | **402.3 ms** | **−33.7%** |
| 100 卡（128 KB 图）ns/op | 75.1 ms | **55.6 ms** | **−26.0%** |
| 10,000 卡冷启动 | 30,757 ms | **3,661 ms** | 同生成协议 |
| 10,000 卡热启动 | 633 ms | **165 ms** | 同生成协议 |

同 SHA CI 记录（`GoTavern smoke metrics` 42012475880，`f1396ce`）：启动 **165 ms vs Node 14,515 ms**；稳态 RSS **40.5 MB vs Node 915 MB**；`/version` 中位 **0.429 ms vs 65.55 ms**（p95 0.596 / 70.33）；`/` 中位 **8.59 ms vs 13.78 ms**；10 分钟 soak：GoTavern RSS 漂移 **−0.1 MB**、p95 **+0.35 ms**（Node RSS −571 MB、p95 −3.29 ms）。

**alpha.19 不得把上述 alpha.18 数字当成自己的成绩；它们只是基线。**

### 7.4 alpha.19 目标设定规则

- 目标必须在 profiling 之后设定，写进 `docs/alpha19/perf/targets.md`；
- 目标必须可测量、可复现、绑定具体输入（数据规模、缓存状态、并发数）；
- 声明改进的条件：候选的每次观测都优于基线的每次观测，或分配量是确定性的且大幅下降；否则只能报告“无改善/噪声内”；
- 任何“峰值 RSS 下降”的声明必须来自真实进程测量，禁止用 B/op 或 Heap In-use 冒充；
- 每项优化必须回答：是否改变了输出顺序、JSON 语义、Unicode 行为、Provider 请求、扩展事件？如果是，撤销或证明不影响语义。

### 7.5 性能测试对象（至少）

- 全新安装；
- 真实 UI 生成的复杂数据；
- 100 卡、1,000 卡、10,000 卡；
- 长聊天；
- 大型世界书；
- 多扩展；
- 多用户；
- 群聊生成；
- Provider SSE；
- 冷缓存、热缓存；
- 频繁重启；
- 文件外部修改。

> 大规模性能数据可以通过原版正式支持的批量导入路径建立；**不能**绕过原版直接生成伪造的酒馆内部存储状态。

---

## 8. Live Oracle 五层可观察行为规范

### A. 浏览器层

- 实际 DOM 状态；
- 图片是否真实解码；
- UI 元素与选中状态；
- 浏览器控制台错误；
- 扩展 iframe；
- 事件发射顺序；
- 用户最终看到的聊天状态。

### B. HTTP 层

- 请求方法；
- URL、Query；
- Header；
- Body；
- Response Status；
- Response Header；
- Response Body；
- SSE 字节边界与流式行为。

### C. Provider Wire 层

- 最终 Messages 数组；
- Role；
- Content；
- System Prompt；
- 世界书插入；
- Tool Calling；
- Reasoning 参数；
- Sampling 参数；
- Stop Sequence；
- Token Budget；
- Context Truncation；
- 所有真正发送给 Provider 的请求字段。

### D. 持久化层

- 文件新增、删除和修改；
- 文件内容；
- JSONL；
- 设置；
- 角色卡；
- 世界书；
- 扩展状态；
- Persona；
- 预设；
- 跨重启读取。

### E. 生命周期与组合层

- 页面刷新；
- 服务器重启；
- 插件加载；
- 预设变更；
- 聊天切换；
- 多用户会话；
- Node → Go → Node 双向交接。

**比较规范：** 原则是精确等价。允许归一化的内容仅限被实际证明属于非语义差异的项目（隔离环境随机端口、明确可变时间戳、独立会话标识）。所有归一化必须有：原因、原版证据、具体字段、对应测试、负例验证。禁止宽泛忽略 Header、响应体、请求字段、Prompt 内容或文件变更。

---

## 9. 证据台账（alpha.19 唯一进度表）

> 状态枚举：`未开始` / `进行中` / `已证明` / `未证明` / `被阻塞` / `不适用（需书面理由）`。
> 每行“已证明”必须附：证据路径 + 运行方式 + 关键数字/判定 + （CI 项）`workflow name + run id + conclusion` + 候选 SHA。
> 本表是 alpha.19 的内部台账；`docs/goal-scorecard.md` 仍是 GOAL §7 的唯一对外台账，两者不得矛盾。

| ID | 声明 | 观察面 | 产出路径（计划） | 状态 |
|---|---|---|---|---|
| E-A01 | 真实 UI 语料达到第 6 节数量要求 | 磁盘 + provider 捕获 + 动作日志 | `docs/alpha19/oracle/corpus-manifest.json`、`docs/alpha19/oracle/actions/` | 未开始 |
| E-A02 | 上游 pinned 未被修改 | SHA256 manifest 前后一致 | `docs/alpha19/oracle/oracle-pin.sha256` | 未开始 |
| E-A03 | 三轮真实使用记录（动作级） | 浏览器 trace + 动作日志 | `docs/alpha19/oracle/actions/round-1..3.md` | 未开始 |
| E-A04 | 不同预设产生不同 Provider Request | Provider Wire | `docs/alpha19/oracle/preset-wire-diff.json` | 未开始 |
| E-B01 | 浏览器层 Node == Go | 浏览器 | `docs/alpha19/oracle/layer-a-browser.json` | 未开始 |
| E-B02 | HTTP 层 Node == Go | HTTP | `docs/alpha19/oracle/layer-b-http.json` | 未开始 |
| E-B03 | Provider Wire 层 Node == Go（字节） | Wire | `docs/alpha19/oracle/layer-c-wire.json` | 未开始 |
| E-B04 | 持久化层 Node == Go | 文件系统 | `docs/alpha19/oracle/layer-d-persist.json` | 未开始 |
| E-B05 | 生命周期/组合层 Node == Go | 全层 | `docs/alpha19/oracle/layer-e-lifecycle.json` | 未开始 |
| E-B06 | 归一化清单（每项含原因/证据/字段/测试/负例） | 文档 | `docs/alpha19/decision-log.md` | 未开始 |
| E-B07 | 每个差异 RED→GREEN | 测试 | `docs/alpha19/findings/` + 提交记录 | 未开始 |
| E-B08 | Node→Go→Node 双向交接 | 文件系统 + 浏览器 | `docs/alpha19/oracle/handback.json` | 未开始 |
| E-C01 | 优化前/后 profile | CPU/Heap/Alloc | `docs/alpha19/perf/profiles/` | 未开始 |
| E-C02 | 10,000 卡列表 ABBA（冷/热） | 性能 | `docs/alpha19/perf/abba-cards.json` | 未开始 |
| E-C03 | 启动 p50/p95（多规模） | 性能 | `docs/alpha19/perf/startup.json` | 未开始 |
| E-C04 | Provider TTFT / SSE Relay Delay | 性能 | `docs/alpha19/perf/relay.json` | 未开始 |
| E-C05 | CPU / RSS / GC / goroutine / FD / Disk I/O | 性能 | `docs/alpha19/perf/resources.json` | 未开始 |
| E-C06 | Node 对照 + 退化清单 | 性能 | `docs/alpha19/perf/vs-node.md` | 未开始 |
| E-D01 | ≥8 用户并发混合负载 | 并发 | `docs/alpha19/stability/eight-users.json` | 未开始 |
| E-D02 | 长稳资源趋势 + 泄漏判定 | 稳定性 | `docs/alpha19/stability/soak.json` | 未开始 |
| E-D03 | 重启/扩展启停/外部修改后的行为 | 稳定性 | `docs/alpha19/stability/lifecycle.json` | 未开始 |
| E-E01 | 新增真实 UI Oracle 有 CI 入口并被 gate 消费 | CI | `.github/workflows/*`、`docs/release-manifest.json` | 未开始 |
| E-E02 | 13 + 新增门同 SHA 全绿 | CI | `docs/alpha19/same-sha-evidence.md` | 未开始 |
| E-E03 | 每个关键 workflow 的 Job/Step/日志/Artifact 已检查 | CI | 同上 | 未开始 |
| E-F01 | 发布包内容 + checksum + 发布二进制运行 | 发布 | `docs/alpha19/release-evidence.md` | 未开始 |
| E-F02 | Release URL / Tag / 资产 / 历史 tag 未移动 | 发布 | 同上 | 未开始 |
| E-G01 | GOAL §14 第 1–6 条在本次 UI 语料上的判定 | 全层 | `docs/alpha19/goal-14.md` | 未开始 |

---

## 10. 风险、阻塞与诚实边界

| 风险/阻塞 | 影响 | 缓解/记录方式 |
|---|---|---|
| 真人与真实用户目录不可得 | GOAL §14 的“真人多年私有目录”无法证明 | 用 Node-UI-Originated Corpus 满足 §14(1) 的“真实使用过”；报告如实标注语料来源；不冒充真人数据 |
| 单会话时间/令牌有限 | 13+1 门 CI wave 每轮数小时；多轮修复可能超时 | 先做 P1/P2/P3 的真实增量；CI/发布按实际进度推进；未完成项明确列出，不伪造 |
| pinned 启动慢（Node 冷启动可达数十秒） | 每轮差分成本高 | 复用现有 `port-lease`、启动等待、缓存；记录每次启动耗时；必要时复用已启动实例但保证隔离 |
| Playwright 在 CI 的不稳定性 | 假红/假绿 | 复用现有浏览器稳定化机制（`docs/browser-stability.md`）；每个失败保留 page chart、控制台、网络日志；禁止 sleep 掩盖 |
| Windows 无 `-race` | 本地无法证明并发安全 | Linux CI `race` job 是唯一并发门；本地结果标注 Layer A |
| CI 90 分钟预算（Browser differential 曾超时） | 新 UI journey 可能放不下 | 新门可独立 workflow 或拆分 job；每个 job 有 `timeout-minutes`；narrowed dispatch 必须被 verifier 拒绝 |
| main 现有红灯 42478967874 | 基线不干净 | P0 必须先定性；若确为产品缺陷，先修复再开始 alpha.19 候选；若为 CI/上游问题，记录证据并重跑 |
| upstream 依赖自动更新 | 语料/扩展在不同时间产生不同结果 | 扩展固定可信版本、禁止自动升级；记录 lock 与 SHA；CI 缓存 key 必须证明身份 |
| 24 小时测试成本 | 可能不可行 | 先做足够长的实际混合负载；不可行时记录具体限制与已观测趋势；不把短测冒充 24h |
| 发布纪律 | tag 一旦发布不可移动 | 先冻结候选、同 SHA 全绿、post-publish 验证；任何失败重新走候选，不移动旧 tag |

**诚实边界（必须随报告传播）：**

- alpha.19 的“真实 UI 语料”是由 AI Agent 通过真实浏览器在真实 pinned 酒馆中操作产生，**不是某位真人多年使用的私有目录**；它满足“真实使用过、非合成”的语义，但不满足“真人历史”的语义。
- 当前没有 Linux 本机 runner；Linux CI 结果是发布门，本地结果只能作为 Layer A。
- 未证明的能力必须写 `unproven`，不能用“应该”“大概”“代码看起来对”替代。

---

## 11. 提交、CI 与发布纪律

1. **分支**：`main` 是唯一长期分支；alpha.19 使用固定工作分支，按仓库现有规范合并（无 PR）。每个相干步骤都推送，不堆积未推送提交。
2. **提交**：一个提交只做一件相干的事；提交信息说明动机、范围、证据；不得用 `git add -A` 把其他 lane 的未发布文件吸收进来；变异/实验不得混入交付提交。
3. **字节**：提交前验证 `git archive HEAD` / blob 摘要；不得用 shell 重定向恢复文本（会写 UTF-16LE 或丢字节）；生成文本必须显式 UTF-8 无 BOM，并检查首字节。
4. **禁止**：Force Push、移动旧 tag、跳过失败测试、降低断言、修改 Oracle、扩大忽略列表、删除失败日志。
5. **CI 引用格式**：`workflow name + run id + conclusion` 三者齐全；一个 commit 会触发多个 workflow，裸 run id 不算证据。
6. **同 SHA**：所有 required gates 必须针对同一候选 SHA；发布 verifier 会拒绝不同 SHA 或缺失 artifact 的绿色。
7. **发布**：`v0.1.0-alpha.19` 必须由 tag 名注入版本；发布后必须下载、校验 checksum、解包、运行、`gotavern version` 验证；历史 tag 不变。
8. **Release notes**：不得领先于证据；未证明项逐条列出；`GOAL §14` 状态如实写。

---

## 12. 立即执行的下一步（P0 起步，按顺序）

1. ~~`git switch -c alpha19/program`（或仓库既有命名），从 `52883e8` 起；立即 `git push -u origin alpha19/program`。~~ **已执行**（本次：分支 `alpha19/program`，本文件为首个提交）。
2. 生成本文件（已完成）并作为 alpha.19 的开工基线提交/推送。
3. 对 pinned SillyTavern 计算并保存 SHA256 manifest（`public/**`、`src/**`、`package.json`、锁文件、`default/**`）。
4. 构建当前 GoTavern，记录 `go build ./...` 耗时与二进制 SHA256；跑一组最小基线测试。
5. 定性 run `42478967874` 的 `soak` 失败。
6. 创建 3 个 Subagent A/B/C，领取任务（A：corpus；B：Go 侧驱动与基线；C：alpha.18 基线 profile）。
7. 开始 P1：pinned 启动 + 全新用户环境 + 第一轮真实 UI 使用，所有证据落到仓库外 scratch，最终汇总到 `docs/alpha19/oracle/`。

---

## 附录 A：用户原始提示词（逐字，未经改写）

````text
# GoTavern v0.1.0-alpha.19 — 原版真实交互 Oracle、极限语义兼容与性能优化总任务

你现在是 GoTavern 项目的首席工程执行 Agent。你的任务不是提出计划、编写漂亮报告、重复现有测试，也不是擅自添加自认为有用的功能。

**你的唯一主要目标：使 GoTavern 在真实、复杂、长期使用风格的 SillyTavern 环境中，尽可能完全复现原版 SillyTavern 的可观察行为，同时获得严格测量证明的更低内存占用、更低 CPU 消耗和更高运行性能。**

仓库：

https://github.com/cocokoishi/GoTavern

基线：

- GoTavern：`v0.1.0-alpha.18`
- 已发布候选：`a41772152a76cd3c42c52b63f2a377e2963de6fd`
- 当前记录的 main：`52883e8`
- 原版 SillyTavern：`1.19.0`
- Pinned upstream commit：`06bde939fb1e9c4c8d8641d810f0a916b5bce127`
- 目标迭代：`v0.1.0-alpha.19`

首先验证实际仓库和远端状态，不得盲目相信上述版本信息。如果远端发生变化，应先确定实际状态再继续。

---

## 一、不可违反的最高优先级约束

### 1. 原版 SillyTavern 是唯一语义 Oracle

不要自行想象原版应该如何工作。

所有行为必须通过以下方式确认：

- 阅读 pinned upstream 的实际源代码；
- 在未修改的 pinned SillyTavern 上真实运行；
- 通过真实浏览器交互观察行为；
- 记录真实 HTTP 请求与响应；
- 记录模型提供商实际收到的请求；
- 记录所有相关文件系统变化；
- 将上述结果与 GoTavern 进行差分比较。

禁止把 GoTavern 当前行为、自己手写的 Mock 预期、现有测试通过、合成 JSON 或猜测的 Node 语义作为最终 Oracle。

Mock Provider 只能作为网络观察器和确定性响应器，不能定义 SillyTavern 应有的业务语义。

真实 pinned Node 实例的可观察输出才是判定依据。

### 2. 严禁修改元项目

不得修改 pinned SillyTavern 的：

- 任何生产源代码；
- 前端 JavaScript、HTML、CSS；
- Package、依赖、构建配置；
- API 路由与服务端逻辑；
- 插件源代码；
- 原版语义或测试预期。

只允许在独立临时目录中运行原版，并由正常用户操作产生用户数据。

如果确实需要测试工具，可以采用外部 Playwright、网络观察代理或进程监测，不得修改原版产品行为。

**GoTavern 可以修改和优化；原版 SillyTavern 只能作为不可变 Oracle。**

### 3. 禁止擅自添加功能

本轮不是功能扩张项目。

特别禁止：

- 自创 `.bak` 机制；
- 额外备份系统；
- 不属于原版语义的自动备份功能；
- 自创数据库；
- 不必要的迁移层；
- 无理由增加依赖；
- 自创缓存框架；
- 为了代码好看而重写成熟模块；
- 重新设计前端；
- 擅自更改接口；
- 擅自改变数据格式。

原版既有行为需要如实观察和比较，但**不要把增加备份功能作为本轮开发任务**。

测试中可以使用隔离的临时目录副本进行 A/B 差分，但这些副本只是测试输入，不得成为 GoTavern 新增的产品备份功能。

### 4. 不自动打开浏览器窗口

禁止自动弹出系统默认浏览器、打开桌面 GUI 浏览器或干扰用户正在使用的浏览器会话。

允许在独立测试环境中使用 Playwright Headless Chromium，执行真实的用户界面自动化。

要求：

- 完全无头运行；
- 独立 Browser Context；
- 独立 Cookie、LocalStorage 与 Profile；
- 不接管用户现有浏览器；
- 不显示窗口；
- 不修改浏览器默认设置；
- 所有测试结束后正常关闭浏览器实例。

**必须真正操作酒馆页面，而不是用直接写文件冒充用户操作。**

### 5. 最多三个 Subagent，并且必须充分使用

本次允许创建最多 **3 个 Subagent**，总量不得超过 3 个。

建议建立三个长期复用的工作角色：

**Subagent A：原版真实用户与 Oracle 工程师**

负责通过无头浏览器真实操作原版酒馆，建立复杂的原版数据集、探索真实行为并采集 Oracle。

**Subagent B：GoTavern 兼容性与差分修复工程师**

负责读取 A 生成的数据与 Oracle，运行 GoTavern，定位真实差异、制作 RED 测试并修复产品代码。

**Subagent C：性能与稳定性工程师**

负责 profiling、CPU/RAM 优化、大规模数据性能、并发压测和性能回归。

主 Agent 负责协调、合并、发布、验收及最终判定。

三个 Agent 可以并行推进独立任务，但禁止同时修改相同文件或共享运行目录。

必须持续复用现有 Subagent，按照阶段提供任务，而不是只调用一次就结束。

严禁无限创建临时 Agent。

---

## 二、第一阶段：真正让 LLM 自己玩原版 SillyTavern

这是整个任务的核心，不得跳过。

当前项目虽然已经有合成长寿命目录和 Node stock tree，但这些都不等于 AI 真正作为用户，通过原版 UI 持续创建和使用复杂酒馆数据。

本轮必须建立全新的：

**Node-UI-Originated Complex User Corpus**

数据必须来源于未修改的原版 SillyTavern，通过真实页面操作、导入按钮、设置面板、聊天界面和正常 API 路径产生。

### 2.1 建立完整的原版环境

在隔离临时工作区：

1. 检出指定 SillyTavern commit。
2. 安装其正常依赖。
3. 使用原版启动机制启动服务。
4. 使用独立的数据目录、配置目录、端口和缓存。
5. 启动独立的确定性 OpenAI-compatible Provider。
6. 使用 Playwright Headless 连接酒馆界面。
7. 从全新用户环境开始真正使用。

不要直接拷贝现有生成器生成的世界书、聊天数据、预设、设置或角色卡来假装真实用户创建。

可以准备正常 PNG、WebP、角色卡导入文件、扩展包等用户输入素材，但必须由酒馆支持的交互入口导入。

### 2.2 LLM 要真正模拟重度酒馆用户

不要只写一套固定脚本点击三个按钮。

Subagent A 应当自己规划复杂使用场景，探索原版实际操作方式，在页面中执行并验证结果。

要求至少覆盖以下复杂度：

**角色与资源**

- 创建至少 30 张真实角色卡；
- 使用不同角色描述长度；
- 多种 First Message；
- 多个 Alternate Greetings；
- 角色示例对话；
- 高复杂度角色卡字段；
- 多张头像；
- 角色编辑、复制、重命名、导入与导出；
- 正常 UI 支持的角色格式；
- Sprites、替换头像及多资源场景；
- 非 ASCII、日文、中文、Emoji；
- 特殊字符、换行、转义字符。

**世界书与触发机制**

- 至少 8 本世界书；
- 至少 150 条复杂条目；
- 常驻、关键词、递归触发；
- 不同插入位置；
- 多种深度；
- 条目启用与禁用；
- 角色绑定世界书；
- 全局世界书；
- 多世界书冲突；
- 故意构造上下文竞争场景。

**预设和 Prompt**

- 至少 10 套具有实质区别的预设；
- 不同上下文长度；
- 不同 Prompt Manager 排列；
- System Prompt；
- Author's Note；
- 不同示例对话插入模式；
- 不同 Token Budget；
- 不同世界书优先级；
- 不同模型来源和可用参数；
- 预设切换；
- 预设编辑后立即生成；
- 保存、重载后的状态恢复。

必须证明不同预设真的产生不同 Provider Request，而不是 UI 上只显示不同名字。

**聊天与历史数据**

- 至少 50 个独立聊天；
- 累计至少 1,000 条通过真实应用交互产生的消息；
- 多种聊天长度；
- 多条历史分支；
- Swipe；
- Regenerate；
- Continue；
- Edit；
- Delete；
- 多次保存与重新打开；
- 页面刷新；
- 服务器重启；
- 聊天导出与重新导入；
- 复杂聊天元数据。

确定性 Provider 可以返回丰富但可重现的文字，供 UI 真实生成聊天历史。

不能直接生成 JSONL 文件并算作完成。

**群聊**

- 至少 5 个不同群聊；
- 每组不同成员；
- 自动回复；
- 手动指定成员；
- 多角色轮流生成；
- 群聊重新排序；
- 群聊历史编辑；
- 群聊 Swipe；
- 群聊 Continue；
- 群聊重载与持久化。

**UI、扩展与个人设置**

- Personas；
- 背景；
- Themes；
- Quick Replies；
- Regex；
- STscript；
- 变量；
- 宏；
- 酒馆助手 / Tavern Helper；
- JS-Slash-Runner；
- 扩展 iframe；
- 扩展事件；
- 扩展状态持久化。

扩展必须使用原版实际支持的安装、启用和配置方式，固定可信版本，禁止自动升级。

对每一类操作，必须证明它确实影响了可观察状态。

### 2.3 必须产生真正复杂的组合

不要把每个功能隔离成一个最简单的单独测试。

必须至少构建若干实际组合：

- 多角色卡 × 多世界书 × 多预设；
- 酒馆助手变量 × 世界书 × Prompt 注入；
- Regex × Swipe × Regenerate；
- 多人群聊 × 上下文截断；
- 多套预设 × Author's Note × Token Budget；
- 插件变量 × 页面刷新 × 服务器重启；
- 复杂角色卡 × 超长聊天 × 世界书递归；
- 日文/中文/Emoji × JSON 序列化 × 文件名；
- 扩展生命周期 × 用户设置 × 聊天持久化。

不要只检查“页面显示成功”。

必须检查最终真正发送给模型的内容与顺序。

### 2.4 增加自主探索

在最低覆盖要求之外，Subagent A 需要继续自主探索原版功能。

不要完全依赖预先列出的操作清单。

要求至少进行三轮：

第一轮：创建复杂环境。

第二轮：作为真实用户持续使用，产生长聊天、修改预设、编辑角色和更改插件状态。

第三轮：重启原版后继续使用已有环境，检查历史遗留状态、缓存、持久化及复杂交互。

每轮记录 Agent 实际执行的用户动作，而不仅仅记录测试脚本名称。

如果某个操作在原版 UI 中失败，必须调查是浏览器驱动问题、原版既有行为还是环境问题，不能通过直接写文件伪造成功。

---

## 三、第二阶段：建立真正可执行的 Live Oracle

禁止只保存一份静态 JSON Fixture 后自行判断兼容。

原版必须能在同样环境下重新运行，并重新生成预期结果。

### 3.1 将真实原版目录作为测试输入

完成原版 UI 操作后：

1. 正常关闭原版；
2. 记录数据目录、配置、扩展和相关可变状态；
3. 计算完整 SHA256 Manifest；
4. 保持原始测试输入不可变；
5. 将同一输入复制到两个独立临时环境；
6. 一个运行 pinned Node；
7. 一个运行 GoTavern。

确保两者使用相同的前端文件、扩展版本、模型模拟器行为和配置语义。

不得在同一个可写目录同时运行两个服务。

### 3.2 对比五层可观察行为

**A. 浏览器层**

- 实际 DOM 状态；
- 图片是否真实解码；
- UI 元素与选中状态；
- 浏览器控制台错误；
- 扩展 iframe；
- 事件发射顺序；
- 用户最终看到的聊天状态。

**B. HTTP 层**

- 请求方法；
- URL、Query；
- Header；
- Body；
- Response Status；
- Response Header；
- Response Body；
- SSE 字节边界和流式行为。

**C. Provider Wire 层**

- 最终 Messages 数组；
- Role；
- Content；
- System Prompt；
- 世界书插入；
- Tool Calling；
- Reasoning 参数；
- Sampling 参数；
- Stop Sequence；
- Token Budget；
- Context Truncation；
- 所有真正发送给 Provider 的请求字段。

**D. 持久化层**

- 文件新增、删除和修改；
- 文件内容；
- JSONL；
- 设置；
- 角色卡；
- 世界书；
- 扩展状态；
- Persona；
- 预设；
- 跨重启读取。

**E. 生命周期与组合层**

- 页面刷新；
- 服务器重启；
- 插件加载；
- 预设变更；
- 聊天切换；
- 多用户会话；
- Node → Go → Node 双向交接。

### 3.3 比较规范

原则是精确等价。

允许归一化的内容仅限被实际证明属于非语义差异的项目，例如隔离环境中的随机端口、明确可变时间戳或独立会话标识。

所有归一化必须有：

- 原因；
- 原版证据；
- 具体字段；
- 对应测试；
- 负例验证。

禁止宽泛忽略 Header、响应体、请求字段、Prompt 内容或文件变更。

特别禁止“Node 和 Go 都能聊天，所以 PASS”。

### 3.4 真正的差分修复循环

对每一个不一致：

1. 在原版复现；
2. 在 GoTavern 复现；
3. 确定差异属于什么层；
4. 找到 GoTavern 的具体根因；
5. 构造能稳定失败的 RED 测试；
6. 用最小范围修改 GoTavern；
7. 确认 RED → GREEN；
8. 重跑相关 Oracle；
9. 重跑复杂组合；
10. 验证没有性能回退。

任何无法复现的差异都要继续收集证据，不允许靠猜测修改生产代码。

原版确有缺陷时，不能为了“修得更好”而擅自改变 GoTavern 语义。应记录差异及兼容性决策，明确是否属于已有许可的安全例外。

---

## 四、第三阶段：深度性能优化

性能不是附加任务，是本轮的另一个主要目标。

Subagent C 必须深入研究真实热点，不能只跑一次 Benchmark 就宣布性能很好。

### 4.1 性能测试对象

至少包含：

- 全新安装；
- 真实 UI 生成的复杂数据；
- 100 卡；
- 1,000 卡；
- 10,000 卡；
- 长聊天；
- 大型世界书；
- 多扩展；
- 多用户；
- 群聊生成；
- Provider SSE；
- 冷缓存；
- 热缓存；
- 频繁重启；
- 文件外部修改。

大规模性能数据可以通过原版正式支持的批量导入路径建立，不要求手工点击创建一万次，但不能绕过原版直接生成伪造的酒馆内部存储状态。

### 4.2 必须测量的指标

- Startup p50/p95；
- 列表请求 p50/p95/p99；
- Provider TTFT；
- SSE Relay Delay；
- CPU Usage；
- CPU Profile；
- Heap Profile；
- Heap In-use；
- Total Allocated Bytes；
- Allocations/op；
- Peak RSS；
- Steady RSS；
- GC Pause；
- Goroutines；
- FD/Handle Count；
- Disk I/O；
- 高并发吞吐；
- 请求取消后的资源恢复。

对每个指标保留原始测量记录、硬件信息、操作系统信息和测试代码版本。

### 4.3 优化原则

必须先 profiling，再改代码。

优先减少：

- 不必要的文件系统访问；
- 重复 JSON 编解码；
- 重复扫描；
- 多余的数据复制；
- 过大的临时分配；
- 缓存中重复持有的数据；
- 无价值锁竞争；
- 请求过程中的重复字符串构造；
- 无意义的内存驻留；
- 不必要的 goroutine；
- 低效率的响应组装。

不能为了减少内存而破坏原版功能。

不能为了加速而降低缓存正确性。

不能为了优化 CPU 而更改输出顺序、JSON 语义、Unicode 行为、Provider 请求或扩展事件。

不引入新依赖，除非证明现有方案无法满足任务要求并说明成本。

### 4.4 alpha.18 的已知性能基础

已有记录显示：

10,000 卡：

- 列表请求大幅改善，但仍处于秒级；
- 热缓存单次调用仍有大量内存分配；
- 峰值 RSS 未证明下降；
- 启动过程已经去除了大量不必要的文件系统访问。

请不要重复实现 alpha.18 已完成的优化。

先检查真实代码与 Profile，再决定下一步。

重点研究是否能够在**不损失语义和正确性**的情况下进一步降低大规模角色列表的解码、投影、序列化和缓存成本。

需要设立合理的性能改善目标，但不允许为了达标伪造样本、选择性报告或改动 Benchmark 输入。

### 4.5 性能结果必须可复现

每项优化至少：

- 一份优化前 Profile；
- 一份优化后 Profile；
- 同机同输入 ABBA 测试；
- 热缓存与冷缓存分别报告；
- 内存与 CPU 分别报告；
- 原版 Node 对照；
- 完整语义 Oracle 回归；
- 明确说明性能退化项。

如果某个方案减少延迟却显著增加内存，必须提供数据与取舍，不允许自动宣称全面改进。

绝对禁止把 MB/op 误写为 Peak RSS。

---

## 五、第四阶段：复杂并发与长期稳定性

在原版创建的复杂数据基础上进行真实负载测试。

不得只用空白目录。

必须包含：

- 多浏览器会话；
- 多用户登录；
- 同时保存不同聊天；
- 同时更新世界书；
- 同时进行群聊生成；
- 同时读取角色列表；
- 多个 SSE 长连接；
- Provider 超时与取消；
- 重启后继续工作；
- 扩展启停和状态保持；
- 压力下读取和修改文件。

测试必须对比 pinned Node 与 GoTavern。

至少完成 8 用户并发场景和完整资源趋势测试。

运行足够长的实际混合工作负载以观察资源是否持续增长，必要时进行 24 小时级别测试。

不能用 RSS 单独证明无内存泄漏。

对 Linux 使用可获得的 heap、FD、goroutine、CPU 数据，对其他平台诚实记录限制。

所有压测必须隔离运行，不能操作真实私人目录。

---

## 六、第五阶段：架构优化的硬性边界

不要因为某个文件很长就拆文件。

不要因为 `internal/server` 很大就重构整个服务。

不要因为看到重复代码就创建新框架。

保留已经经过验证的关键结构、路径和接口。

如果确实需要架构调整，必须同时满足：

1. 存在实际可复现的缺陷或性能问题；
2. 有证据证明问题来自当前架构；
3. 可以做局部、可回滚的改动；
4. 改动前后具有可测量收益；
5. 所有原版语义差分通过。

不满足这些条件就不要进行架构重构。

已有 alpha.17 R1–R6 拒绝决策必须阅读并尊重，除非出现全新的可复现证据。

---

## 七、第六阶段：GitHub Actions 真实验收

所有开发与验证应在明确的工作分支和固定 commit 上完成。

禁止只凭本地测试通过就宣称最终成功。

必须运行：

- Go 完整测试；
- Go Vet；
- Linux Race；
- Oracle Fixture 差分；
- 真实 Node UI Corpus；
- 浏览器差分；
- Provider Wire 差分；
- 复杂扩展组合；
- Node → Go → Node；
- 大规模性能基准；
- 真实发布包测试；
- 原有 13 项必须通过的工作流。

新增的真实 UI Oracle 必须具有明确的 CI 执行入口，而不是仅存在本地脚本。

每个关键工作流需要检查实际 Job、Step、日志和 Artifact。

对于失败：

- 判断是否为产品故障；
- 判断是否为原版故障；
- 判断是否为测试驱动故障；
- 判断是否为 CI 环境问题；
- 修复真正的根因；
- 在同一候选 SHA 上重新验证。

不准通过 Skip、降低断言、修改 Oracle、扩大忽略列表或删除失败测试获得绿色。

必须保持现有 same-SHA、artifact freshness、required jobs 与版本发布纪律。

**新候选必须重新取得完整的 13/13 验收结果，而且新增的真实 UI Oracle 也必须通过。**

---

## 八、必须持续执行，而不是写完报告就结束

不要只完成：

- 审计报告；
- 计划；
- TODO；
- 目录清单；
- 虚假的测试结果；
- 一次 Benchmark；
- 一次简单浏览器操作。

这些都不是本任务的完成条件。

你需要实际推进：

**原版交互 → 复杂数据 → 实时 Oracle → GoTavern 对照 → 发现问题 → 真实修复 → 语义回归 → 性能优化 → 压力测试 → Actions 验收。**

如果第一轮发现缺陷，继续修复。

如果第二轮出现新的回归，继续定位并修复。

如果性能优化引入语义不一致，撤销或修正优化。

如果子 Agent 结束某项任务，立即把下一项未完成工作分配给它，而不是闲置。

尽量使用三个 Subagent 的并行能力，但每个测试数据集必须具有独立所有权，避免并发工具互相污染证据。

不得因为“目前没有新问题”就停止探索。应扩大场景，优先覆盖尚无真实原版证据的组合。

但也不得无限声称还能继续，或把平台限制、不可用凭据和无法执行的测试伪装为成功。遇到真实阻塞时，必须提供复现证据与明确限制。

---

## 九、最终交付要求

目标是完成一个经充分验证的 GoTavern alpha.19，而不是只留下开发分支。

在所有强制验收通过后：

1. 完成 GoTavern 产品代码改进；
2. 提交真实 UI Oracle 测试和测试数据生成流程；
3. 提交必要的语义差分回归；
4. 提交性能基准和原始证据；
5. 完成 GitHub Actions 全量验收；
6. 检查发布包内容；
7. 验证发布二进制；
8. 记录所有已证明与未证明的能力；
9. 按仓库现有规范执行版本发布；
10. 确保历史 Release Tag 不变。

不允许 Force Push、移动旧 Tag、绕过验证、删除失败日志或将未验证的平台标为通过。

若发布条件未满足，不能强行发布或宣称完成；必须继续处理能够解决的问题，并明确列出真正阻塞发布的证据。

### 最终报告必须包含

**A. 原版酒馆的实际使用记录**

说明 LLM 真实操作了哪些页面、创建了多少角色、世界书、聊天、群聊、预设和扩展状态。

提供可验证的浏览器运行记录、实际操作轨迹和生成数据清单。

**B. Live Oracle 结果**

报告原版与 GoTavern 的每项差分、发现过的真实缺陷、修改前 RED、修改后 GREEN。

**C. 性能变化**

按不同规模列出优化前后：

- CPU；
- 内存；
- 启动；
- 列表；
- Provider Relay；
- 并发；
- 长时间运行。

必须记录无改善和退化。

**D. 工程变更**

列出每一项生产代码改动的原因、影响范围和回归证据。

**E. GitHub Actions**

提供实际 Run ID、Commit SHA、Job 结论和最终验收结果。

**F. 发布结果**

提供真实 Release URL、Tag、资产、Checksum 和已发布二进制运行证据。未发布则明确说明原因。

**G. 未实现与未证明**

任何残留问题都不得隐藏。

---

## 十、最终工程原则

再次强调：

**我们开发的是 SillyTavern 的 Go 后端替代品，不是重新发明一个酒馆。**

所有优化都必须服从原版语义。

所有兼容性判断都必须服从真实运行的 pinned SillyTavern。

所有复杂数据都必须尽可能由真正的原版用户操作产生，而不是测试生成器随意构造后自称真实。

所有性能改善都必须通过实际 Profile 和可复现 Benchmark 证明。

所有生产修复都必须对应真实问题。

不得擅自引入新的备份系统、数据库、功能模块或架构体系。

不得修改原版 SillyTavern。

不得自动弹出浏览器。

最多三个 Subagent，持续复用，并行推进。

优先交付真正能够运行、能够兼容复杂酒馆数据、具有可测量性能优势的 GoTavern。

**不要以“我们写了很多测试”作为成功标准。成功标准是：一个由 LLM 亲自在原版酒馆里长期、多轮、复杂操作而建立的环境，可以交给 GoTavern 继续使用，其可观察行为与原版一致，而且性能更好。**

现在开始执行，不要停留在规划阶段。
````

---

## 附录 B：本次状态核验的原始命令与输出摘要

以下命令于 2026-11-08 在本机执行，用于核实第 1 节的每一项事实。

```powershell
# 仓库身份与状态
git rev-parse --show-toplevel        # C:/Users/koishi/Desktop/GoTavern/gotavern
git status --short                   # （无输出：工作树干净）
git log --oneline -10                # 52883e8 ... alpha.18 发布记录
git remote -v                        # origin https://github.com/cocokoishi/GoTavern.git
git rev-parse HEAD                   # 52883e8a048e4f29f6f574529d2491339106fe28
git tag --sort=-creatordate | head   # v0.1.0-alpha.18 ... v0.1.0-alpha.9
git branch -a                        # main 领先，无 alpha19 分支
git status -sb                       # ## main...origin/main（无 ahead/behind）
git fetch origin --prune             # 远端无新增
git log --oneline origin/main -3     # 与 HEAD 一致 52883e8
git tag -l "v0.1.0-alpha.18" --format='%(objecttype) %(objectname) -> %(*objectname)'
                                     # tag bc1289be... -> a417721...
git rev-list -n1 v0.1.0-alpha.18     # a41772152a76cd3c42c52b63f2a377e2963de6fd
git rev-list -n1 v0.1.0-alpha.17     # 9b99fde0b0a9be0665cd93bc2143a3f495af31c2

# 工具链
go version                           # go1.27.3 windows/arm64
node --version                       # v24.19.0
npm --version                        # 11.17.0
gh --version                         # 2.102.0
gh auth status                       # logged in cocokoishi; scopes read:org, repo, workflow, write:packages

# pinned Oracle
cd ../SillyTavern
git rev-parse HEAD                   # 06bde939fb1e9c4c8d8641d810f0a916b5bce127
git describe --tags                  # 1.19.0-1-g06bde939f
git status --short                   # （无输出：干净）
Test-Path node_modules               # True
(Get-Content package.json -Raw | ConvertFrom-Json).version  # 1.19.0

# 发布与 CI 现状
gh run list --limit 8
# 42479137238 Browser differential schedule success
# 42478967874 Third-party extension compatibility schedule failure
# 42478540346 GoTavern drop-in qualification push success
# 42478540221 GoTavern CI probes=auto push success
# 42478540108 GoTavern Node stock tree round trip push success
gh run view 42478967874 --json jobs  -> soak job; failed step "Thirty-minute all-20 soak (both subjects)"

# 本地构建产物版本（未注入）
.\gotavern.exe version               # GoTavern 0.0.0-dev / baseline 1.19.0 (06bde93...)
```

已阅读并确认存在（不逐一复述内容）：`GOAL.md`、`AGENTS.md`、`HANDOFF.md`、`ARCHITECTURE.md`、`docs/goal-scorecard.md`、`docs/release-manifest.json`、`docs/alpha18/same-sha-evidence.md`、`docs/alpha18/perf/README.md`、`docs/longlived-corpus.md`、`tests/browser/PAGE-CONTEXT.md`、`tests/browser/*` 探针目录、`.github/workflows/*`（21 个）。

---

## 附录 C：与现有权威文档的关系

| 文档 | 关系 | alpha.19 的约束 |
|---|---|---|
| `GOAL.md` | 锁定的项目目标，最高项目权威 | alpha.19 的所有工作必须回答“是否更接近 GOAL”；§14 的 6 条是最终兼容性判定 |
| `AGENTS.md` | 验证规则与产品契约（硬规则、差分教义、20 条验证方法、产品规则 21–57） | alpha.19 不得违反；尤其：上游 Oracle、字节导向、主体/Oracle 预期分离、每门有 teeth、同 SHA、不修改上游、不伪造证据 |
| `HANDOFF.md` | 项目状态的历史记录 + 最新 checkpoint | 只作历史；当前状态以本文件第 1 节实测为准 |
| `ARCHITECTURE.md` | 设计契约与已记录的边界（如 `/thumbnail`、`/api/avatars/upload` 的 codec 决策、插件排除、本地 ML 排除） | alpha.19 不得因“性能”或“好看”越过已决定边界；新增架构改动需满足第 3.5 节 |
| `docs/goal-scorecard.md` | GOAL §7 的唯一对外台账（22 个问题） | alpha.19 的证据必须更新它，不得另造第二份 |
| `docs/alpha1x/` | 历史轮次的证据与决策（含 alpha.17 R1–R6） | 必须阅读并尊重，除非有全新可复现证据 |
| `docs/release-manifest.json` | 发布门策略（当前 13 门 + rails） | alpha.19 新增门必须进入该文件并由 verifier 消费；门数变更需单独提交与理由 |
| `tests/browser/PAGE-CONTEXT.md` | 浏览器探针的运行位置与状态读取纪律 | alpha.19 的 UI 探针必须遵守，避免“看起来在观察页面、实际没有”的假证据 |

---

**本文件结束。** 后续所有 alpha.19 的进度、证据与偏差都应在 `docs/alpha19/` 内追加或修订，并在 `docs/goal-scorecard.md` 中同步对外声明；本文件第 1.8 节的“尚未开始”清单是防止把计划当成果的最后一道闸门。
