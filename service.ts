import { inferCcfDomain } from "./ccf.ts";
import type { PaperDatabase } from "./database.ts";
import { demoPapers, type ScholarCandidate, scholarTopicQuery, searchGoogleScholar } from "./sources.ts";
import type { CcfRank, Paper, SearchOptions, SearchResult } from "./types.ts";

function uniquePapers(papers: Paper[]): Paper[] {
	return [...new Map(papers.map((paper) => [paper.id, paper])).values()];
}

export class PaperKnowledgeService {
	readonly database: PaperDatabase;

	constructor(database: PaperDatabase) {
		this.database = database;
	}

	seedDemo(): void {
		for (const paper of demoPapers) this.database.upsertPaper(paper);
	}

	private acceptCandidates(
		candidates: ScholarCandidate[],
		domain: SearchResult["policy"]["domain"],
	): { accepted: Paper[]; rejectedCount: number } {
		const accepted: Paper[] = [];
		let rejectedCount = 0;
		for (const candidate of candidates) {
			const result = this.database.matchCcfVenue(candidate.venue ?? candidate.publicationSummary, domain);
			if (!result) {
				rejectedCount++;
				continue;
			}
			accepted.push(
				this.database.upsertPaper({
					...candidate,
					venue: result.venue.abbreviation || result.venue.fullName,
					ccf: result.match,
				}),
			);
		}
		return { accepted, rejectedCount };
	}

	async search(options: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
		const domain =
			options.domain ??
			inferCcfDomain([options.query, ...(options.coreConcepts ?? []), ...(options.expansionTerms ?? [])].join(" "));
		const status: Record<string, string> = {};
		const external: Paper[] = [];
		let candidateCount = 0;
		let rejectedCount = 0;
		let scholarApiCalls = 0;
		let scholarDurationMs = 0;
		const localSources = options.sources.filter((source) => source !== "google-scholar");
		const local = this.database
			.searchPapers(options.query, options.limit, localSources)
			.filter((paper) => paper.ccf && paper.ccf.domain === domain);
		status.local = `${local.length} 篇`;

		if (options.sources.includes("google-scholar")) {
			const searchRank = async (rank: CcfRank, sortByDate = true): Promise<void> => {
				const venues = this.database.listCcfVenues(domain, [rank]);
				const startedAt = Date.now();
				scholarApiCalls++;
				let candidates: ScholarCandidate[];
				try {
					candidates = await searchGoogleScholar(options, venues, signal, sortByDate);
				} finally {
					scholarDurationMs += Date.now() - startedAt;
				}
				const result = this.acceptCandidates(candidates, domain);
				candidateCount += candidates.length;
				rejectedCount += result.rejectedCount;
				external.push(...result.accepted);
			};
			try {
				await searchRank("A");
				if (uniquePapers(external).length < options.limit) await searchRank("B");
				if (uniquePapers(external).length < options.limit) await searchRank("C");
				if (uniquePapers(external).length < options.limit) await searchRank("A", false);
				if (uniquePapers(external).length < options.limit) await searchRank("B", false);
				if (uniquePapers(external).length < options.limit) await searchRank("C", false);
				status.googleScholar = `${candidateCount} 条候选，${uniquePapers(external).length} 篇通过 CCF`;
			} catch (error) {
				status.googleScholar = error instanceof Error ? error.message : "请求失败";
			}
		}

		const verified = uniquePapers([...external, ...local]);
		const baseOrder = verified.sort((left, right) => {
			const rank = (value: Paper) => (value.ccf?.rank === "A" ? 0 : value.ccf?.rank === "B" ? 1 : 2);
			return (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") || rank(left) - rank(right);
		});
		const memoryRanking = this.database.rankPapersByMemory(baseOrder, options.userId);
		const papers = memoryRanking.papers.slice(0, options.limit);
		const policy = this.database.ccfPolicy();
		return {
			papers,
			sourceStatus: status,
			policy: {
				version: policy.version,
				domain,
				acceptedRanks: ["A", "B", "C"],
				candidateCount,
				excludedCount: rejectedCount,
				searchQuery: scholarTopicQuery(options),
				telemetry: {
					scholarApiCalls,
					scholarDurationMs,
					memorySignals: memoryRanking.signalCount,
					memoryReranked: memoryRanking.rerankedCount,
				},
			},
		};
	}

	getPaper(id: string): Paper {
		const paper = this.database.getPaper(id);
		if (!paper) throw new Error("论文不存在");
		return paper;
	}

	verifyCcfVenue(publication: string, domain?: SearchOptions["domain"]): ReturnType<PaperDatabase["matchCcfVenue"]> {
		return this.database.matchCcfVenue(publication, domain);
	}

	saveFeedback(paperId: string, action: "save" | "skip" | "read" | "like" | "dislike", userId = "local-user"): void {
		this.database.saveFeedback(paperId, action, userId);
	}
}
