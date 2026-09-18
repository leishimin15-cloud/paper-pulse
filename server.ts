import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type AgentEvent, runPaperAgent } from "./agent.ts";
import { PaperMcpClient } from "./mcp-client.ts";
import { RunTraceRecorder, readRecentRuns } from "./observability.ts";
import { isSourceType } from "./sources.ts";
import type { MemoryRecallResult, Paper, SearchResult } from "./types.ts";

const root = dirname(fileURLToPath(import.meta.url));
const databasePath = resolve(process.env.PAPER_PULSE_DB ?? resolve(root, "data", "paper-pulse.db"));
const tracePath = resolve(process.env.PAPER_PULSE_TRACE_PATH ?? resolve(root, "data", "traces.jsonl"));
const mcp = await PaperMcpClient.connect(root, databasePath);
const tools = await mcp.listTools();
const userId = process.env.PAPER_PULSE_USER_ID?.trim() || "local-user";
let active = 0;

async function readJson(req: IncomingMessage, maxBytes = 32_768): Promise<Record<string, unknown>> {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (Buffer.byteLength(body) > maxBytes) throw new Error("请求内容过大");
	}
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new Error("JSON 格式错误");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须是 JSON 对象");
	return value as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(value));
}

function validateOrigin(req: IncomingMessage): boolean {
	return !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
}

function searchInput(input: Record<string, unknown>): {
	query: string;
	limit: number;
	sources: string[];
	coreConcepts: string[];
	expansionTerms: string[];
} {
	if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 500)
		throw new Error("请输入 1–500 字的研究主题");
	const limit = typeof input.limit === "number" ? Math.round(input.limit) : 15;
	const sources = Array.isArray(input.sources)
		? input.sources.filter((source): source is string => typeof source === "string" && isSourceType(source))
		: ["demo"];
	const terms = (value: unknown, maximum: number) =>
		Array.isArray(value)
			? value.filter((term): term is string => typeof term === "string" && term.trim().length >= 2).slice(0, maximum)
			: [];
	return {
		query: input.query.trim(),
		limit: Math.max(10, Math.min(limit, 20)),
		sources: sources.length ? sources : ["demo"],
		coreConcepts: terms(input.coreConcepts, 4),
		expansionTerms: terms(input.expansionTerms, 8),
	};
}

