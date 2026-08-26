# Changelog

## [0.1.0] - 2026-08-26

### Added
- 初始版本：三作用域（user/global/workspace）记忆，CJK 感知 BM25 召回，JSONL 原子存储
- 4 个模型工具：memory_write / memory_recall / memory_list / memory_forget
- 每轮上下文注入（recent/full/off 三档）
- 威胁扫描（23 组模式）、写入护栏（跨进程锁/漂移备份/字符预算）
- memory_batch 原子批量操作
- memory_export / memory_import 可移植 bundle
- /memory 用户命令
- 自动总结（agent/status 蒸馏）+ 自动压缩（规则/LLM）
- Web 管理界面：右侧记忆面板 + 设置卡片（Settings → Plugins）
- 宿主 API：/api/memory/*（list/search/get/put/delete/import/settings）
