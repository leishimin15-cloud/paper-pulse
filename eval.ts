import { inferCcfDomain, loadCcfDirectory, matchCcfVenue } from "./ccf.ts";
import { PaperDatabase } from "./database.ts";
import { scholarTopicQuery } from "./sources.ts";
import type { CcfDomain, CcfRank, SearchOptions } from "./types.ts";

interface DomainCase {
	id: string;
	query: string;
	expectedDomain: CcfDomain;
}

interface VenueCase {
	id: string;
	publication: string;
	domain: CcfDomain;
	expectedMatch: boolean;
	expectedRank?: CcfRank;
}

interface QueryCase {
	id: string;
	options: SearchOptions;
	expectedTerms: string[];
}

const domainCases: DomainCase[] = [
	{
		id: "domain-architecture",
		query: "分布式存储系统的并行计算架构",
		expectedDomain: "计算机体系结构/并行与分布计算/存储系统",
	},
	{ id: "domain-network", query: "6G 无线网络路由优化", expectedDomain: "计算机网络" },
	{ id: "domain-security", query: "软件供应链攻击与隐私安全检测", expectedDomain: "网络与信息安全" },
	{ id: "domain-software", query: "编译器与程序语言的自动测试", expectedDomain: "软件工程/系统软件/程序设计语言" },
	{ id: "domain-database", query: "数据库信息检索与推荐系统", expectedDomain: "数据库/数据挖掘/内容检索" },
	{ id: "domain-theory", query: "算法复杂性与计算逻辑理论", expectedDomain: "计算机科学理论" },
	{ id: "domain-graphics", query: "三维图形学渲染和多媒体生成", expectedDomain: "计算机图形学与多媒体" },
	{ id: "domain-ai", query: "大语言模型 Agent 的长期记忆", expectedDomain: "人工智能" },
	{ id: "domain-hci", query: "人机交互与普适计算的新型交互方式", expectedDomain: "人机交互与普适计算" },
	{ id: "domain-emerging", query: "量子计算与生物信息交叉研究", expectedDomain: "交叉/综合/新兴" },
];

const venueCases: VenueCase[] = [
	{
		id: "venue-tocs",
		publication: "ACM Transactions on Computer Systems, 2026",
		domain: "计算机体系结构/并行与分布计算/存储系统",
		expectedMatch: true,
		expectedRank: "A",
	},
	{ id: "venue-jsac", publication: "JSAC, 2026", domain: "计算机网络", expectedMatch: true, expectedRank: "A" },
	{
		id: "venue-tdsc",
		publication: "IEEE Transactions on Dependable and Secure Computing",
		domain: "网络与信息安全",
		expectedMatch: true,
		expectedRank: "A",
	},
	{
		id: "venue-toplas",
		publication: "TOPLAS, 2026",
		domain: "软件工程/系统软件/程序设计语言",
		expectedMatch: true,
		expectedRank: "A",
	},
	{
		id: "venue-tods",
		publication: "ACM Transactions on Database Systems",
		domain: "数据库/数据挖掘/内容检索",
		expectedMatch: true,
		expectedRank: "A",
	},
	{
		id: "venue-tit",
		publication: "IEEE Transactions on Information Theory",
		domain: "计算机科学理论",
		expectedMatch: true,
		expectedRank: "A",
	},
	{
		id: "venue-tog",
		publication: "ACM Transactions on Graphics",
		domain: "计算机图形学与多媒体",
		expectedMatch: true,
		expectedRank: "A",
	},
	{ id: "venue-tpami", publication: "TPAMI, 2026", domain: "人工智能", expectedMatch: true, expectedRank: "A" },
	{
		id: "venue-tochi",
		publication: "ACM Transactions on Computer-Human Interaction",
		domain: "人机交互与普适计算",
		expectedMatch: true,
		expectedRank: "A",
	},
	{
		id: "venue-jacm",
		publication: "Journal of the ACM",
		domain: "交叉/综合/新兴",
		expectedMatch: true,
		expectedRank: "A",
	},
	{ id: "venue-near-name", publication: "Discover Artificial Intelligence", domain: "人工智能", expectedMatch: false },
	{
		id: "venue-unknown",
		publication: "International Journal of Imaginary Agents",
		domain: "人工智能",
		expectedMatch: false,
	},
];

const queryCases: QueryCase[] = [
	{
		id: "query-agent-memory",
		options: {
			query: "Agent memory",
			limit: 15,
			sources: ["demo"],
			coreConcepts: ["large language model agent", "long-term memory"],
			expansionTerms: ["episodic memory", "memory architecture"],
		},
		expectedTerms: [
			'"large language model agent"',
			'"long-term memory"',
			'"episodic memory" OR "memory architecture"',
		],
	},
	{
		id: "query-security",
		options: {
			query: "software supply chain security",
			limit: 15,
			sources: ["demo"],
			coreConcepts: ["software supply chain"],
			expansionTerms: ["dependency confusion", "malicious package"],
		},
		expectedTerms: ['"software supply chain"', '"dependency confusion" OR "malicious package"'],
	},
];

