/**
 * dsh-long-term-memory — Browser half.
 *
 * Provides two client surfaces:
 *   1. A memory management panel in the right details column (`details` slot,
 *      priority -2, shadowing the shipped tool-details panel and
 *      artifacts-panel's -1 — lowest priority renders): list, search,
 *      add, edit, delete, export, and import memories across all scopes by
 *      calling the host routes `/api/memory/*`.
 *   2. A settings card in the native plugin settings page
 *      (`settings.plugin.item`, entryKey "long-term-memory"): basic switches
 *      (auto-summarize, LLM compression, injection mode, write approval,
 *      char limit) read/written through `/api/memory/settings` — rendered in
 *      the same place DSH's Settings → Plugins page shows plugin cards.
 *
 * The bundle is hand-written in the `__ModuleLoader__.load` format (same as
 * the shipped client plugins): plain React.createElement (no JSX build step),
 * `ctx.slots.inject` to mount, `ctx.locale.register` for dictionaries.
 */
window.__ModuleLoader__.load({
	id: "dsh-long-term-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region lib/types/client/locales.js
		const NS = "long-term-memory";
		const zh = {
			"panel.title": "长期记忆",
			"panel.open": "打开长期记忆",
			"panel.close": "关闭长期记忆",
			"panel.loading": "加载中…",
			"panel.error": "加载失败：{message}",
			"panel.empty": "还没有记忆",
			"panel.add": "新增记忆",
			"panel.save": "保存",
			"panel.cancel": "取消",
			"panel.edit": "编辑",
			"panel.delete": "删除",
			"panel.superseded": "已更正",
			"panel.search": "搜索…",
			"panel.export": "导出",
			"panel.import": "导入",
			"panel.content": "内容",
			"panel.tags": "标签（逗号分隔）",
			"panel.scope": "作用域",
			"panel.importHint": "粘贴 v1 JSON bundle",
			"panel.settings": "设置",
			"panel.usage": "{used}/{limit} 字符",
			"panel.filter": "全部",
			"panel.categoryAll": "全部分类",
			"panel.emptyFilter": "（无匹配记录，可清除筛选）",
			"panel.untagged": "未分类",
			"tag.preference": "偏好",
			"tag.decision": "决策",
			"tag.constraint": "约束",
			"tag.project": "项目",
			"tag.correction": "更正",
			"tag.personal": "个人",
			"scope.user": "用户画像",
			"scope.global": "全局",
			"scope.workspace": "工作区",
			"settings.title": "长期记忆设置",
			"settings.autoSummarize": "自动总结对话",
			"settings.autoSummarizeDesc": "每轮对话结束后用 LLM 蒸馏值得长期记住的事实（额外模型调用）",
			"settings.compressWithLLM": "LLM 压缩",
			"settings.compressWithLLMDesc": "超限时用 LLM 精炼压缩（关闭则用纯规则压缩）",
			"settings.injectContext": "上下文注入",
			"settings.requireApproval": "写入审批",
			"settings.charLimit": "字符预算",
			"settings.saved": "已保存",
		};
		const en = {
			"panel.title": "Long-term memory",
			"panel.open": "Open long-term memory",
			"panel.close": "Close long-term memory",
			"panel.loading": "Loading…",
			"panel.error": "Failed to load: {message}",
			"panel.empty": "No memories yet",
			"panel.add": "Add memory",
			"panel.save": "Save",
			"panel.cancel": "Cancel",
			"panel.edit": "Edit",
			"panel.delete": "Delete",
			"panel.superseded": "Corrected",
			"panel.search": "Search…",
			"panel.export": "Export",
			"panel.import": "Import",
			"panel.content": "Content",
			"panel.tags": "Tags (comma-separated)",
			"panel.scope": "Scope",
			"panel.importHint": "Paste a v1 JSON bundle",
			"panel.settings": "Settings",
			"panel.usage": "{used}/{limit} chars",
			"panel.filter": "All",
			"panel.categoryAll": "All categories",
			"panel.emptyFilter": "(no matching records — clear a filter)",
			"panel.untagged": "Untagged",
			"tag.preference": "Preference",
			"tag.decision": "Decision",
			"tag.constraint": "Constraint",
			"tag.project": "Project",
			"tag.correction": "Correction",
			"tag.personal": "Personal",
			"scope.user": "User profile",
			"scope.global": "Global",
			"scope.workspace": "Workspace",
			"settings.title": "Long-term memory settings",
			"settings.autoSummarize": "Auto-summarize conversations",
			"settings.autoSummarizeDesc": "Distill durable facts with the LLM after each finished turn (extra model call)",
			"settings.compressWithLLM": "LLM compression",
			"settings.compressWithLLMDesc": "Refine with the LLM when over budget (off = rule-based compression)",
			"settings.injectContext": "Context injection",
			"settings.requireApproval": "Write approval",
			"settings.charLimit": "Char budget",
			"settings.saved": "Saved",
		};
		//#endregion

		//#region lib/types/client/api.js
		/** Tiny JSON helper around the host routes. */
		async function api(path, options) {
			const res = await fetch(path, {
				headers: { "content-type": "application/json" },
				...options,
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
			return body;
		}
		async function apiGet(path) {
			return api(path);
		}
		async function apiPost(path, payload) {
			return api(path, { method: "POST", body: JSON.stringify(payload) });
		}
		/** Locale lookup that never depends on injected props — falls back to zh. */
		function makeT() {
			return (key, params) => {
				const text = zh[key] || key;
				if (!params) return text;
				return Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), text);
			};
		}
		/** Shared minimal button style so the panel and card look consistent. */
		const btnStyle = {
			padding: "4px 10px",
			borderRadius: 6,
			border: "1px solid rgba(128,128,128,.35)",
			background: "rgba(128,128,128,.12)",
			color: "inherit",
			cursor: "pointer",
			fontSize: 12,
		};
		/** Trigger a browser download of `text` as a file. */
		function downloadFile(filename, text, mime) {
			const blob = new Blob([text], { type: mime || "application/octet-stream" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		}
		//#endregion

		//#region lib/types/client/highlight.js
		/**
		 * Lightweight, dependency-free content renderer for memory text:
		 * highlights fenced code blocks, inline `code`, and URLs. Everything
		 * else stays plain. Returns React elements — no HTML is ever built,
		 * so arbitrary memory text is safe to render.
		 */
		const CODE_INLINE_STYLE = {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: 12,
			background: "rgba(128,128,128,.16)",
			padding: "0 3px",
			borderRadius: 3,
			wordBreak: "break-all",
		};
		const CODE_BLOCK_STYLE = {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: 12,
			background: "rgba(60,140,255,.07)",
			border: "1px solid rgba(60,140,255,.15)",
			borderRadius: 4,
			padding: "4px 6px",
			margin: "2px 0",
			whiteSpace: "pre-wrap",
			overflowX: "auto",
		};
		const URL_STYLE = {
			color: "var(--dsw-alias-state-info-primary, #6af)",
			textDecoration: "underline",
			wordBreak: "break-all",
		};
		const HIGHLIGHT_RE = /(```[\s\S]*?```)|(`[^`\n]+`)|((?:https?:\/\/)[^\s<>"']+)/g;
		/** Render memory text with code/URL highlighting into React elements. */
		function renderContent(text, keyPrefix) {
			const source = String(text ?? "");
			const out = [];
			let last = 0;
			let i = 0;
			let match;
			while ((match = HIGHLIGHT_RE.exec(source)) !== null) {
				if (match.index > last) out.push(react.createElement("span", { key: `${keyPrefix}-t${i++}` }, source.slice(last, match.index)));
				if (match[1] !== undefined) {
					// fenced code block: strip the fence lines, keep the body
					const inner = match[1].replace(/^```[^\n]*\n?/, "").replace(/```\s*$/, "");
					out.push(react.createElement("div", { key: `${keyPrefix}-b${i++}`, style: CODE_BLOCK_STYLE }, inner));
				} else if (match[2] !== undefined) {
					out.push(react.createElement("span", { key: `${keyPrefix}-c${i++}`, style: CODE_INLINE_STYLE }, match[2].slice(1, -1)));
				} else if (match[3] !== undefined) {
					const url = match[3].replace(/[.,;:!?)]+$/, "");
					out.push(react.createElement("a", { key: `${keyPrefix}-u${i++}`, href: url, target: "_blank", rel: "noreferrer", style: URL_STYLE }, url));
				}
				last = match.index + match[0].length;
			}
			if (last < source.length) out.push(react.createElement("span", { key: `${keyPrefix}-t${i}` }, source.slice(last)));
			return out;
		}
		//#endregion

		//#region lib/types/client/MemoryPanel.js
		/**
		 * The memory management panel: list + search + add/edit/delete + export/import.
		 * Fetches the host routes; keeps a small local state machine.
		 */
		function MemoryPanel(props) {
			const t = makeT();
			const closeDetails = props.closeDetails;
			// When rendered inside the details-tabs container, the container
			// passes `embedded: true` (ownerProps win) and provides its own leaf
			// header — hide the standalone title bar + close button to avoid a
			// duplicate chrome per panel.
			const embedded = props.embedded === true;
			const [records, setRecords] = react.useState([]);
			const [query, setQuery] = react.useState("");
			const [scopeFilter, setScopeFilter] = react.useState("all");
			const [catFilter, setCatFilter] = react.useState("all"); // "all" | category tag
			const [loading, setLoading] = react.useState(true);
			const [error, setError] = react.useState(null);
			const [usage, setUsage] = react.useState(0);
			const [limit, setLimit] = react.useState(0);
			const [editing, setEditing] = react.useState(null); // null | { id?, scope, content, tags }
			const [importOpen, setImportOpen] = react.useState(false);
			const [importText, setImportText] = react.useState("");
			const [notice, setNotice] = react.useState(null);

			const load = react.useCallback(async () => {
				try {
					setLoading(true);
					const data = await apiGet(`/api/memory/list?scope=${scopeFilter}`);
					setRecords(data.results || []);
					const settings = await apiGet("/api/memory/settings");
					setUsage(data.results.reduce((s, r) => s + (r.content?.length || 0), 0));
					setLimit(settings.charLimit || 0);
					setError(null);
				} catch (e) {
					setError(String(e.message || e));
				} finally {
					setLoading(false);
				}
			}, [scopeFilter]);

			react.useEffect(() => { load(); }, [load]);

			const runSearch = react.useCallback(async () => {
				try {
					setLoading(true);
					const data = query.trim()
						? await apiGet(`/api/memory/search?q=${encodeURIComponent(query)}&scope=${scopeFilter}`)
						: await apiGet(`/api/memory/list?scope=${scopeFilter}`);
					setRecords(data.results || []);
					setError(null);
				} catch (e) {
					setError(String(e.message || e));
				} finally {
					setLoading(false);
				}
			}, [query, scopeFilter]);

			const saveRecord = react.useCallback(async () => {
				if (!editing || !editing.content.trim()) return;
				try {
					await apiPost("/api/memory/put", {
						...(editing.id ? { id: editing.id } : {}),
						scope: editing.scope,
						content: editing.content.trim(),
						tags: editing.tags.split(",").map((s) => s.trim()).filter(Boolean),
					});
					setEditing(null);
					setNotice("saved");
					setTimeout(() => setNotice(null), 1500);
					await load();
				} catch (e) {
					setError(String(e.message || e));
				}
			}, [editing, load]);

			const removeRecord = react.useCallback(async (id) => {
				try {
					await apiGet(`/api/memory/delete?id=${encodeURIComponent(id)}`);
					await load();
				} catch (e) {
					setError(String(e.message || e));
				}
			}, [load]);

			const [exportFormat, setExportFormat] = react.useState("json");
			const [showSettings, setShowSettings] = react.useState(false);

			const doExport = react.useCallback(async () => {
				try {
					const data = await apiGet(`/api/memory/list?scope=all`);
					const records = (data.results || []).map((r) => ({ scope: r.scope, content: r.content, tags: r.tags || [] }));
					const stamp = new Date().toISOString().slice(0, 10);
					if (exportFormat === "markdown") {
						const lines = ["# Long-term memory export", ""];
						for (const scope of ["user", "global", "workspace"]) {
							const group = records.filter((r) => r.scope === scope);
							if (group.length === 0) continue;
							lines.push(`## ${scope}`, "");
							for (const r of group) {
								const tags = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
								lines.push(`- ${r.content}${tags}`);
							}
							lines.push("");
						}
						downloadFile(`long-term-memory-${stamp}.md`, lines.join("\n"), "text/markdown");
					} else {
						downloadFile(`long-term-memory-${stamp}.json`, JSON.stringify({ version: 1, records }, null, 2), "application/json");
					}
					setNotice("exported");
					setTimeout(() => setNotice(null), 1500);
				} catch (e) {
					setError(String(e.message || e));
				}
			}, [exportFormat]);

			const doImport = react.useCallback(async () => {
				try {
					const data = await apiPost("/api/memory/import", { bundle: importText });
					setImportOpen(false);
					setImportText("");
					setNotice(`imported ${data.imported}`);
					setTimeout(() => setNotice(null), 2000);
					await load();
				} catch (e) {
					setError(String(e.message || e));
				}
			}, [importText, load]);

			const scopeOptions = ["user", "global", "workspace"].map((s) =>
				react.createElement("option", { key: s, value: s }, t(`scope.${s}`))
			);

			// ── 按逻辑分类（tag）分组展示 ──────────────────────────────────────
			// 按作用域优先分组展示（与存储层级一致）：分组段 = 用户画像/全局/工作区，
			// 每条记录带 tag 徽标。分类（tag）下拉作为二级过滤。
			const SCOPES = ["user", "global", "workspace"];
			const categoryLabel = (tag) => {
				const known = t(`tag.${tag}`);
				return known && !known.startsWith("tag.") ? known : `#${tag}`;
			};
			// 当前记录里出现过的 tag（用于分类下拉，不影响分组）。
			const cats = [...new Set((records || []).flatMap((r) => (Array.isArray(r.tags) ? r.tags : [])))].sort();
			const byScope = new Map();
			for (const r of records || []) {
				if (catFilter !== "all" && !(Array.isArray(r.tags) && r.tags.includes(catFilter))) continue;
				const sc = (typeof r.scope === "string" && SCOPES.includes(r.scope)) ? r.scope : "global";
				if (!byScope.has(sc)) byScope.set(sc, []);
				byScope.get(sc).push(r);
			}
			const visibleScopes = SCOPES.filter((sc) => (scopeFilter === "all" || scopeFilter === sc) && byScope.has(sc));
			const sections = visibleScopes.map((sc) => {
				const list = byScope.get(sc);
				const rows = list.map((r) =>
					react.createElement("div", { key: r.id, style: { borderBottom: "1px solid rgba(128,128,128,.2)", padding: "6px 0", opacity: r.superseded ? .55 : 1 } },
						react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
							r.superseded === true && react.createElement("span", { style: { fontSize: 11, color: "#b8860b", border: "1px solid rgba(184,134,11,.5)", borderRadius: 8, padding: "0 5px" } }, t("panel.superseded")),
							react.createElement("span", { style: { fontSize: 11, opacity: .5 } }, `#${String(r.id).slice(0, 8)}`),
							react.createElement("button", { onClick: () => setEditing({ id: r.id, scope: r.scope, content: r.content, tags: (r.tags || []).join(", ") }), style: btnStyle }, t("panel.edit")),
							react.createElement("button", { onClick: () => removeRecord(r.id), style: { ...btnStyle, color: "#c33" } }, t("panel.delete")),
						),
						react.createElement("div", { style: { marginTop: 2, whiteSpace: "pre-wrap" } }, ...renderContent(r.content, r.id)),
						(r.tags && r.tags.length > 0) &&
							react.createElement("div", { style: { fontSize: 11, opacity: .6 } }, r.tags.map((tag) => `#${tag}`).join(" ")),
					)
				);
				return react.createElement("div", { key: sc },
					react.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 6, margin: "8px 0 2px", borderBottom: "1px solid rgba(128,128,128,.25)" } },
						react.createElement("span", { style: { fontWeight: 600, fontSize: 12 } }, t(`scope.${sc}`)),
						react.createElement("span", { style: { fontSize: 11, opacity: .5 } }, `(${list.length})`),
					),
					rows,
				);
			});

			const filterRow = react.createElement("div", { style: { display: "flex", gap: 6, marginBottom: 8 } },
				react.createElement("input", {
					style: { flex: 1 },
					placeholder: t("panel.search"),
					value: query,
					onChange: (e) => setQuery(e.target.value),
					onKeyDown: (e) => { if (e.key === "Enter") runSearch(); },
				}),
				react.createElement("select", { value: scopeFilter, onChange: (e) => setScopeFilter(e.target.value) },
					react.createElement("option", { value: "all" }, t("panel.filter")),
					...scopeOptions,
				),
				react.createElement("select", { value: catFilter, onChange: (e) => setCatFilter(e.target.value), title: t("panel.categoryAll") },
					react.createElement("option", { value: "all" }, t("panel.categoryAll")),
					...cats.map((c) => react.createElement("option", { key: c, value: c }, categoryLabel(c))),
				),
				react.createElement("button", { onClick: runSearch }, "⟳"),
			);

			const editor = editing && react.createElement("div", { style: { border: "1px solid rgba(128,128,128,.3)", padding: 8, marginBottom: 8, borderRadius: 6 } },
				react.createElement("div", null, t("panel.scope"),
					react.createElement("select", { value: editing.scope, onChange: (e) => setEditing({ ...editing, scope: e.target.value }) }, ...scopeOptions),
				),
				react.createElement("textarea", {
					style: { width: "100%", minHeight: 60, marginTop: 4 },
					placeholder: t("panel.content"),
					value: editing.content,
					onChange: (e) => setEditing({ ...editing, content: e.target.value }),
				}),
				react.createElement("input", {
					style: { width: "100%", marginTop: 4 },
					placeholder: t("panel.tags"),
					value: editing.tags,
					onChange: (e) => setEditing({ ...editing, tags: e.target.value }),
				}),
				react.createElement("div", { style: { marginTop: 6, display: "flex", gap: 6 } },
					react.createElement("button", { onClick: saveRecord }, t("panel.save")),
					react.createElement("button", { onClick: () => setEditing(null) }, t("panel.cancel")),
				),
			);

			const importRow = importOpen && react.createElement("div", { style: { border: "1px solid rgba(128,128,128,.3)", padding: 8, marginBottom: 8, borderRadius: 6 } },
				react.createElement("textarea", {
					style: { width: "100%", minHeight: 80 },
					placeholder: t("panel.importHint"),
					value: importText,
					onChange: (e) => setImportText(e.target.value),
				}),
				react.createElement("div", { style: { marginTop: 6, display: "flex", gap: 6 } },
					react.createElement("button", { onClick: doImport }, t("panel.import")),
					react.createElement("button", { onClick: () => setImportOpen(false) }, t("panel.cancel")),
				),
			);

			const toolbar = react.createElement("div", { style: { display: "flex", gap: 6, marginBottom: 8, alignItems: "center", flexWrap: "wrap" } },
				react.createElement("select", { value: exportFormat, onChange: (e) => setExportFormat(e.target.value), style: btnStyle }, 
					react.createElement("option", { value: "json" }, "JSON"),
					react.createElement("option", { value: "markdown" }, "MD"),
				),
				react.createElement("button", { onClick: doExport, style: btnStyle }, t("panel.export")),
				react.createElement("button", { onClick: () => setImportOpen(!importOpen), style: btnStyle }, t("panel.import")),
				react.createElement("button", { onClick: () => setEditing({ scope: "global", content: "", tags: "" }), style: { ...btnStyle, background: "rgba(60,140,255,.2)", borderColor: "rgba(60,140,255,.4)" } }, t("panel.add")),
				react.createElement("button", { onClick: () => setShowSettings(!showSettings), style: { ...btnStyle, background: showSettings ? "rgba(60,200,120,.2)" : undefined } }, t("panel.settings")),
				usage > 0 && react.createElement("span", { style: { fontSize: 11, opacity: .6, marginLeft: "auto" } }, t("panel.usage", { used: usage, limit })),
			);

			const body = showSettings
				? react.createElement(SettingsCard, null)
				: react.createElement("div", null,
					editor,
					importRow,
					loading ? react.createElement("div", null, t("panel.loading")) : (sections.length ? sections : react.createElement("div", { style: { opacity: .6 } }, (records && records.length > 0) ? t("panel.emptyFilter") : t("panel.empty"))),
				);

			return react.createElement("div", { style: { padding: 10, fontSize: 13, overflowY: "auto", height: "100%" } },
				!embedded && react.createElement("div", { style: { display: "flex", alignItems: "center", fontWeight: 600, marginBottom: 8 } },
					react.createElement("span", { style: { flex: 1 } }, t("panel.title")),
					typeof closeDetails === "function" && react.createElement("button", { onClick: closeDetails, style: { ...btnStyle, padding: "2px 8px" }, title: t("panel.close") }, "✕"),
				),
				notice && react.createElement("div", { style: { color: "#3a9" } }, notice),
				error && react.createElement("div", { style: { color: "#c33", marginBottom: 6 } }, t("panel.error", { message: error })),
				filterRow,
				toolbar,
				body,
			);
		}

		//#endregion

		//#region lib/types/client/SettingsCard.js
		/**
		 * The settings card rendered in Settings → Plugins → long-term-memory.
		 * Reads/writes /api/memory/settings.
		 */
		function SettingsCard(props) {
			const t = makeT();
			const [cfg, setCfg] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			react.useEffect(() => {
				apiGet("/api/memory/settings").then(setCfg).catch((e) => setCfg({ error: String(e) }));
			}, []);
			if (!cfg) return react.createElement("div", null, t("panel.loading"));
			if (cfg.error) return react.createElement("div", null, String(cfg.error));
			const set = (patch) => setCfg({ ...cfg, ...patch });
			const save = async () => {
				try {
					await apiPost("/api/memory/settings", cfg);
					setNotice(true);
					setTimeout(() => setNotice(false), 1500);
				} catch (e) { /* settings write errors surface via settings.yaml validation */ }
			};
			const row = (label, desc, control) => react.createElement("div", { style: { padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,.15)" } },
				react.createElement("div", { style: { fontWeight: 600 } }, label),
				desc && react.createElement("div", { style: { fontSize: 12, opacity: .65 } }, desc),
				react.createElement("div", { style: { marginTop: 4 } }, control),
			);
			return react.createElement("div", { style: { padding: 12 } },
				react.createElement("div", { style: { fontWeight: 700, marginBottom: 8 } }, t("settings.title")),
				notice && react.createElement("div", { style: { color: "#3a9", marginBottom: 6 } }, t("settings.saved")),
				row(t("settings.autoSummarize"), t("settings.autoSummarizeDesc"),
					react.createElement("input", { type: "checkbox", checked: !!cfg.autoSummarize, onChange: (e) => set({ autoSummarize: e.target.checked }) })),
				row(t("settings.compressWithLLM"), t("settings.compressWithLLMDesc"),
					react.createElement("input", { type: "checkbox", checked: !!cfg.compressWithLLM, onChange: (e) => set({ compressWithLLM: e.target.checked }) })),
				row(t("settings.injectContext"), null,
					react.createElement("select", { value: cfg.injectContext || "recent", onChange: (e) => set({ injectContext: e.target.value }) },
						react.createElement("option", { value: "recent" }, "recent"),
						react.createElement("option", { value: "full" }, "full"),
						react.createElement("option", { value: "off" }, "off"),
					)),
				row(t("settings.requireApproval"), null,
					react.createElement("input", { type: "checkbox", checked: !!cfg.requireApprovalForWrite, onChange: (e) => set({ requireApprovalForWrite: e.target.checked }) })),
				row(t("settings.charLimit"), null,
					react.createElement("input", { type: "number", value: cfg.charLimit || 0, onChange: (e) => set({ charLimit: Number(e.target.value) }) })),
				react.createElement("button", { onClick: save, style: { ...btnStyle, marginTop: 10, background: "rgba(60,140,255,.2)", borderColor: "rgba(60,140,255,.4)" } }, t("panel.save")),
			);
		}
		//#endregion

		//#region lib/types/client/apply.js
		// Browser-side services this client bundle needs, resolved by the client
		// module loader: slots (dsh-client-ui-slots), locale (dsh-client-locale),
		// layout (dsh-client-ui-layout).
		const inject = ["slots", "locale", "layout"];

		/**
		 * Adaptive panel mounting: register into the details-tabs container when
		 * it is present (details.tabs.item declared), otherwise fall back to
		 * owning the plain `details` slot directly — so the panel works standalone
		 * and does not depend on (or clash with) the container plugin.
		 * @param ctx - client context (slots/layout).
		 * @param panel - { key, label, locale, component } panel identity.
		 */
		function mountPanel(ctx, panel) {
			const containerKey = "details.tabs.item";
			let mounted = false;
			let disposer = null;
			const unmount = () => { if (disposer) { disposer(); disposer = null; } mounted = false; };

			const mountTab = () => {
				unmount();
				disposer = ctx.slots.register({
					name: containerKey,
					key: panel.key,
					label: panel.label,
					locale: panel.locale,
					inject: () => ({ closeDetails: () => ctx.layout.closeDetails() }),
				}, panel.component);
				mounted = true;
			};
			const mountStandalone = () => {
				unmount();
				// Avoid a priority collision when another panel is already
				// standalone on `details` (e.g. container absent, two panels
				// installed): go one lower than the deepest existing registration.
				let priority = -2;
				try {
					const existing = ctx.slots.entries("details") || [];
					for (const e of existing) {
						const p = e.options?.priority;
						if (typeof p === "number" && p <= priority) priority = p - 1;
					}
				} catch { /* keep -2 */ }
				disposer = ctx.slots.register({
					name: "details",
					priority,
					locale: panel.locale,
					inject: () => ({ closeDetails: () => ctx.layout.closeDetails() }),
				}, panel.component);
				mounted = true;
			};

			const hasContainer = () => { try { return ctx.slots.spec(containerKey) !== undefined; } catch { return false; } };

			// Container may load after this panel (bundle order) or unload at
			// runtime. Subscribe to the container slot and MIGRATE only when the
			// mounted position no longer matches the current reality — never
			// re-register when already correct (registering into a slot fires its
			// own change event; an unguarded re-register would loop forever).
			let unsub = null;
			let mountedAs = null; // 'tab' | 'standalone'
			const sync = () => {
				const wantTab = hasContainer();
				const desired = wantTab ? 'tab' : 'standalone';
				if (mountedAs === desired) return; // already correct — no-op
				// Set the target BEFORE mounting: registering fires the slot's own
				// change event, which re-enters sync(); the guard above then sees
				// the already-correct position and returns instead of looping.
				mountedAs = desired;
				if (wantTab) mountTab();
				else mountStandalone();
			};
			const armSubscribe = () => {
				if (unsub) return;
				const keys = ["details", containerKey];
				const handlers = [];
				try {
					for (const key of keys) {
						handlers.push(ctx.slots.subscribe(key, sync));
					}
					unsub = () => { for (const h of handlers) h(); };
				} catch { unsub = null; }
			};

			sync();
			armSubscribe();
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "long-term-memory: dictionaries");

			// Memory management panel: a tab inside dsh-details-tabs when the
			// container is installed, otherwise a standalone details panel.
			mountPanel(ctx, {
				key: "long-term-memory",
				label: "长期记忆",
				locale: NS,
				component: MemoryPanel,
			});

			// Settings card in Settings → Plugins → long-term-memory.
			// `key` matches the settings namespace so the Plugins page dispatches
			// this card only for the long-term-memory entry.
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: "long-term-memory",
				locale: NS,
				inject: () => ({}),
			}, SettingsCard));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.renderContent = renderContent;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
