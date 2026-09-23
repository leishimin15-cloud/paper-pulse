import { inferCcfDomain } from "./ccf.ts";
import type { PaperDatabase, RagSearchHit } from "./database.ts";
import { chunkPaperText, type EmbeddingProvider, LocalTransformerEmbeddingProvider } from "./embedding.ts";
import { demoPapers, type ScholarCandidate, scholarTopicQuery, searchGoogleScholar } from "./sources.ts";
import type { CcfRank, Paper, SearchOptions, SearchResult, SourceType } from "./types.ts";

function uniquePapers(papers: Paper[]): Paper[] {
	return [...new Map(papers.map((paper) => [paper.id, paper])).values()];
}

export class PaperKnowledgeService {
	readonly database: PaperDatabase;
	private readonly embeddingProvider: EmbeddingProvider;

	constructor(
		database: PaperDatabase,
		embeddingProvider: EmbeddingProvider = new LocalTransformerEmbeddingProvider(),
	) {
		this.database = database;
		this.embeddingProvider = embeddingProvider;
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

	private async indexPapers(papers: Paper[]): Promise<number> {
		const missing: Array<{ id: string; content: string }> = [];
		for (const paper of uniquePapers(papers)) {
			const chunks = this.database.indexPaperChunks(paper.id, chunkPaperText(paper.title, paper.abstract));
			for (const chunk of chunks) {
				if (!this.database.getChunkEmbedding(chunk.id, this.embeddingProvider.id))
					missing.push({ id: chunk.id, content: chunk.content });
			}
		}
		if (!missing.length) return 0;
		const batchSize = 16;
		for (let start = 0; start < missing.length; start += batchSize) {
			const batch = missing.slice(start, start + batchSize);
			const vectors = await this.embeddingProvider.embed(batch.map((chunk) => chunk.content));
			for (const [index, chunk] of batch.entries()) {
				const vector = vectors[index];
				if (!vector) throw new Error("Embedding 数量与文献块数量不一致");
				this.database.saveChunkEmbedding(chunk.id, this.embeddingProvider.id, vector);
			}
		}
		return missing.length;
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
		let embeddedChunks = 0;
		let vectorDurationMs = 0;
		const localSources: SourceType[] = options.sources.filter((source) => source !== "google-scholar");

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

		const corpus = uniquePapers([
			...external,
			...this.database
				.listPapers(200)
				.filter((paper) => !localSources.length || localSources.includes(paper.sourceType)),
		]).filter((paper) => paper.ccf?.domain === domain);
		let ragHits: RagSearchHit[] = [];
		const vectorStartedAt = Date.now();
		try {
			embeddedChunks = await this.indexPapers(corpus);
			const [queryVector] = await this.embeddingProvider.embed([
				[options.query, ...(options.coreConcepts ?? []), ...(options.expansionTerms ?? [])].join(" "),
			]);
			if (!queryVector) throw new Error("查询向量生成失败");
			ragHits = this.database
				.searchChunkEmbeddings(queryVector, this.embeddingProvider.id, Math.max(options.limit * 3, 30))
				.filter((hit) => hit.paper.ccf?.domain === domain && corpus.some((paper) => paper.id === hit.paper.id));
			status.vector = `${this.embeddingProvider.id}，召回 ${ragHits.length} 个文献块`;
		} catch (error) {
			status.vector = `向量检索失败：${error instanceof Error ? error.message : "未知错误"}`;
			const fallback = this.database
				.searchPapers(options.query, options.limit, localSources.length ? localSources : undefined)
				.filter((paper) => paper.ccf?.domain === domain);
			ragHits = fallback.map((paper) => ({
				paper,
				chunkId: `keyword:${paper.id}`,
				content: [paper.title, paper.abstract].filter(Boolean).join("\n"),
				score: 0,
			}));
		} finally {
			vectorDurationMs = Date.now() - vectorStartedAt;
		}

		const highestScore = new Map<string, number>();
		for (const hit of ragHits)
			highestScore.set(hit.paper.id, Math.max(highestScore.get(hit.paper.id) ?? -1, hit.score));
		const baseOrder = uniquePapers(ragHits.map((hit) => hit.paper)).sort((left, right) => {
			const rank = (value: Paper) => (value.ccf?.rank === "A" ? 0 : value.ccf?.rank === "B" ? 1 : 2);
			return (
				(highestScore.get(right.id) ?? 0) - (highestScore.get(left.id) ?? 0) ||
				(right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") ||
				rank(left) - rank(right)
			);
		});
		const memoryRanking = this.database.rankPapersByMemory(baseOrder, options.userId);
		const papers = memoryRanking.papers.slice(0, options.limit);
		const paperIds = new Set(papers.map((paper) => paper.id));
		const contexts = ragHits
			.filter((hit) => paperIds.has(hit.paper.id))
			.slice(0, Math.max(options.limit * 2, 20))
			.map((hit) => ({
				paperId: hit.paper.id,
				chunkId: hit.chunkId,
				content: hit.content,
				score: Number(hit.score.toFixed(4)),
			}));
		status.local = `${papers.length} 篇进入归纳上下文`;
		const policy = this.database.ccfPolicy();
		return {
			papers,
			contexts,
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
					embeddingModel: this.embeddingProvider.id,
					embeddedChunks,
					retrievedChunks: contexts.length,
					vectorDurationMs,
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
