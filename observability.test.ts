import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { RunTraceRecorder, readRecentRuns } from "./observability.ts";

test("records a run with model usage, cost, API calls, and spans", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "paper-pulse-trace-"));
	const tracePath = resolve(directory, "traces.jsonl");
	try {
		const trace = new RunTraceRecorder(tracePath, "Agent memory", "pi", 0.01);
		const spanId = trace.startSpan("tool.search_ccf_papers", "mcp");
		trace.recordMcpCall();
		trace.recordMemoryRecall(3);
		trace.recordMemoryWrite(1);
		trace.recordModel({
			provider: "kimi",
			model: "kimi-k3",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 10,
				cacheWrite: 0,
				totalTokens: 130,
				cost: { total: 0.02 },
			},
		});
		trace.recordSearch({
			papers: [],
			contexts: [],
			sourceStatus: {},
			policy: {
				version: "CCF-2026-7",
				domain: "人工智能",
				acceptedRanks: ["A", "B", "C"],
				candidateCount: 12,
				excludedCount: 4,
				searchQuery: "agent memory",
				telemetry: {
					scholarApiCalls: 2,
					scholarDurationMs: 300,
					embeddingModel: "test-embedding",
					embeddedChunks: 5,
					retrievedChunks: 3,
					vectorDurationMs: 40,
					memorySignals: 2,
					memoryReranked: 1,
				},
			},
		});
		trace.finishSpan(spanId, "ok");
		const summary = await trace.finish("ok");
		assert.equal(summary.calls.model, 1);
		assert.equal(summary.calls.mcp, 1);
		assert.equal(summary.calls.scholar, 2);
		assert.equal(summary.tokens.total, 130);
		assert.equal(summary.cost.totalUsd, 0.04);
		assert.equal(summary.memory.recalledItems, 3);
		assert.equal(summary.memory.savedItems, 1);
		assert.equal(summary.retrieval.retrievedChunks, 3);
		assert.equal(summary.retrieval.embeddingModel, "test-embedding");
		assert.equal(summary.spans[0]?.status, "ok");
		assert.equal((await readRecentRuns(tracePath, 1))[0]?.runId, summary.runId);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
