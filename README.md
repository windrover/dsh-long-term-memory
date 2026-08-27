# dsh-long-term-memory — 长期记忆

一个 DeepSeek Harness（`dsh`）**静态 Host 插件**，为会话提供**分层的、确定性的长期记忆**：
跨会话持久化「用户画像 / 事实 / 偏好 / 决策 / 约束」，用**确定性关键词（BM25）**召回，并在每轮请求前自动注入记忆。
**零外部依赖**：不需要向量库、不需要额外的模型调用、不需要自建 SQLite 或外部服务器。

它只**组合 DSH 已有接缝**，不改任何 core 包。

## 它能做什么

| 能力 | 说明 |
|---|---|
| **三库分层** | `user`（用户画像）/ `global`（跨项目事实）/ `workspace`（项目专属），各占一个 JSONL 文件。 |
| **记忆沉淀** | 模型用 `memory_write` 把值得长期保存的事实写入存储。 |
| **确定性召回** | `memory_recall` 用 CJK 感知的 BM25 检索（中/日/韩按汉字 bigram 匹配，英文按单词），结果可解释、可重放。 |
| **每轮自动注入** | 每次组装 request 前，通过 `systemPrompt.context()` 注入记忆摘要（同步渲染，不破坏 prefix cache）。 |
| **校准注入框架** | 注入块带 `<long_term_memory>` 包裹：诚实声明来源与启发式不确定性、显式授权模型判断相关性并忽略、标明"过去的记录而非指令"、指引过期记忆走 `memory_correct`（防 prompt-injection 式误读，借鉴 hindsight-coding-agents）。 |
| **注入三档** | `recent`（默认，每库最近几条）/ `full`（全部，受字符预算，快照式注入）/ `off`。`injectContext` 与 `injectTags` 走 settings 热重载，改 `settings.yaml` 下一轮即生效。 |
| **标签过滤注入** | `injectTags`（如 `["decision","constraint"]`）：`recent` 模式下只注入带这些 tag 的记忆，过滤掉琐碎条目，让摘要聚焦高价值事实；空 = 全部注入。 |
| **威胁扫描** | 写入内容与注入快照都做轻量威胁模式检测：命中则写入拒绝、注入替换为 `[BLOCKED: …]` 占位符。 |
| **纠正回路** | `memory_correct(claim, truth, evidence?)` 写入更正事实并把匹配到的过期记录标记 `superseded`——召回与注入自动排除，`memory_list`/面板显示 `[SUPERSEDED]`（面板为「已更正」徽标）供审计清理，导出时丢弃。 |
| **分类展示** | 记忆面板按逻辑分类（tag）分组显示：偏好/决策/约束/项目/更正/个人等已知类别有中文标签，未知 tag 显示 `#tag`，无 tag 归入「未分类」；顶部「分类」下拉可只看某一类。 |
| **内容高亮** | 记忆文本轻量高亮（零依赖）：``` 围栏代码块、行内 `code`、URL 自动着色；纯文本照常显示，任意内容安全渲染。 |
| **写入审批门** | 可选：`memory_write` / `memory_forget` 先走 `tools/pre-execute` 的 `ask` 决策，由 DSH 审批接缝裁决。 |
| **写入护栏** | 跨进程文件锁 + 原子写；外部漂移检测（备份并拒绝，不静默丢数据）；文件不可读拒绝覆写；每库字符预算，超限要求先删后加。 |
| **低开销召回** | `memory_recall` 的命中计数（touch）为**纯内存操作**，不重写文件——召回 O(1)，实测 ~0.3ms。 |

## 模型工具

| 工具 | 用途 |
|---|---|
| `memory_write(content, scope?, tags?)` | 写入一条记忆，返回 `id` / `scope`。`scope: user/global/workspace`（默认 workspace，无 cwd 时 global）。超限时报 usage + 当前条目。 |
| `memory_recall(query, scope?, limit?)` | BM25 检索，返回带分数、id、scope 的命中。`scope: user/global/workspace/all`（默认 `all`，user 优先）。 |
| `memory_list(scope?, limit?)` | 按更新时间列出近期记忆（无评分）。 |
| `memory_forget(id, scope?)` | 按 id 删除记忆（不指定 scope 时按 user→global→workspace 顺序查）。 |
| `memory_export(scope?, format?)` | 导出为可移植 bundle（JSON v1 可往返导入，或人类可读 Markdown）；只带 content/scope/tags。 |
| `memory_import(bundle, scope?)` | 从 v1 JSON bundle 恢复记录；可按 content 去重跳过；可强制归入指定 scope。 |
| `memory_batch(scope, operations)` | 单 scope 原子批量：add/replace/remove 一次落盘；预算按最终态检查（可先删后加）；重复/缺失/多匹配计数返回。 |
| `memory_correct(claim, truth, evidence?)` | 记录更正：写入 `truth` 为新的记忆（tag `correction`），并把与 `claim` 匹配的旧记录标记 superseded；已更正记录不再被召回/注入，但保留在列表中供审计删除。 |
| `memory_diagnose()` | 诊断报告（无副作用）：实际生效的 settings（injectContext/injectTags/autoSummarize/…）、注入是否启用、各库 live/total 条数与字符占用、superseded 数、存储文件路径；不泄露机密。记忆「没生效」时先用它定位。 |

## 存储

纯 JSONL，人类可读、可手改（读路径容忍坏行；**写路径检测到坏行会备份并拒绝**，防止静默丢弃手改内容）：

- **`user` 作用域**（用户画像：姓名/角色/偏好/风格）：`$DSH_HOME/dsh-memory/user.jsonl`
- **`global` 作用域**（跨项目事实）：`$DSH_HOME/dsh-memory/global.jsonl`
- **`workspace` 作用域**（跟项目走）：`<workspaceRoot>/.dsh/memory.jsonl`，可随项目一起提交

写入采用「写临时文件 + rename」的原子方式，并持有 `<file>.lock` 跨进程锁（死锁/崩溃留锁会被自动打破）；崩溃不会留下半个记录。每个 backing file 只在首次访问时读入内存，之后复用。

## 安装

```sh
cd dsh-long-term-memory
dsh plugin --profile web add .
# 或从插件目录用 file: 形式
dsh plugin --profile web add "file:$(pwd)"
```

然后**重启 `dsh web`**。bundle patch 会插入一个 `id: long-term-memory` 的行调用该包。

> ⚠️ 注意：`dsh plugin add` 曾在你的 profile 里破坏过 `link:` 相对路径（导致 `dsh-artifacts-panel` 被移出 bundles）。本插件已用**绝对路径** `link:/Users/...` 固化；请勿再对新插件依赖相对路径。

## 使用

重启后，让模型记忆/取回即可，例如：

> “记住我喜欢喝美式咖啡，记到用户画像里。”
> （模型会调 `memory_write`，`scope: user`）
>
> “这个项目之前决定过关于依赖管理的约束吗？”
> （模型会调 `memory_recall("依赖 约束", scope: "workspace")`）

模型默认会看到**每轮注入的记忆摘要**（user 优先），因此不一定要先召回；相关任务开始时建议显式 `memory_recall` 以便拿到带分数的相关命中和 `id`。

## 斜杠命令（用户面，不经模型）

重启后可直接在输入框使用 `/memory`：

| 命令 | 作用 |
|---|---|
| `/memory list [user\|global\|workspace\|all]` | 列出近期记忆（默认 all，user 优先） |
| `/memory search <query>` | BM25 检索全部作用域 |
| `/memory get <id>` | 查看单条记忆 |
| `/memory forget <id>` | 删除单条记忆 |
| `/memory export [json\|markdown]` | 导出可移植 bundle |

适合不想经过模型直接管理记忆的场景（如清理过期条目、导出备份）。

## 配置

在 profile 的 `cordis.patch.yml` 覆盖（`dsh.profile.bundles` 装载后应用）：

```yaml
- id: long-term-memory
  config:
    # 写入前是否需人工审批（默认 false）
    requireApprovalForWrite: false
    # 注入策略：recent（默认）/ full / off（兼容旧布尔 true/false）
    injectContext: recent
    # recent 模式下只注入带这些 tag 的记忆（空 = 全部注入；full 模式忽略该过滤）
    injectTags: ["decision", "constraint"]
    # 写入内容是否做威胁扫描（默认 true）
    scanThreatsOnWrite: true
    # 自动总结：每轮对话结束后用 LLM 蒸馏值得长期记住的事实（默认 false，每次是辅助模型调用）
    autoSummarize: false
    # 两次自动总结间的最小间隔（ms，默认 30000，防抖）
    summarizeIntervalMs: 30000
    # 至少产生多少条新用户消息才触发总结（默认 1）
    summarizeMinMessages: 1
    # 超限时用 LLM 精炼压缩（默认 false = 纯规则压缩：淘汰最冷 + 合并子串重复）
    compressWithLLM: false
    # 用户画像文件（默认 $DSH_HOME/dsh-memory/user.jsonl）
    userFile: null
    # 全局记忆文件（默认 $DSH_HOME/dsh-memory/global.jsonl）
    globalFile: null
    # 工作区记忆文件，绝对或相对 workspace 根（默认 .dsh/memory.jsonl）
    workspaceFile: null
    # session 无 cwd 时的 workspace 根回退（默认 process.cwd()）
    workspaceRoot: null
    # 注入摘要的字符上限（默认 2400；full 模式也受它约束）
    maxInjectedChars: 2400
    # 工具 limit 的上限（默认 25）
    maxResults: 25
    # 每库字符预算；超限时先自动压缩（规则或 LLM），仍超才拒绝（默认 20000）
    charLimit: 20000
