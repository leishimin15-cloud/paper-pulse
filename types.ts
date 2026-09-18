export const sourceTypes = ["google-scholar", "demo"] as const;
export const ccfRanks = ["A", "B", "C"] as const;
export const ccfVenueTypes = ["journal", "conference"] as const;
export const memoryTypes = ["preference", "interest", "constraint", "note", "research-history"] as const;
export const ccfDomains = [
	"计算机体系结构/并行与分布计算/存储系统",
	"计算机网络",
	"网络与信息安全",
	"软件工程/系统软件/程序设计语言",
	"数据库/数据挖掘/内容检索",
	"计算机科学理论",
	"计算机图形学与多媒体",
	"人工智能",
	"人机交互与普适计算",
	"交叉/综合/新兴",
] as const;

export type SourceType = (typeof sourceTypes)[number];
export type CcfRank = (typeof ccfRanks)[number];
export type CcfVenueType = (typeof ccfVenueTypes)[number];
export type CcfDomain = (typeof ccfDomains)[number];
export type MemoryType = (typeof memoryTypes)[number];

export interface CcfDirectorySource {
	title: string;
	version: string;
	officialUrl: string;
	sha256: string;
	entryCount: number;
}

export interface CcfVenue {
	id: string;
	domain: CcfDomain;
	type: CcfVenueType;
	rank: CcfRank;
	abbreviation?: string;
	fullName: string;
	publisher?: string;
	dblpUrl?: string;
	aliases: string[];
	page: number;
}

export interface CcfMatch {
	venueId: string;
	rank: CcfRank;
	domain: CcfDomain;
	venueType: CcfVenueType;
	matchedBy: "abbreviation" | "full-name" | "alias";
}

export interface PaperInput {
	title: string;
	authors: string[];
	abstract?: string;
	doi?: string;
	arxivId?: string;
	publishedAt?: string;
	language?: string;
	venue?: string;
	ccf?: CcfMatch;
	sourceType: SourceType;
	sourceRecordId?: string;
	sourceUrl?: string;
	accessLevel?: "metadata" | "abstract";
}

export interface Paper extends PaperInput {
	id: string;
	fingerprint: string;
	createdAt: string;
	updatedAt: string;
}

export interface SearchOptions {
	query: string;
	limit: number;
	sources: SourceType[];
	userId?: string;
	domain?: CcfDomain;
	coreConcepts?: string[];
	expansionTerms?: string[];
}

export interface SearchResult {
	papers: Paper[];
	sourceStatus: Record<string, string>;
	policy: {
		version: string;
		domain: CcfDomain;
		acceptedRanks: readonly ["A", "B", "C"];
		candidateCount: number;
		excludedCount: number;
		searchQuery: string;
		telemetry: {
			scholarApiCalls: number;
			scholarDurationMs: number;
			memorySignals: number;
			memoryReranked: number;
		};
	};
}

export interface MemoryItem {
	id: string;
	userId: string;
	memoryType: MemoryType;
	content: string;
	tags: string[];
	sourceRunId?: string;
	confidence: number;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	relevanceScore?: number;
}

export interface MemoryFeedback {
	paperId: string;
	title: string;
	action: "save" | "skip" | "read" | "like" | "dislike";
	createdAt: string;
}

export interface MemoryRecallResult {
	userId: string;
	query: string;
	items: MemoryItem[];
	feedback: {
		positive: MemoryFeedback[];
		negative: MemoryFeedback[];
		read: MemoryFeedback[];
	};
	stats: { total: number; scanned: number; returned: number };
	telemetry: { durationMs: number };
}
