import { readFileSync } from "node:fs";
import {
	type CcfDirectorySource,
	type CcfDomain,
	type CcfMatch,
	type CcfRank,
	type CcfVenue,
	ccfDomains,
} from "./types.ts";

interface CcfDirectory {
	source: CcfDirectorySource;
	venues: CcfVenue[];
}

const directory = JSON.parse(readFileSync(new URL("./ccf-2026.json", import.meta.url), "utf8")) as CcfDirectory;

const domainKeywords: Record<CcfDomain, readonly string[]> = {
	"计算机体系结构/并行与分布计算/存储系统": [
		"architecture",
		"distributed",
		"parallel",
		"storage",
		"database system",
		"体系结构",
		"分布式",
		"并行计算",
		"存储",
	],
	计算机网络: ["network", "wireless", "routing", "5g", "6g", "网络", "无线", "路由"],
	网络与信息安全: ["security", "privacy", "cryptography", "attack", "安全", "隐私", "密码", "攻击"],
	"软件工程/系统软件/程序设计语言": [
		"software engineering",
		"programming language",
		"compiler",
		"operating system",
		"软件工程",
		"程序语言",
		"编译器",
		"操作系统",
	],
	"数据库/数据挖掘/内容检索": [
		"database",
		"data mining",
		"information retrieval",
		"recommendation",
		"数据库",
		"数据挖掘",
		"信息检索",
		"推荐系统",
	],
	计算机科学理论: ["theory", "algorithm", "complexity", "logic", "理论", "算法", "复杂性", "逻辑"],
	计算机图形学与多媒体: ["graphics", "multimedia", "rendering", "vision", "图形学", "多媒体", "渲染", "三维"],
	人工智能: [
		"artificial intelligence",
		"machine learning",
		"deep learning",
		"language model",
		"agent",
		"computer vision",
		"人工智能",
		"机器学习",
		"深度学习",
		"大模型",
		"智能体",
		"视觉",
	],
	人机交互与普适计算: ["human computer", "hci", "ubiquitous", "interaction", "人机交互", "普适计算", "交互"],
	"交叉/综合/新兴": ["bioinformatics", "quantum", "web", "interdisciplinary", "生物信息", "量子", "交叉"],
};

export function loadCcfDirectory(): CcfDirectory {
	return directory;
}

export function isCcfDomain(value: string): value is CcfDomain {
	return ccfDomains.includes(value as CcfDomain);
}

export function inferCcfDomain(query: string): CcfDomain {
	const normalized = query.toLowerCase().normalize("NFKC");
	let selected: CcfDomain = "人工智能";
	let bestScore = 0;
	for (const domain of ccfDomains) {
		const score = domainKeywords[domain].reduce(
			(total, keyword) => total + (normalized.includes(keyword.toLowerCase()) ? keyword.length : 0),
			0,
		);
		if (score > bestScore) {
			selected = domain;
			bestScore = score;
		}
	}
	return selected;
}

export function normalizeVenue(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKC")
		.replace(/&/gu, " and ")
		.replace(/\b(?:19|20)\d{2}\b/gu, " ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/gu, " ");
}

function compact(value: string): string {
	return normalizeVenue(value).replaceAll(" ", "");
}

export function matchCcfVenue(
	publication: string | undefined,
	venues: readonly CcfVenue[],
	acceptedRanks: readonly CcfRank[] = ["A", "B", "C"],
): { venue: CcfVenue; match: CcfMatch } | undefined {
	if (!publication) return undefined;
	const publicationValues = [publication, ...publication.split(" - ")]
		.map((value) =>
			normalizeVenue(value)
				.replace(/^proceedings (?:of )?(?:the )?/u, "")
				.replace(/\b(?:vol|volume|no|issue)\b.*$/u, "")
				.trim(),
		)
		.filter(Boolean);
	let best: { venue: CcfVenue; match: CcfMatch; score: number } | undefined;
	for (const venue of venues) {
		if (!acceptedRanks.includes(venue.rank)) continue;
		const candidates: Array<{ value: string; matchedBy: CcfMatch["matchedBy"]; score: number }> = [
			{ value: venue.fullName, matchedBy: "full-name", score: 100 },
			...venue.aliases.map((value) => ({ value, matchedBy: "alias" as const, score: 80 })),
		];
		const nameWords = venue.fullName.split(/\s+/u);
		if (nameWords.length > 4) candidates.push({ value: nameWords.slice(1).join(" "), matchedBy: "alias", score: 70 });
		if (venue.abbreviation) candidates.push({ value: venue.abbreviation, matchedBy: "abbreviation", score: 90 });
		for (const candidate of candidates) {
			const normalizedCandidate = normalizeVenue(candidate.value);
			const compactCandidate = compact(candidate.value);
			if (!compactCandidate) continue;
			const abbreviationMatch =
				candidate.matchedBy === "abbreviation" &&
				compactCandidate.length >= 3 &&
				publicationValues.some((value) =>
					new RegExp(
						`(?:^|[^\\p{L}\\p{N}])${normalizedCandidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^\\p{L}\\p{N}])`,
						"iu",
					).test(value),
				);
			const nameMatch =
				candidate.matchedBy !== "abbreviation" &&
				compactCandidate.length >= 12 &&
				publicationValues.some((value) => compact(value) === compactCandidate);
			if (!abbreviationMatch && !nameMatch) continue;
			const rankBonus = venue.rank === "A" ? 5 : venue.rank === "B" ? 2 : 0;
			const score = candidate.score + rankBonus + Math.min(compactCandidate.length / 100, 5);
			if (!best || score > best.score) {
				best = {
					venue,
					match: {
						venueId: venue.id,
						rank: venue.rank,
						domain: venue.domain,
						venueType: venue.type,
						matchedBy: candidate.matchedBy,
					},
					score,
				};
			}
		}
	}
	return best ? { venue: best.venue, match: best.match } : undefined;
}