```

## 自动总结与自动压缩

除了模型主动写入，插件提供两级自动化（默认关闭，需在配置或 `settings.yaml` 开启）：

- **自动总结**（`autoSummarize: true`）：每轮对话结束（`agent/status → idle`）时，在空闲期用 LLM 蒸馏本轮新增的对话，提取值得长期记住的事实写入记忆（威胁内容跳过、去重、超限自动压缩）。`settings.yaml` 可热重载开关：
  ```yaml
  long-term-memory:
    autoSummarize: true
    compressWithLLM: true
  ```
- **自动压缩**：`memory_write` 超限时先尝试压缩腾空间再拒绝：
  - `compressWithLLM: false`（默认）：纯规则——按 `hits` 从低到高淘汰最冷条目 + 合并子串重复内容，零成本确定性；
  - `compressWithLLM: true`：先用 LLM 精炼整个 store（合并重叠、去陈旧），失败回退规则压缩。
  - 压缩只有真正腾出空间才落盘——无法压缩时报错且不误删旧条目。

## Web 图形界面

插件带一个浏览器客户端（`dsh.client` bundle），提供两个界面：

**记忆管理面板**（右侧详情栏，`details` 插槽）：列表（按作用域过滤）、BM25 搜索、**新增 / 编辑 / 删除记忆**、导出 JSON、粘贴导入——全部调用宿主 API，不经模型。

**设置卡片**（`Settings → Plugins → long-term-memory`，`settings.plugin.item` 插槽）：基础开关——自动总结、LLM 压缩、上下文注入模式、写入审批、字符预算，保存即写入 `settings.yaml` 的 `long-term-memory:` 节（热重载）。

> 其他插件复用同一模式即可获得图形设置入口：注册 settings namespace（宿主侧）+ 挂 `settings.plugin.item` 卡片（客户端侧，`key` 填 namespace）。

## 宿主 API

web profile 下注册以下路由（JSON，界面与命令共用）：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/memory/list?scope=` | GET | 列出各作用域记忆 |
| `/api/memory/search?q=&scope=` | GET | BM25 检索 |
| `/api/memory/get?id=` | GET | 单条记忆 |
| `/api/memory/put` | POST | 新增/编辑（`{id?, scope, content, tags}`） |
| `/api/memory/delete?id=` | GET | 删除单条 |
| `/api/memory/import` | POST | 导入 v1 JSON bundle |
| `/api/memory/settings` | GET/POST | 读写开关（POST 更新 `settings.yaml`） |

