import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PaperMcpClient } from "./mcp-client.ts";
import type { SearchResult } from "./types.ts";

const root = dirname(fileURLToPath(import.meta.url));

test("connects Pi bridge to the MCP server and calls paper tools", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "paper-pulse-"));
	const client = await PaperMcpClient.connect(root, resolve(directory, "papers.db"));
	try {
		const tools = await client.listTools();
		assert.ok(tools.includes("search_ccf_papers"));
		assert.ok(tools.includes("verify_ccf_venue"));
		assert.ok(tools.includes("save_feedback"));
		assert.ok(tools.includes("recall_research_memory"));
		assert.ok(tools.includes("save_research_memory"));
		assert.ok(tools.includes("forget_research_memory"));
		const saved = await client.call<{ memory: { id: string } }>("save_research_memory", {
			memoryType: "interest",
			content: "关注 Agent 的分层长期记忆",
			tags: ["agent memory", "hierarchical memory"],
		});
		const recalled = await client.call<{ items: Array<{ id: string }> }>("recall_research_memory", {
			query: "hierarchical agent memory",
		});
		assert.ok(recalled.items.some((item) => item.id === saved.memory.id));
		const result = await client.call<SearchResult>("search_ccf_papers", {
			query: "Agent Memory",
			coreConcepts: ["large language model agent", "long-term memory"],
			expansionTerms: ["episodic memory", "memory architecture"],
			limit: 15,
			sources: ["demo"],
		});
		assert.ok(result.papers.length > 0);
		assert.match(result.sourceStatus.local, /^[1-9]\d* 篇进入归纳上下文$/u);
		assert.ok(result.contexts.length > 0);
		assert.match(result.policy.telemetry.embeddingModel, /^transformers-js:/u);
		assert.match(result.sourceStatus.vector, /召回 \d+ 个文献块/u);
		assert.ok(result.contexts.some((context) => context.score !== 0));
		assert.equal(result.papers[0]?.ccf?.rank, "A");
		assert.equal(result.policy.version, "CCF-2026-7");
		assert.match(result.policy.searchQuery, /"large language model agent"/u);
		assert.match(result.policy.searchQuery, /"episodic memory" OR "memory architecture"/u);
	} finally {
		await client.close();
		await rm(directory, { recursive: true, force: true });
	}
});