function demoReport(prompt: string, papers: Paper[]): string {
	const paperLines = papers
		.map(
			(paper, index) =>
				`${index + 1}. **${paper.title}**\n   - 发表：${paper.venue ?? "来源未知"} · CCF ${paper.ccf?.rank ?? "未匹配"} · ${paper.publishedAt ?? "日期未知"}\n   - 摘要归纳：${paper.abstract ?? "摘要不可用"}${paper.sourceUrl ? `\n   - [查看论文](${paper.sourceUrl})` : ""}`,
		)
		.join("\n");
	return `## PaperPulse 顶刊雷达

**研究方向：** ${prompt}

### 最新论文及摘要归纳

${paperLines || "当前演示库没有匹配论文。"}

### 跨论文趋势

当前演示结果体现三条路线：分层长期记忆、自适应检索策略、引用忠实度评测。真实 Pi 模式会基于 Google Scholar 返回的摘要或检索片段生成主题归纳。

> 当前只返回 3 篇明确标记的合成演示论文，不能用于真实引用。`;
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	try {
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store, max-age=0",
			});
			res.end(await readFile(resolve(root, "index.html")));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/status") {
			const library = await mcp.call<{ stats: unknown; ccfPolicy: unknown }>("list_library", { limit: 1 });
			json(res, 200, {
				mcp: "connected",
				tools,
				databasePath,
				stats: library.stats,
				sources: { googleScholar: Boolean(process.env.SERPAPI_API_KEY) },
				ccfPolicy: library.ccfPolicy,
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/health") {
			json(res, 200, { status: "ok", mcp: "connected", activeRuns: active });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/library") {
			json(res, 200, await mcp.call("list_library", { limit: 50 }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/runs") {
			const limit = Number(url.searchParams.get("limit") ?? 20);
			json(res, 200, { runs: await readRecentRuns(tracePath, Number.isFinite(limit) ? limit : 20) });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/memory") {
			const limit = Number(url.searchParams.get("limit") ?? 20);
			json(
				res,
				200,
				await mcp.call("recall_research_memory", {
					query: (url.searchParams.get("query") ?? "").slice(0, 500),
					limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 20)) : 20,
					userId,
				}),
			);
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/memory") {
			if (!validateOrigin(req)) {
				res.writeHead(403).end();
				return;
			}
			const input = await readJson(req);
			json(
				res,
				200,
				await mcp.call("forget_research_memory", {
					userId,
					memoryId: typeof input.memoryId === "string" ? input.memoryId : undefined,
					clearAll: input.clearAll === true,
				}),
			);
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(404).end();
			return;
		}
		if (!validateOrigin(req)) {
			res.writeHead(403).end();
			return;
		}
		if (url.pathname === "/api/search") {
			const input = searchInput(await readJson(req));
			json(res, 200, await mcp.call("search_ccf_papers", input));
			return;
		}
		if (url.pathname === "/api/feedback") {
			const input = await readJson(req);
			if (
				typeof input.paperId !== "string" ||
				!["save", "skip", "read", "like", "dislike"].includes(String(input.action))
			)
				throw new Error("反馈参数无效");
			json(res, 200, await mcp.call("save_feedback", { paperId: input.paperId, action: input.action, userId }));
			return;
		}
		if (url.pathname !== "/api/chat") {
			res.writeHead(404).end();
			return;
		}
		if (active >= 4) {
			res.writeHead(429).end("服务繁忙，请稍后重试");
			return;
		}
		const input = await readJson(req);
		const search = searchInput(input);
		const mode = process.env.SERPAPI_API_KEY ? "pi" : "demo";
		const trace = new RunTraceRecorder(tracePath, search.query, mode);
		res.writeHead(200, {
			"Content-Type": "application/x-ndjson; charset=utf-8",
			"Cache-Control": "no-cache",
		});
		let searchPlan: { coreConcepts: string[]; expansionTerms: string[] } | undefined;
		let selectedPapers: SearchResult["papers"] = [];
		let detectedDomain = "";
		let reportText = "";
		const send = (event: AgentEvent) => {
			if (event.type === "search-plan") searchPlan = event;
			if (event.type === "papers") {
				selectedPapers = event.papers;
				detectedDomain = event.policy.domain;
			}
			if (event.type === "text") reportText += event.text;
			if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
		};
		active++;
		let session: AgentSession | undefined;
		const abort = () => {
			void session?.abort();
		};
		const timer = setTimeout(abort, 120_000);
		res.on("close", abort);
		let runError: string | undefined;
		try {
			if (mode === "pi") {
				const sourceInstruction = search.sources.includes("google-scholar")
					? "调用 search_ccf_papers 并设置 live=true。"
					: "使用演示数据并设置 live=false。";
				await runPaperAgent({
					root,
					prompt: `${search.query}\n先提取英文核心概念和同义扩展词，再自动判断 CCF 计算机子领域，只保留 CCF 2026 A/B/C 来源，最多 ${search.limit} 篇。${sourceInstruction} 检索后必须调用 submit_paper_summaries，为每篇结果提交基于现有证据的中文摘要归纳，然后再输出最终报告。`,
					mcp,
					send,
					trace,
					userId,
					onSession: (value) => {
						session = value;
					},
				});
			} else {
				send({ type: "status", text: "正在召回研究记忆" });
				trace.recordMcpCall();
				const memorySpanId = trace.startSpan("memory.recall", "mcp", { userId });
				const memory = await mcp.call<MemoryRecallResult>("recall_research_memory", {
					query: search.query,
					limit: 8,
					userId,
				});
				trace.recordMemoryRecall(memory.stats.returned);
				trace.finishSpan(memorySpanId, "ok", { recalled: memory.stats.returned, total: memory.stats.total });
				send({ type: "memory-recall", recalled: memory.stats.returned, total: memory.stats.total });
				send({ type: "status", text: "通过 MCP 检索顶刊演示数据" });
				trace.recordMcpCall();
				const spanId = trace.startSpan("tool.search_ccf_papers", "mcp", { source: "demo" });
				let result: SearchResult;
				try {
					result = await mcp.call<SearchResult>("search_ccf_papers", {
						...search,
						userId,
						sources: ["demo"],
					});
					trace.finishSpan(spanId, "ok");
				} catch (error) {
					trace.finishSpan(spanId, "error");
					throw error;
				}
				trace.recordSearch(result);
				send({ type: "papers", papers: result.papers, sourceStatus: result.sourceStatus, policy: result.policy });
				send({ type: "text", text: demoReport(search.query, result.papers) });
			}
		} catch (error) {
			runError = error instanceof Error ? error.message : "Agent 执行失败";
		} finally {
			if (!runError) {
				const memorySpanId = trace.startSpan("memory.write", "mcp", { memoryType: "research-history" });
				trace.recordMcpCall();
				try {
					await mcp.call("save_research_memory", {
						userId,
						memoryType: "research-history",
						content: search.query,
						tags: [
							...(searchPlan?.coreConcepts ?? search.coreConcepts),
							...(searchPlan?.expansionTerms ?? search.expansionTerms),
							...(detectedDomain ? [detectedDomain] : []),
						].slice(0, 30),
						sourceRunId: trace.runId,
						confidence: 1,
						metadata: {
							domain: detectedDomain,
							paperIds: selectedPapers.map((paper) => paper.id),
							reportPreview: reportText.slice(0, 2000),
						},
					});
					trace.recordMemoryWrite(1);
					trace.finishSpan(memorySpanId, "ok", { saved: 1 });
				} catch (memoryError) {
					trace.finishSpan(memorySpanId, "error", {
						error: memoryError instanceof Error ? memoryError.message : "记忆写入失败",
					});
				}
			}
			const run = await trace.finish(runError ? "error" : "ok", runError);
			send({ type: "trace", trace: run });
			send(runError ? { type: "error", text: runError } : { type: "done" });
			clearTimeout(timer);
			res.off("close", abort);
			active--;
			res.end();
		}
	} catch (error) {
		if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : "请求失败" });
		else res.end();
	}
});

const port = Number(process.env.PORT ?? 3220);
const host = process.env.HOST?.trim() || "127.0.0.1";
server.listen(port, host, () => {
	console.log(`PaperPulse: http://${host}:${port}`);
	console.log(`MCP tools: ${tools.join(", ")}`);
});

async function shutdown(): Promise<void> {
	server.close();
	await mcp.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
