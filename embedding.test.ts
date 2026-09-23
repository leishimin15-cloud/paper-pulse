import assert from "node:assert/strict";
import { test } from "node:test";
import { PaperDatabase } from "./database.ts";
import { chunkPaperText } from "./embedding.ts";

test("chunks long abstracts with overlap", () => {
	const words = Array.from({ length: 250 }, (_, index) => `word${index}`);
	const chunks = chunkPaperText("A Long Paper", words.join(" "), 120, 24);
	assert.equal(chunks.length, 3);
	assert.match(chunks[1]?.content ?? "", /word96/u);
	assert.match(chunks[1]?.content ?? "", /word119/u);
});

test("persists dense vectors and retrieves chunks by cosine similarity", () => {
	const database = new PaperDatabase(":memory:");
	try {
		const relevant = database.upsertPaper({
			title: "Hierarchical Memory for Language Agents",
			authors: ["Ada Example"],
			abstract: "A layered long-term memory architecture for autonomous language agents.",
			sourceType: "demo",
		});
		const unrelated = database.upsertPaper({
			title: "Serializable Database Transactions",
			authors: ["Grace Example"],
			abstract: "A concurrency control protocol for distributed databases.",
			sourceType: "demo",
		});
		const relevantChunk = database.indexPaperChunks(
			relevant.id,
			chunkPaperText(relevant.title, relevant.abstract),
		)[0];
		const unrelatedChunk = database.indexPaperChunks(
			unrelated.id,
			chunkPaperText(unrelated.title, unrelated.abstract),
		)[0];
		assert.ok(relevantChunk);
		assert.ok(unrelatedChunk);
		database.saveChunkEmbedding(relevantChunk.id, "fixture-model", [1, 0, 0]);
		database.saveChunkEmbedding(unrelatedChunk.id, "fixture-model", [0, 1, 0]);
		const hits = database.searchChunkEmbeddings([0.9, 0.1, 0], "fixture-model", 2, ["demo"]);
		assert.equal(hits[0]?.paper.id, relevant.id);
		assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
		assert.equal(database.stats().chunks, 2);
		assert.equal(database.stats().embeddings, 2);
	} finally {
		database.close();
	}
});