export interface OfflineEvalReport {
	generatedAt: string;
	fixtureVersion: string;
	passed: boolean;
	metrics: {
		domainAccuracy: number;
		venuePrecision: number;
		venueRecall: number;
		venueF1: number;
		queryPlanPassRate: number;
		memoryBehaviorPassRate: number;
	};
	counts: { domainCases: number; venueCases: number; queryCases: number; memoryCases: number };
	failures: Array<{ id: string; expected: string; actual: string }>;
	limitations: string[];
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

export function runOfflineEval(): OfflineEvalReport {
	const failures: OfflineEvalReport["failures"] = [];
	let domainCorrect = 0;
	for (const item of domainCases) {
		const actual = inferCcfDomain(item.query);
		if (actual === item.expectedDomain) domainCorrect++;
		else failures.push({ id: item.id, expected: item.expectedDomain, actual });
	}

	const venues = loadCcfDirectory().venues;
	let truePositive = 0;
	let falsePositive = 0;
	let falseNegative = 0;
	for (const item of venueCases) {
		const actual = matchCcfVenue(
			item.publication,
			venues.filter((venue) => venue.domain === item.domain),
		);
		const correctRank = !item.expectedRank || actual?.venue.rank === item.expectedRank;
		if (item.expectedMatch && actual && correctRank) truePositive++;
		else if (!item.expectedMatch && actual) falsePositive++;
		else if (item.expectedMatch) falseNegative++;
		if (Boolean(actual) !== item.expectedMatch || !correctRank) {
			failures.push({
				id: item.id,
				expected: item.expectedMatch ? `match:${item.expectedRank ?? "any"}` : "no-match",
				actual: actual ? `match:${actual.venue.rank}` : "no-match",
			});
		}
	}

	let queryCorrect = 0;
	for (const item of queryCases) {
		const actual = scholarTopicQuery(item.options);
		if (item.expectedTerms.every((term) => actual.includes(term))) queryCorrect++;
		else failures.push({ id: item.id, expected: item.expectedTerms.join(" + "), actual });
	}

	let memoryCorrect = 0;
	const memoryCaseCount = 2;
	const memoryDatabase = new PaperDatabase(":memory:");
	try {
		const saved = memoryDatabase.saveMemory({
			memoryType: "interest",
			content: "关注大语言模型 Agent 的分层长期记忆方法",
			tags: ["LLM agent", "hierarchical memory", "long-term memory"],
		});
		const recalled = memoryDatabase.recallMemory("LLM agent hierarchical long-term memory");
		if (recalled.items.some((item) => item.id === saved.id)) memoryCorrect++;
		else
			failures.push({
				id: "memory-recall",
				expected: saved.id,
				actual: recalled.items.map((item) => item.id).join(","),
			});

		const liked = memoryDatabase.upsertPaper({
			title: "Hierarchical Memory for Language Agents",
			authors: ["A Researcher"],
			abstract: "A hierarchical long-term memory architecture.",
			sourceType: "demo",
		});
		const skipped = memoryDatabase.upsertPaper({
			title: "Graph Memory for Language Agents",
			authors: ["B Researcher"],
			abstract: "A graph memory architecture.",
			sourceType: "demo",
		});
		memoryDatabase.saveFeedback(liked.id, "like");
		memoryDatabase.saveFeedback(skipped.id, "skip");
		const ranked = memoryDatabase.rankPapersByMemory([skipped, liked]);
		if (ranked.papers[0]?.id === liked.id) memoryCorrect++;
		else failures.push({ id: "memory-rerank", expected: liked.id, actual: ranked.papers[0]?.id ?? "none" });
	} finally {
		memoryDatabase.close();
	}

	const precision = ratio(truePositive, truePositive + falsePositive);
	const recall = ratio(truePositive, truePositive + falseNegative);
	const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
	const metrics = {
		domainAccuracy: ratio(domainCorrect, domainCases.length),
		venuePrecision: precision,
		venueRecall: recall,
		venueF1: f1,
		queryPlanPassRate: ratio(queryCorrect, queryCases.length),
		memoryBehaviorPassRate: ratio(memoryCorrect, memoryCaseCount),
	};
	return {
		generatedAt: new Date().toISOString(),
		fixtureVersion: "paper-pulse-eval-v1",
		passed: Object.values(metrics).every((metric) => metric >= 0.9),
		metrics,
		counts: {
			domainCases: domainCases.length,
			venueCases: venueCases.length,
			queryCases: queryCases.length,
			memoryCases: memoryCaseCount,
		},
		failures,
		limitations: [
			"离线 Fixture 只验证领域路由、CCF 来源匹配、检索式构造和确定性记忆行为。",
			"真实 Scholar 召回率、摘要相关性和最终归纳忠实度需要人工标注集或独立 Judge Eval。",
		],
	};
}