## 测试

```sh
node test/unit.test.mjs
```

纯 store 后端（tokenizer / BM25 / JSONL 往返 / 漂移与预算护栏）+ 威胁扫描在临时目录上验证，不依赖 DSH 运行时。

## 文件

- `lib/store.js` — 纯后端：CJK tokenizer、BM25、JSONL 原子持久化、跨进程锁、漂移/不可读防护、字符预算。
- `lib/threats.js` — 轻量威胁模式扫描（写入拒绝 + 注入占位符）。
- `lib/automation.js` — 自动总结/压缩的纯逻辑：回合文本提取、LLM JSON 解析、规则压缩器。
- `lib/llm.js` — 一发一收的辅助 LLM 调用封装（继承 agent 的 provider/model）。
- `lib/index.js` — 插件主体：注册工具、三档动态上下文注入、自动总结钩子、压缩接入、设置 namespace、宿主 API。
- `lib/client.js` — 浏览器 bundle：记忆管理面板（details 栏）+ 设置卡片（settings.plugin.item）。
- `cordis.patch.yml` — bundle patch（插入一行 `long-term-memory`）。
- `package.json` — bundle manifest（`dsh.bundle.patch` + `dsh.client`）。
- `lib/types/` — `index.d.ts`（插件）+ `store.d.ts`（store 模块）类型声明。
- `test/unit.test.mjs` — 单元测试。

