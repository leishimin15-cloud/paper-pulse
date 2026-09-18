import assert from "node:assert/strict";
import { test } from "node:test";
import { inferCcfDomain, loadCcfDirectory, matchCcfVenue } from "./ccf.ts";

test("loads the complete CCF 2026 directory extracted from the PDF", () => {
	const directory = loadCcfDirectory();
	assert.equal(directory.source.version, "CCF-2026-7");
	assert.equal(directory.source.entryCount, 681);
	assert.equal(directory.venues.length, 681);
	assert.equal(directory.venues.filter((venue) => venue.rank === "A").length, 95);
});

test("infers a computer-science subdomain from a natural-language question", () => {
	assert.equal(inferCcfDomain("大语言模型 Agent 的长期记忆与检索增强"), "人工智能");
	assert.equal(inferCcfDomain("软件供应链安全与攻击检测"), "网络与信息安全");
});

test("matches CCF venues by abbreviation or exact full name", () => {
	const venues = loadCcfDirectory().venues.filter((venue) => venue.domain === "人工智能");
	assert.equal(matchCcfVenue("NeurIPS, 2026", venues)?.venue.abbreviation, "NeurIPS");
	assert.equal(matchCcfVenue("Journal of Machine Learning Research, 2026", venues)?.venue.abbreviation, "JMLR");
});

test("does not mistake a similarly named subjournal for a CCF venue", () => {
	const venues = loadCcfDirectory().venues.filter((venue) => venue.domain === "人工智能");
	assert.equal(matchCcfVenue("Discover Artificial Intelligence, 2026", venues), undefined);
});
