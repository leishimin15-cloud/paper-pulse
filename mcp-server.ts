import { type JSONValue, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { isCcfDomain } from "./ccf.ts";
import { PaperDatabase } from "./database.ts";
import { PaperKnowledgeService } from "./service.ts";
import { isSourceType } from "./sources.ts";
import { memoryTypes } from "./types.ts";

function structured(value: unknown): JSONValue {
	return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function createPaperServer(): McpServer {
	const database = new PaperDatabase(process.env.PAPER_PULSE_DB ?? ":memory:");
	const service = new PaperKnowledgeService(database);
	service.seedDemo();
	const server = new McpServer(
		{ name: "paper-knowledge", version: "0.1.0" },
		{ capabilities: { tools: {}, resources: {} } },
	);

	server.registerTool(
		"list_library",
		{
			title: "List Paper Library",
			description: "List recently added papers and return lightweight library statistics.",
			inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(30) }),
		},
		({ limit }) => {
			const result = {
				papers: database.listPapers(limit),
				stats: database.stats(),
				ccfPolicy: database.ccfPolicy(),
			};
			return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: structured(result) };
		},
	);

	server.registerTool(
		"search_ccf_papers",
		{
			title: "Vector Search CCF Papers",
			description:
				"Search recent computer-science papers, chunk and embed abstracts, retrieve relevant context by vector similarity, then keep only sources matched against the local CCF 2026 A/B/C directory in SQLite.",
			inputSchema: z.object({
				query: z.string().min(1).max(500),
				coreConcepts: z.array(z.string().min(2)).max(4).default([]),
				expansionTerms: z.array(z.string().min(2)).max(8).default([]),
				limit: z.number().int().min(10).max(20).default(15),
				domain: z.string().optional(),
				sources: z.array(z.string()).default(["demo"]),
				userId: z.string().min(1).max(100).default("local-user"),
			}),
		},
		async ({ query, coreConcepts, expansionTerms, limit, domain, sources, userId }, context) => {
			const selected = sources.filter(isSourceType);
			const result = await service.search(
				{
					query,
					coreConcepts,
					expansionTerms,
					limit,
					userId,
					domain: domain && isCcfDomain(domain) ? domain : undefined,
					sources: selected.length ? selected : ["demo"],
				},
				context.mcpReq.signal,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: structured(result),
			};
		},
	);

	server.registerTool(
		"verify_ccf_venue",
		{
			title: "Verify CCF Venue",
			description: "Match a publication name or Scholar publication summary against the local CCF 2026 directory.",
			inputSchema: z.object({ publication: z.string().min(1).max(1000), domain: z.string().optional() }),
		},
		({ publication, domain }) => {
			const result = service.verifyCcfVenue(publication, domain && isCcfDomain(domain) ? domain : undefined) ?? {
				matched: false,
			};
			return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: structured(result) };
		},
	);

	server.registerTool(
		"save_feedback",
		{
			title: "Save Feedback",
			description: "Save a user's reaction to a recommended paper.",
			inputSchema: z.object({
				paperId: z.string().min(1),
				action: z.enum(["save", "skip", "read", "like", "dislike"]),
				userId: z.string().min(1).max(100).default("local-user"),
			}),
		},
		({ paperId, action, userId }) => {
			service.saveFeedback(paperId, action, userId);
			const result = { saved: true };
			return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: structured(result) };
		},
	);

	server.registerTool(
		"recall_research_memory",
		{
			title: "Recall Research Memory",
			description:
				"Recall relevant research preferences, prior queries, and paper feedback before planning a new literature search.",
			inputSchema: z.object({
				query: z.string().max(500).default(""),
				userId: z.string().min(1).max(100).default("local-user"),
				limit: z.number().int().min(1).max(20).default(8),
			}),
		},
		({ query, userId, limit }) => {
			const result = database.recallMemory(query, userId, limit);
			return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: structured(result) };
		},
	);

	server.registerTool(
		"save_research_memory",
		{
			title: "Save Research Memory",
			description:
				"Persist an explicit research preference, interest, constraint, note, or completed research query for future runs.",
			inputSchema: z.object({
				userId: z.string().min(1).max(100).default("local-user"),
				memoryType: z.enum(memoryTypes),
				content: z.string().min(1).max(2000),
				tags: z.array(z.string().min(1).max(100)).max(30).default([]),
				sourceRunId: z.string().max(100).optional(),
				confidence: z.number().min(0).max(1).default(1),
				metadata: z.record(z.string(), z.unknown()).default({}),
			}),
		},
		({ userId, memoryType, content, tags, sourceRunId, confidence, metadata }) => {
			const memory = database.saveMemory({
				userId,
				memoryType,
				content,
				tags,
				sourceRunId,
				confidence,
				metadata,
			});
			const result = { saved: true, memory };
			return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: structured(result) };
		},
	);

	server.registerTool(
		"forget_research_memory",
		{
			title: "Forget Research Memory",
			description: "Delete one research memory or clear all memories and feedback for the current user.",
			inputSchema: z.object({
				userId: z.string().min(1).max(100).default("local-user"),
				memoryId: z.string().min(1).optional(),
				clearAll: z.boolean().default(false),
			}),
		},
		({ userId, memoryId, clearAll }) => {
			const deleted = database.forgetMemory({ userId, memoryId, clearAll });
			const result = { deleted };
			return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: structured(result) };
		},
	);

	server.registerResource(
		"paper",
		new ResourceTemplate("paper://{paperId}", { list: undefined }),
		{ title: "Paper", description: "A normalized paper record", mimeType: "application/json" },
		(uri, variables) => {
			const paperId = Array.isArray(variables.paperId) ? variables.paperId[0] : variables.paperId;
			const paper = service.getPaper(paperId);
			return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(paper) }] };
		},
	);

	return server;
}

serveStdio(createPaperServer, {
	onerror: (error) => console.error("Paper MCP server error:", error),
});
