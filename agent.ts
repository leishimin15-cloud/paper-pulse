import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Type } from "typebox";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { PaperMcpClient } from "./mcp-client.ts";
import type { RunTraceRecorder } from "./observability.ts";
import type { MemoryRecallResult, SearchResult } from "./types.ts";

interface PaperSummary {
	paperId: string;
	summaryZh: string;
	evidence: "abstract" | "scholar-snippet" | "metadata" | "demo";
}

export type AgentEvent =
	| { type: "text"; text: string }
	| { type: "status"; text: string }
	| { type: "search-plan"; coreConcepts: string[]; expansionTerms: string[] }
	| {
			type: "papers";
			papers: SearchResult["papers"];
			sourceStatus: SearchResult["sourceStatus"];
			policy: SearchResult["policy"];
	  }
	| { type: "paper-summaries"; summaries: PaperSummary[] }
	| { type: "memory-recall"; recalled: number; total: number }
	| { type: "trace"; trace: Awaited<ReturnType<RunTraceRecorder["finish"]>> }
	| { type: "done" }
	| { type: "error"; text: string };

interface RunAgentOptions {
	root: string;
	prompt: string;
	mcp: PaperMcpClient;
	send: (event: AgentEvent) => void;
	trace: RunTraceRecorder;
	userId: string;
	onSession?: (session: AgentSession) => void;
}

