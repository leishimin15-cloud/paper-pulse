import assert from "node:assert/strict";
import { test } from "node:test";
import { PaperDatabase } from "./database.ts";

test("deduplicates papers by normalized DOI", () => {
	const database = new PaperDatabase(":memory:");
	try {
		const first = database.upsertPaper({
			title: "A Paper About Research Agents",
			authors: ["Ada Example"],
			doi: "https://doi.org/10.1000/Example",
			sourceType: "google-scholar",
		});
		const second = database.upsertPaper({
			title: "A Paper About Research Agents",
			authors: ["Ada Example"],
			doi: "10.1000/example",
			abstract: "Updated abstract",
			sourceType: "demo",
		});
		assert.equal(first.id, second.id);
		assert.equal(database.stats().papers, 1);
		assert.equal(database.getPaper(first.id)?.abstract, "Updated abstract");
	} finally {
		database.close();
	}
});

test("imports the CCF PDF directory into SQLite and verifies a venue", () => {
	const database = new PaperDatabase(":memory:");
	try {
		assert.equal(database.stats().ccfVenues, 681);
		const match = database.matchCcfVenue("NeurIPS, 2026", "人工智能");
		assert.equal(match?.venue.rank, "A");
		assert.equal(match?.venue.abbreviation, "NeurIPS");
		const cMatch = database.matchCcfVenue(
			"ACM Journal on Emerging Technologies in Computing Systems, 2026",
			"计算机体系结构/并行与分布计算/存储系统",
		);
		assert.equal(cMatch?.venue.rank, "C");
		assert.equal(cMatch?.venue.abbreviation, "JETC");
	} finally {
		database.close();
	}
});

test("keeps demo and Google Scholar sources isolated in local search", () => {
	const database = new PaperDatabase(":memory:");
	try {
		database.upsertPaper({
			title: "Demo Agent Memory",
			authors: ["Demo Author"],
			abstract: "long-term agent memory",
			sourceType: "demo",
		});
		database.upsertPaper({
			title: "Live Agent Memory",
			authors: ["Live Author"],
			abstract: "long-term agent memory",
			sourceType: "google-scholar",
		});
		assert.deepEqual(
			database.searchPapers("agent memory", 20, ["demo"]).map((paper) => paper.title),
			["Demo Agent Memory"],
		);
		assert.deepEqual(
			database.searchPapers("agent memory", 20, ["google-scholar"]).map((paper) => paper.title),
			["Live Agent Memory"],
		);
	} finally {
		database.close();
	}
});

test("recalls research memory and reranks papers from feedback", () => {
	const database = new PaperDatabase(":memory:");
	try {
		const memory = database.saveMemory({
			memoryType: "interest",
			content: "关注 Agent 的分层长期记忆",
			tags: ["agent memory", "hierarchical memory"],
		});
		const recalled = database.recallMemory("hierarchical agent memory");
		assert.equal(recalled.items[0]?.id, memory.id);

		const liked = database.upsertPaper({
			title: "Hierarchical Memory for Agents",
			authors: ["Ada Example"],
			sourceType: "demo",
		});
		const skipped = database.upsertPaper({
			title: "Graph Memory for Agents",
			authors: ["Grace Example"],
			sourceType: "demo",
		});
		database.saveFeedback(liked.id, "like");
		database.saveFeedback(skipped.id, "skip");
		const ranked = database.rankPapersByMemory([skipped, liked]);
		assert.equal(ranked.papers[0]?.id, liked.id);
		assert.ok(ranked.rerankedCount > 0);
		assert.equal(database.forgetMemory({ clearAll: true }), 3);
		assert.equal(database.recallMemory("").stats.total, 0);
	} finally {
		database.close();
	}
});
