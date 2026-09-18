import assert from "node:assert/strict";
import { test } from "node:test";
import { runOfflineEval } from "./eval.ts";

test("offline eval validates domain routing, CCF matching, and query construction", () => {
	const report = runOfflineEval();
	assert.equal(report.counts.domainCases, 10);
	assert.equal(report.counts.venueCases, 12);
	assert.equal(report.counts.queryCases, 2);
	assert.equal(report.counts.memoryCases, 2);
	assert.equal(report.passed, true, JSON.stringify(report.failures));
	assert.equal(report.metrics.venueF1, 1);
	assert.equal(report.metrics.memoryBehaviorPassRate, 1);
});
