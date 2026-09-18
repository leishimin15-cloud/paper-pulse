import type { CcfVenue, PaperInput, SearchOptions, SourceType } from "./types.ts";

interface ScholarResult {
	result_id?: string;
	title?: string;
	link?: string;
	snippet?: string;
	publication_info?: {
		summary?: string;
		authors?: Array<{ name?: string }>;
	};
}

interface ScholarResponse {
	error?: string;
	organic_results?: ScholarResult[];
}

export interface ScholarCandidate extends PaperInput {
	publicationSummary?: string;
}

function publicationDate(summary: string | undefined, snippet: string | undefined): string | undefined {
	const relative = snippet?.match(/^(\d+)\s+(hour|day|week|month)s?\s+ago\b/iu);
	if (relative) {
		const amount = Number(relative[1]);
		const unit = relative[2]?.toLowerCase();
		const days = unit === "hour" ? amount / 24 : unit === "day" ? amount : unit === "week" ? amount * 7 : amount * 30;
		return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
	}
	const years = summary?.match(/(?:19|20)\d{2}/gu);
	return years?.at(-1);
}

function publicationVenue(summary: string | undefined): string | undefined {
	const segment = summary?.split(" - ")[1]?.trim();
	return segment?.replace(/,?\s*(?:19|20)\d{2}.*$/u, "").trim() || undefined;
}

function fallbackAuthors(summary: string | undefined): string[] {
	const authorText = summary?.split(" - ")[0]?.trim();
	return authorText ? authorText.split(/,\s*/u).filter(Boolean) : [];
}

export function scholarTopicQuery(options: SearchOptions): string {
	const quote = (value: string) => `"${value.replaceAll('"', " ").trim()}"`;
	const core = (options.coreConcepts ?? []).map(quote).join(" ");
	const expansion = (options.expansionTerms ?? []).map(quote);
	if (!core) return options.query;
	return expansion.length ? `${core} (${expansion.join(" OR ")})` : core;
}

function scholarVenueQuery(options: SearchOptions, venues: readonly CcfVenue[]): string {
	const names = [...new Set(venues.map((venue) => venue.abbreviation || venue.fullName).filter(Boolean))];
	return `${scholarTopicQuery(options)} (${names.map((name) => `source:"${name}"`).join(" OR ")})`;
}

export async function searchGoogleScholar(
	options: SearchOptions,
	venues: readonly CcfVenue[],
	signal?: AbortSignal,
	sortByDate = true,
): Promise<ScholarCandidate[]> {
	const apiKey = process.env.SERPAPI_API_KEY?.trim();
	if (!apiKey) throw new Error("未配置 SERPAPI_API_KEY");
	const url = new URL("https://serpapi.com/search.json");
	url.searchParams.set("engine", "google_scholar");
	url.searchParams.set("q", scholarVenueQuery(options, venues));
	url.searchParams.set("num", String(Math.min(options.limit, 20)));
	url.searchParams.set("hl", "en");
	if (sortByDate) url.searchParams.set("scisbd", "2");
	url.searchParams.set("api_key", apiKey);
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`Google Scholar 请求失败 (${response.status})`);
	const payload = (await response.json()) as ScholarResponse;
	if (payload.error) throw new Error(`Google Scholar 请求失败：${payload.error}`);
	return (payload.organic_results ?? [])
		.filter((item): item is ScholarResult & { title: string } => Boolean(item.title))
		.map((item): ScholarCandidate => {
			const summary = item.publication_info?.summary;
			const authors = (item.publication_info?.authors ?? [])
				.map((author) => author.name?.trim())
				.filter((author): author is string => Boolean(author));
			return {
				title: item.title,
				authors: authors.length ? authors : fallbackAuthors(summary),
				abstract: item.snippet,
				publishedAt: publicationDate(summary, item.snippet),
				language: /[\u3400-\u9fff]/u.test(item.title) ? "zh" : "en",
				venue: publicationVenue(summary),
				publicationSummary: summary,
				sourceType: "google-scholar",
				sourceRecordId: item.result_id ?? item.link ?? item.title,
				sourceUrl: item.link,
				accessLevel: item.snippet ? "abstract" : "metadata",
			};
		})
		.filter((paper) => Boolean(paper.venue));
}

export const demoPapers: PaperInput[] = [
	{
		title: "[演示] Evidence-Grounded Memory for Long-Horizon Agents",
		authors: ["PaperPulse Demo Team"],
		abstract: "研究长任务 Agent 的分层记忆检索，并要求生成结论绑定可验证证据。",
		publishedAt: "2026-09-12",
		language: "zh",
		venue: "NeurIPS",
		ccf: {
			venueId: "ccf-2026-conference-人工智能-A-2",
			rank: "A",
			domain: "人工智能",
			venueType: "conference",
			matchedBy: "abbreviation",
		},
		sourceType: "demo",
		sourceRecordId: "demo-memory-1",
		accessLevel: "abstract",
	},
	{
		title: "[演示] Adaptive Retrieval Policies for Tool-Using Agents",
		authors: ["PaperPulse Demo Team"],
		abstract: "比较固定检索与自适应检索策略在多步工具任务中的成本和准确率。",
		publishedAt: "2026-09-10",
		language: "zh",
		venue: "JMLR",
		ccf: {
			venueId: "ccf-2026-journal-人工智能-A-4",
			rank: "A",
			domain: "人工智能",
			venueType: "journal",
			matchedBy: "abbreviation",
		},
		sourceType: "demo",
		sourceRecordId: "demo-retrieval-1",
		accessLevel: "abstract",
	},
	{
		title: "[演示] Evaluating Citation Faithfulness in Research Agents",
		authors: ["PaperPulse Demo Team"],
		abstract: "提出页码级证据覆盖率和无证据结论率，用于评估论文研究 Agent。",
		publishedAt: "2026-09-08",
		language: "zh",
		venue: "TPAMI",
		ccf: {
			venueId: "ccf-2026-journal-人工智能-A-2",
			rank: "A",
			domain: "人工智能",
			venueType: "journal",
			matchedBy: "abbreviation",
		},
		sourceType: "demo",
		sourceRecordId: "demo-eval-1",
		accessLevel: "abstract",
	},
];

export function isSourceType(value: string): value is SourceType {
	return ["google-scholar", "demo"].includes(value);
}