export async function runPaperAgent(options: RunAgentOptions): Promise<void> {
	const skillsDir = resolve(options.root, ".pi", "skills");
	const loader = new DefaultResourceLoader({
		cwd: options.root,
		agentDir: getAgentDir(),
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		appendSystemPromptOverride: () => [],
		systemPromptOverride: (base) =>
			base ?? "你是 PaperPulse 学术研究 Agent。先检索，再基于工具结果回答；没有证据时明确说明，不得虚构论文。",
	});
	await loader.reload();
	const diagnostics = loader.getSkills().diagnostics;
	if (diagnostics.length) options.send({ type: "status", text: `Skill 加载提示：${diagnostics.length} 条` });
	const searchedPaperIds = new Set<string>();
	let memoryRecalled = false;

	const result = await createAgentSession({
		cwd: options.root,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(options.root),
		tools: [
			"read",
			"recall_research_memory",
			"save_research_memory",
			"forget_research_memory",
			"search_ccf_papers",
			"submit_paper_summaries",
			"save_feedback",
		],
		customTools: [
			{
				name: "read",
				label: "读取研究 Skill",
				description: "仅用于读取 PaperPulse 项目 .pi/skills 目录内的工作流文件。",
				parameters: Type.Object({ path: Type.String({ description: "Skill 文件的绝对路径" }) }),
				execute: async (_id, args) => {
					if (!args || typeof args !== "object" || !("path" in args) || typeof args.path !== "string")
						throw new Error("path must be a string");
					const path = resolve(args.path);
					if (path !== skillsDir && !path.startsWith(`${skillsDir}${sep}`))
						throw new Error("只能读取项目 Skill 目录");
					const content = await readFile(path, "utf8");
					return { content: [{ type: "text" as const, text: content }], details: { path } };
				},
			},
			{
				name: "recall_research_memory",
				label: "召回研究记忆",
				description: "开始论文检索前必须调用。召回与当前问题相关的历史研究、长期偏好以及已收藏、跳过和已读论文。",
				parameters: Type.Object({
					query: Type.String({ minLength: 1, maxLength: 500, description: "用户当前的原始研究问题" }),
					limit: Type.Optional(Type.Number({ minimum: 1, maximum: 12 })),
				}),
				execute: async (_id, args) => {
					if (!args || typeof args !== "object" || !("query" in args) || typeof args.query !== "string")
						throw new Error("query must be a string");
					const result = await options.mcp.call<MemoryRecallResult>("recall_research_memory", {
						query: args.query,
						limit: "limit" in args && typeof args.limit === "number" ? args.limit : 8,
						userId: options.userId,
					});
					memoryRecalled = true;
					options.trace.recordMemoryRecall(result.stats.returned);
					options.send({ type: "memory-recall", recalled: result.stats.returned, total: result.stats.total });
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
				},
			},
			{
				name: "save_research_memory",
				label: "保存研究记忆",
				description:
					"仅当用户明确表达长期研究偏好、兴趣、约束或要求记住的信息时调用。不得把模型自行推断的临时结论当成长期偏好。",
				parameters: Type.Object({
					memoryType: Type.Union([
						Type.Literal("preference"),
						Type.Literal("interest"),
						Type.Literal("constraint"),
						Type.Literal("note"),
					]),
					content: Type.String({ minLength: 1, maxLength: 1000 }),
					tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 })),
					confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				}),
				execute: async (_id, args) => {
					if (!args || typeof args !== "object" || !("content" in args) || typeof args.content !== "string")
						throw new Error("content must be a string");
					const memoryType =
						"memoryType" in args && typeof args.memoryType === "string" ? args.memoryType : "note";
					const result = await options.mcp.call<{ saved: boolean }>("save_research_memory", {
						userId: options.userId,
						memoryType,
						content: args.content,
						tags:
							"tags" in args && Array.isArray(args.tags)
								? args.tags.filter((value): value is string => typeof value === "string")
								: [],
						confidence: "confidence" in args && typeof args.confidence === "number" ? args.confidence : 1,
					});
					options.trace.recordMemoryWrite(result.saved ? 1 : 0);
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
				},
			},
			{
				name: "forget_research_memory",
				label: "遗忘研究记忆",
				description: "仅在用户明确要求忘记某条记忆或清空全部研究记忆时调用。",
				parameters: Type.Object({
					memoryId: Type.Optional(Type.String({ minLength: 1 })),
					clearAll: Type.Optional(Type.Boolean()),
				}),
				execute: async (_id, args) => {
					const memoryId =
						args && typeof args === "object" && "memoryId" in args && typeof args.memoryId === "string"
							? args.memoryId
							: undefined;
					const clearAll = Boolean(
						args && typeof args === "object" && "clearAll" in args && args.clearAll === true,
					);
					if (!memoryId && !clearAll) throw new Error("需要提供 memoryId 或 clearAll=true");
					const result = await options.mcp.call<{ deleted: number }>("forget_research_memory", {
						userId: options.userId,
						memoryId,
						clearAll,
					});
					options.trace.recordMemoryForget(result.deleted);
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
				},
			},
			{
				name: "search_ccf_papers",
				label: "搜索最新 CCF 论文",
				description:
					"先从用户问题提取英文核心概念和同义扩展词，再按日期搜索最新计算机论文，并通过 SQLite 中的 CCF 2026 A/B/C 目录严格过滤，尽量补足目标数量。",
				parameters: Type.Object({
					question: Type.String({ minLength: 1, description: "用户的原始研究问题" }),
					coreConcepts: Type.Array(Type.String({ minLength: 2 }), {
						minItems: 1,
						maxItems: 4,
						description: "必须共同出现的 1–4 个英文核心概念",
					}),
					expansionTerms: Type.Array(Type.String({ minLength: 2 }), {
						minItems: 2,
						maxItems: 8,
						description: "用于扩大召回的 2–8 个英文同义词、缩写或方法词",
					}),
					limit: Type.Optional(Type.Number({ minimum: 10, maximum: 20 })),
					live: Type.Optional(Type.Boolean()),
				}),
				execute: async (_id, args, signal, onUpdate) => {
					if (!args || typeof args !== "object" || !("question" in args) || typeof args.question !== "string")
						throw new Error("question must be a string");
					const coreConcepts =
						"coreConcepts" in args && Array.isArray(args.coreConcepts)
							? args.coreConcepts.filter((value): value is string => typeof value === "string")
							: [];
					const expansionTerms =
						"expansionTerms" in args && Array.isArray(args.expansionTerms)
							? args.expansionTerms.filter((value): value is string => typeof value === "string")
							: [];
					if (!memoryRecalled) throw new Error("检索前必须先调用 recall_research_memory");
					if (!coreConcepts.length || expansionTerms.length < 2) throw new Error("检索关键词不完整");
					const limit = "limit" in args && typeof args.limit === "number" ? args.limit : 15;
					const live = "live" in args && args.live === true;
					options.send({ type: "search-plan", coreConcepts, expansionTerms });
					onUpdate?.({ content: [{ type: "text", text: "正在通过 MCP 检索并匹配 CCF 2026 目录…" }], details: {} });
					if (signal?.aborted) throw new Error("检索已取消");
					const data = await options.mcp.call<SearchResult>("search_ccf_papers", {
						query: args.question,
						coreConcepts,
						expansionTerms,
						limit,
						userId: options.userId,
						sources: live ? ["google-scholar"] : ["demo"],
					});
					options.trace.recordSearch(data);
					for (const paper of data.papers) searchedPaperIds.add(paper.id);
					options.send({
						type: "papers",
						papers: data.papers,
						sourceStatus: data.sourceStatus,
						policy: data.policy,
					});
					return {
						content: [{ type: "text", text: JSON.stringify(data) }],
						details: data,
					};
				},
			},
			{
				name: "submit_paper_summaries",
				label: "提交中文摘要归纳",
				description:
					"搜索完成后、输出最终报告前必须调用。为每篇检索结果提交一条基于现有摘要或 Scholar 片段的中文归纳，不能添加证据中不存在的方法、结论或实验数据。",
				parameters: Type.Object({
					summaries: Type.Array(
						Type.Object({
							paperId: Type.String({ minLength: 1 }),
							summaryZh: Type.String({ minLength: 8, maxLength: 300 }),
							evidence: Type.Union([
								Type.Literal("abstract"),
								Type.Literal("scholar-snippet"),
								Type.Literal("metadata"),
								Type.Literal("demo"),
							]),
						}),
						{ minItems: 1, maxItems: 20 },
					),
				}),
				execute: async (_id, args) => {
					if (!args || typeof args !== "object" || !("summaries" in args) || !Array.isArray(args.summaries))
						throw new Error("summaries must be an array");
					const summaries: PaperSummary[] = [];
					for (const item of args.summaries) {
						if (!item || typeof item !== "object") continue;
						const paperId = "paperId" in item && typeof item.paperId === "string" ? item.paperId : "";
						const summaryZh =
							"summaryZh" in item && typeof item.summaryZh === "string" ? item.summaryZh.trim() : "";
						const evidence = "evidence" in item && typeof item.evidence === "string" ? item.evidence : "";
						if (!searchedPaperIds.has(paperId)) throw new Error(`论文不属于本次检索：${paperId}`);
						if (!/[\u3400-\u9fff]/u.test(summaryZh)) throw new Error(`中文归纳缺少中文内容：${paperId}`);
						if (!["abstract", "scholar-snippet", "metadata", "demo"].includes(evidence))
							throw new Error(`证据类型无效：${paperId}`);
						summaries.push({ paperId, summaryZh, evidence: evidence as PaperSummary["evidence"] });
					}
					options.send({ type: "paper-summaries", summaries });
					return {
						content: [{ type: "text", text: JSON.stringify({ accepted: summaries.length }) }],
						details: { summaries },
					};
				},
			},
			{
				name: "save_feedback",
				label: "保存反馈",
				description: "保存用户对某篇论文的收藏、跳过、阅读或偏好反馈。",
				parameters: Type.Object({
					paperId: Type.String(),
					action: Type.Union([
						Type.Literal("save"),
						Type.Literal("skip"),
						Type.Literal("read"),
						Type.Literal("like"),
						Type.Literal("dislike"),
					]),
				}),
				execute: async (_id, args) => {
					if (!args || typeof args !== "object" || !("paperId" in args) || typeof args.paperId !== "string")
						throw new Error("paperId must be a string");
					const action = "action" in args && typeof args.action === "string" ? args.action : "";
					if (!["save", "skip", "read", "like", "dislike"].includes(action)) throw new Error("invalid action");
					const data = await options.mcp.call<{ saved: boolean }>("save_feedback", {
						paperId: args.paperId,
						action,
						userId: options.userId,
					});
					return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
				},
			},
		],
	});
	const session = result.session;
	options.onSession?.(session);
	let modelSpanId: string | undefined;
	const toolSpanIds = new Map<string, string>();
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			modelSpanId = options.trace.startSpan("model.generate", "model");
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			options.send({ type: "text", text: event.assistantMessageEvent.delta });
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			options.trace.recordModel(event.message);
			if (modelSpanId) {
				options.trace.finishSpan(modelSpanId, event.message.stopReason === "error" ? "error" : "ok", {
					provider: event.message.provider,
					model: event.message.model,
					tokens: event.message.usage.totalTokens,
					costUsd: event.message.usage.cost.total,
				});
				modelSpanId = undefined;
			}
		}
		if (event.type === "tool_execution_start") {
			options.trace.recordMcpCall();
			const spanName =
				event.toolName === "recall_research_memory"
					? "memory.recall"
					: event.toolName === "save_research_memory"
						? "memory.write"
						: event.toolName === "forget_research_memory"
							? "memory.forget"
							: `tool.${event.toolName}`;
			toolSpanIds.set(event.toolCallId, options.trace.startSpan(spanName, "mcp", { toolName: event.toolName }));
			options.send({ type: "status", text: `执行工具：${event.toolName}` });
		}
		if (event.type === "tool_execution_end") {
			const spanId = toolSpanIds.get(event.toolCallId);
			if (spanId) options.trace.finishSpan(spanId, event.isError ? "error" : "ok");
			toolSpanIds.delete(event.toolCallId);
		}
	});
	try {
		await session.prompt(options.prompt);
	} finally {
		unsubscribe();
		session.dispose();
	}
}