## 设计取舍

- **确定性优先**：不用 embedding、不额外调模型，召回完全本地、结果可解释，契合 DSH 的简约哲学。
- **三库分层**：`user` 画像 > `global` 跨项目 > `workspace` 项目内，注入与 `all` 检索都按此优先级。
- **注入保持同步**：DSH 的 prompt 组装器同步调用 `text` 函数，异步会返回 Promise 导致崩溃——注入渲染全部走同步路径（首个 assembly 前异步预热 store）。
- **写入门可关闭**：默认 `requireApprovalForWrite: false`，开箱即用；需要审计/人工确认时开启。
- **威胁扫描保守**：模式刻意收窄（指令覆盖/系统提示泄露/角色劫持/标记注入），避免把正常笔记误伤；注入快照用占位符而非删条，原文保留供用户处理。
- **无 Web 面板**：v1 只做模型工具 + 注入；浏览用 `memory_list`，不引入客户端 bundle。

## 实测基准（本机 macOS / Node 22，真实 defineTool + 真实 store）

| 操作 | 延迟 | 说明 |
|---|---|---|
| 每轮注入渲染（sync，内存读） | ~15 µs | 每请求一次，可忽略 |
| `memory_write`（锁 + 原子写 + 威胁扫描） | ~2 ms | 低频 |
| `memory_recall`（BM25 + 内存 touch） | ~0.3 ms | 修复前 ~11 ms（touch 曾全文件重写） |
| 威胁扫描（11 模式） | ~0.7 µs | 可忽略 |

## Roadmap

- [x] 基础记忆：三作用域 + BM25 召回 + JSONL 存储
- [x] 导出/导入、批量操作、/memory 命令
- [x] 威胁扫描、写入护栏、自动总结、LLM 压缩
- [x] Web 管理界面（记忆面板 + 设置卡片）
- [x] 多标签右侧栏容器（details-tabs：记忆/产物/官方详情面板自动镜像，v2 并列布局）
- [x] 校准注入框架 + 纠正回路（memory_correct / superseded）
- [x] ~~记忆导出到云盘/剪贴板格式选择~~（已决定不做）
- [x] 标签过滤注入（recent 模式按 tag 过滤，injectTags 热重载）
