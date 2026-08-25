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
| **注入三档** | `recent`（默认，每库最近几条）/ `full`（全部，受字符预算，Hermes 式快照）/ `off`。 |
| **威胁扫描** | 写入内容与注入快照都做轻量威胁模式检测：命中则写入拒绝、注入替换为 `[BLOCKED: …]` 占位符。 |
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

## 配置

在 profile 的 `cordis.patch.yml` 覆盖（`dsh.profile.bundles` 装载后应用）：

```yaml
- id: long-term-memory
  config:
    # 写入前是否需人工审批（默认 false）
    requireApprovalForWrite: false
    # 注入策略：recent（默认）/ full / off（兼容旧布尔 true/false）
    injectContext: recent
    # 写入内容是否做威胁扫描（默认 true）
    scanThreatsOnWrite: true
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
    # 每库字符预算；超限的写入被拒绝并要求先删后加（默认 20000）
    charLimit: 20000
```

## 测试

```sh
node test/unit.test.mjs
```

纯 store 后端（tokenizer / BM25 / JSONL 往返 / 漂移与预算护栏）+ 威胁扫描在临时目录上验证，不依赖 DSH 运行时。

## 文件

- `lib/store.js` — 纯后端：CJK tokenizer、BM25、JSONL 原子持久化、跨进程锁、漂移/不可读防护、字符预算。
- `lib/threats.js` — 轻量威胁模式扫描（写入拒绝 + 注入占位符）。
- `lib/index.js` — 插件主体：注册 4 个工具、三档动态上下文注入、可选审批门。
- `cordis.patch.yml` — bundle patch（插入一行 `long-term-memory`）。
- `package.json` — bundle manifest（`dsh.bundle.patch`）。
- `lib/types/` — `index.d.ts`（插件）+ `store.d.ts`（store 模块）类型声明。
- `test/unit.test.mjs` — 单元测试。

## 设计取舍

- **确定性优先**：不用 embedding、不额外调模型，召回完全本地、结果可解释，契合 DSH 的简约哲学。
- **三库分层**：`user` 画像 > `global` 跨项目 > `workspace` 项目内，注入与 `all` 检索都按此优先级。
- **注入保持同步**：DSH 的 prompt 组装器同步调用 `text` 函数，异步会返回 Promise 导致崩溃——注入渲染全部走同步路径（首个 assembly 前异步预热 store）。
- **写入门可关闭**：默认 `requireApprovalForWrite: false`，开箱即用；需要审计/人工确认时开启。
- **威胁扫描保守**：模式刻意收窄（指令覆盖/系统提示泄露/角色劫持/标记注入），避免把正常笔记误伤；注入快照用占位符而非删条，原文保留供用户处理。
- **无 Web 面板**：v1 只做模型工具 + 注入；浏览用 `memory_list`，不引入客户端 bundle。

## 已知取舍（相对 Hermes）

- 注入的是**按 recency 排序的有界子集**（`recent` 模式）或预算内全量（`full` 模式），而非 Hermes 那种固定 2200/1375 字符的硬上限双库——DSH 插件用 `charLimit` 预算 + `full` 模式可逼近该行为。
- 威胁扫描是**轻量正则集**（11 组：指令覆盖/系统提示泄露/角色劫持/越狱 DAN/developer mode/repeat-above/凭据外发 + 中文变体/标记注入），不是 Hermes 的完整 `threat_patterns.py` 库；覆盖率稍低但零依赖、实测误报为 0。
- 漂移检测以「坏行」为信号；Hermes 还做 § 往返校验与单条超限检测。DSH 的 JSONL 格式下坏行是最主要的漂移来源。
- `touch`（recall 命中计数）是**内存级**的，仅在下次真实写（put/delete）时随文件落盘；进程在两次写之间退出会丢失未落盘的计数增量——对"召回热度"这类信号无实质影响。

## 实测基准（本机 macOS / Node 22，真实 defineTool + 真实 store）

| 操作 | 延迟 | 说明 |
|---|---|---|
| 每轮注入渲染（sync，内存读） | ~15 µs | 每请求一次，可忽略 |
| `memory_write`（锁 + 原子写 + 威胁扫描） | ~2 ms | 低频 |
| `memory_recall`（BM25 + 内存 touch） | ~0.3 ms | 修复前 ~11 ms（touch 曾全文件重写） |
| 威胁扫描（11 模式） | ~0.7 µs | 可忽略 |
