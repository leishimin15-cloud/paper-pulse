import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadCcfDirectory, matchCcfVenue } from "./ccf.ts";
import type {
	CcfDomain,
	CcfRank,
	CcfVenue,
	MemoryFeedback,
	MemoryItem,
	MemoryRecallResult,
	MemoryType,
	Paper,
	PaperInput,
	SourceType,
} from "./types.ts";

interface PaperRow {
	id: string;
	title: string;
	authors_json: string;
	abstract: string | null;
	doi: string | null;
	arxiv_id: string | null;
	published_at: string | null;
	language: string | null;
	venue: string | null;
	ccf_venue_id: string | null;
	ccf_rank: CcfRank | null;
	ccf_domain: CcfDomain | null;
	ccf_venue_type: "journal" | "conference" | null;
	ccf_match_method: "abbreviation" | "full-name" | "alias" | null;
	fingerprint: string;
	created_at: string;
	updated_at: string;
	source_type: SourceType;
	source_record_id: string | null;
	source_url: string | null;
	access_level: "metadata" | "abstract";
}

interface MemoryRow {
	id: string;
	user_id: string;
	memory_type: MemoryType;
	content: string;
	tags_json: string;
	source_run_id: string | null;
	confidence: number;
	metadata_json: string;
	created_at: string;
	updated_at: string;
}

function normalizeIdentifier(value: string | undefined): string | undefined {
	const normalized = value
		?.trim()
		.toLowerCase()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
	return normalized || undefined;
}

function normalizeTitle(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

export function paperFingerprint(title: string, authors: string[]): string {
	return createHash("sha256")
		.update(`${normalizeTitle(title)}|${authors[0]?.trim().toLowerCase() ?? ""}`)
		.digest("hex");
}

function toPaper(row: PaperRow): Paper {
	return {
		id: row.id,
		title: row.title,
		authors: JSON.parse(row.authors_json) as string[],
		abstract: row.abstract ?? undefined,
		doi: row.doi ?? undefined,
		arxivId: row.arxiv_id ?? undefined,
		publishedAt: row.published_at ?? undefined,
		language: row.language ?? undefined,
		venue: row.venue ?? undefined,
		ccf:
			row.ccf_venue_id && row.ccf_rank && row.ccf_domain && row.ccf_venue_type && row.ccf_match_method
				? {
						venueId: row.ccf_venue_id,
						rank: row.ccf_rank,
						domain: row.ccf_domain,
						venueType: row.ccf_venue_type,
						matchedBy: row.ccf_match_method,
					}
				: undefined,
		fingerprint: row.fingerprint,
		sourceType: row.source_type,
		sourceRecordId: row.source_record_id ?? undefined,
		sourceUrl: row.source_url ?? undefined,
		accessLevel: row.access_level,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toMemory(row: MemoryRow): MemoryItem {
	return {
		id: row.id,
		userId: row.user_id,
		memoryType: row.memory_type,
		content: row.content,
		tags: JSON.parse(row.tags_json) as string[],
		sourceRunId: row.source_run_id ?? undefined,
		confidence: row.confidence,
		metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function memoryTerms(value: string): string[] {
	return [
		...new Set(
			normalizeTitle(value)
				.split(" ")
				.filter((term) => term.length >= 2),
		),
	];
}

export class PaperDatabase {
	private readonly db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS ccf_sources (
				version TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				official_url TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				entry_count INTEGER NOT NULL,
				imported_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS ccf_venues (
				id TEXT PRIMARY KEY,
				version TEXT NOT NULL REFERENCES ccf_sources(version),
				domain TEXT NOT NULL,
				venue_type TEXT NOT NULL,
				ccf_rank TEXT NOT NULL,
				abbreviation TEXT,
				full_name TEXT NOT NULL,
				publisher TEXT,
				dblp_url TEXT,
				aliases_json TEXT NOT NULL,
				pdf_page INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS papers (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				authors_json TEXT NOT NULL,
				abstract TEXT,
				doi TEXT UNIQUE,
				arxiv_id TEXT UNIQUE,
				published_at TEXT,
				language TEXT,
				venue TEXT,
				fingerprint TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS paper_sources (
				id TEXT PRIMARY KEY,
				paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
				source_type TEXT NOT NULL,
				source_record_id TEXT NOT NULL DEFAULT '',
				source_url TEXT,
				access_level TEXT NOT NULL DEFAULT 'metadata',
				raw_metadata TEXT,
				UNIQUE(paper_id, source_type, source_record_id)
			);
			CREATE TABLE IF NOT EXISTS feedback (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL DEFAULT 'local-user',
				paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
				action TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS memory_items (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				memory_type TEXT NOT NULL,
				content TEXT NOT NULL,
				tags_json TEXT NOT NULL,
				source_run_id TEXT,
				confidence REAL NOT NULL,
				metadata_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(user_id, memory_type, content)
			);
			CREATE INDEX IF NOT EXISTS memory_items_user_updated
			ON memory_items(user_id, updated_at DESC);
		`);
		const columns = this.db.prepare("PRAGMA table_info(papers)").all() as unknown as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "venue")) this.db.exec("ALTER TABLE papers ADD COLUMN venue TEXT");
		for (const [name, declaration] of [
			["ccf_venue_id", "TEXT"],
			["ccf_rank", "TEXT"],
			["ccf_domain", "TEXT"],
			["ccf_venue_type", "TEXT"],
			["ccf_match_method", "TEXT"],
		] as const) {
			if (!columns.some((column) => column.name === name))
				this.db.exec(`ALTER TABLE papers ADD COLUMN ${name} ${declaration}`);
		}
		const feedbackColumns = this.db.prepare("PRAGMA table_info(feedback)").all() as unknown as Array<{
			name: string;
		}>;
		if (!feedbackColumns.some((column) => column.name === "user_id"))
			this.db.exec("ALTER TABLE feedback ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local-user'");
		this.importCcfDirectory();
	}

	private importCcfDirectory(): void {
		const directory = loadCcfDirectory();
		this.db
			.prepare(`
				INSERT INTO ccf_sources(version, title, official_url, sha256, entry_count, imported_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(version) DO UPDATE SET
					title = excluded.title,
					official_url = excluded.official_url,
					sha256 = excluded.sha256,
					entry_count = excluded.entry_count
			`)
			.run(
				directory.source.version,
				directory.source.title,
				directory.source.officialUrl,
				directory.source.sha256,
				directory.source.entryCount,
				new Date().toISOString(),
			);
		const insert = this.db.prepare(`
			INSERT INTO ccf_venues
			(id, version, domain, venue_type, ccf_rank, abbreviation, full_name, publisher, dblp_url, aliases_json, pdf_page)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				domain = excluded.domain,
				venue_type = excluded.venue_type,
				ccf_rank = excluded.ccf_rank,
				abbreviation = excluded.abbreviation,
				full_name = excluded.full_name,
				publisher = excluded.publisher,
				dblp_url = excluded.dblp_url,
				aliases_json = excluded.aliases_json,
				pdf_page = excluded.pdf_page
		`);
		for (const venue of directory.venues) {
			insert.run(
				venue.id,
				directory.source.version,
				venue.domain,
				venue.type,
				venue.rank,
				venue.abbreviation ?? null,
				venue.fullName,
				venue.publisher ?? null,
				venue.dblpUrl ?? null,
				JSON.stringify(venue.aliases),
				venue.page,
			);
		}
	}

	close(): void {
		this.db.close();
	}

	upsertPaper(input: PaperInput): Paper {
		const title = input.title.trim();
		if (!title) throw new Error("论文标题不能为空");
		const authors = input.authors.map((author) => author.trim()).filter(Boolean);
		const doi = normalizeIdentifier(input.doi);
		const arxivId = normalizeIdentifier(input.arxivId);
		const fingerprint = paperFingerprint(title, authors);
		const existing = this.db
			.prepare(
				"SELECT id FROM papers WHERE (? IS NOT NULL AND doi = ?) OR (? IS NOT NULL AND arxiv_id = ?) OR fingerprint = ? LIMIT 1",
			)
			.get(doi ?? null, doi ?? null, arxivId ?? null, arxivId ?? null, fingerprint) as { id: string } | undefined;
		const id = existing?.id ?? randomUUID();
		const now = new Date().toISOString();
		if (existing) {
			this.db
				.prepare(`
					UPDATE papers SET
						title = ?, authors_json = ?, abstract = COALESCE(?, abstract),
						doi = COALESCE(?, doi), arxiv_id = COALESCE(?, arxiv_id),
						published_at = COALESCE(?, published_at), language = COALESCE(?, language),
						venue = COALESCE(?, venue),
						ccf_venue_id = COALESCE(?, ccf_venue_id), ccf_rank = COALESCE(?, ccf_rank),
						ccf_domain = COALESCE(?, ccf_domain), ccf_venue_type = COALESCE(?, ccf_venue_type),
						ccf_match_method = COALESCE(?, ccf_match_method), updated_at = ?
					WHERE id = ?
				`)
				.run(
					title,
					JSON.stringify(authors),
					input.abstract ?? null,
					doi ?? null,
					arxivId ?? null,
					input.publishedAt ?? null,
					input.language ?? null,
					input.venue ?? null,
					input.ccf?.venueId ?? null,
					input.ccf?.rank ?? null,
					input.ccf?.domain ?? null,
					input.ccf?.venueType ?? null,
					input.ccf?.matchedBy ?? null,
					now,
					id,
				);
		} else {
			this.db
				.prepare(`
					INSERT INTO papers
					(id, title, authors_json, abstract, doi, arxiv_id, published_at, language, venue,
					 ccf_venue_id, ccf_rank, ccf_domain, ccf_venue_type, ccf_match_method,
					 fingerprint, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run(
					id,
					title,
					JSON.stringify(authors),
					input.abstract ?? null,
					doi ?? null,
					arxivId ?? null,
					input.publishedAt ?? null,
					input.language ?? null,
					input.venue ?? null,
					input.ccf?.venueId ?? null,
					input.ccf?.rank ?? null,
					input.ccf?.domain ?? null,
					input.ccf?.venueType ?? null,
					input.ccf?.matchedBy ?? null,
					fingerprint,
					now,
					now,
				);
		}
		this.db
			.prepare(`
				INSERT INTO paper_sources
				(id, paper_id, source_type, source_record_id, source_url, access_level, raw_metadata)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(paper_id, source_type, source_record_id) DO UPDATE SET
					source_url = excluded.source_url,
					access_level = excluded.access_level,
					raw_metadata = excluded.raw_metadata
			`)
			.run(
				randomUUID(),
				id,
				input.sourceType,
				input.sourceRecordId ?? "",
				input.sourceUrl ?? null,
				input.accessLevel ?? (input.abstract ? "abstract" : "metadata"),
				JSON.stringify(input),
			);
		return this.getPaper(id) as Paper;
	}

	listCcfVenues(domain?: CcfDomain, ranks: readonly CcfRank[] = ["A", "B", "C"]): CcfVenue[] {
		const rankPlaceholders = ranks.map(() => "?").join(", ");
		const rows = this.db
			.prepare(`
				SELECT id, domain, venue_type, ccf_rank, abbreviation, full_name, publisher, dblp_url,
				       aliases_json, pdf_page
				FROM ccf_venues
				WHERE ccf_rank IN (${rankPlaceholders}) ${domain ? "AND domain = ?" : ""}
				ORDER BY CASE ccf_rank WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END, full_name
			`)
			.all(...ranks, ...(domain ? [domain] : [])) as unknown as Array<{
			id: string;
			domain: CcfDomain;
			venue_type: "journal" | "conference";
			ccf_rank: CcfRank;
			abbreviation: string | null;
			full_name: string;
			publisher: string | null;
			dblp_url: string | null;
			aliases_json: string;
			pdf_page: number;
		}>;
		return rows.map((row) => ({
			id: row.id,
			domain: row.domain,
			type: row.venue_type,
			rank: row.ccf_rank,
			abbreviation: row.abbreviation ?? undefined,
			fullName: row.full_name,
			publisher: row.publisher ?? undefined,
			dblpUrl: row.dblp_url ?? undefined,
			aliases: JSON.parse(row.aliases_json) as string[],
			page: row.pdf_page,
		}));
	}

	matchCcfVenue(publication: string | undefined, domain?: CcfDomain): ReturnType<typeof matchCcfVenue> {
		return matchCcfVenue(publication, this.listCcfVenues(domain, ["A", "B", "C"]));
	}

	ccfPolicy(): { version: string; title: string; officialUrl: string; venues: number } {
		const source = this.db
			.prepare("SELECT version, title, official_url, entry_count FROM ccf_sources ORDER BY imported_at DESC LIMIT 1")
			.get() as { version: string; title: string; official_url: string; entry_count: number };
		return {
			version: source.version,
			title: source.title,
			officialUrl: source.official_url,
			venues: source.entry_count,
		};
	}

	getPaper(id: string): Paper | undefined {
		const row = this.db
			.prepare(`
				SELECT p.*, s.source_type, s.source_record_id, s.source_url, s.access_level
				FROM papers p
				JOIN paper_sources s ON s.paper_id = p.id
				WHERE p.id = ?
				ORDER BY CASE s.source_type WHEN 'google-scholar' THEN 0 ELSE 1 END
				LIMIT 1
			`)
			.get(id) as PaperRow | undefined;
		return row ? toPaper(row) : undefined;
	}

	listPapers(limit = 50): Paper[] {
		const rows = this.db
			.prepare(`
				SELECT p.*, s.source_type, s.source_record_id, s.source_url, s.access_level
				FROM papers p
				JOIN paper_sources s ON s.id = (
					SELECT id FROM paper_sources WHERE paper_id = p.id ORDER BY rowid LIMIT 1
				)
				ORDER BY COALESCE(p.published_at, p.created_at) DESC
				LIMIT ?
			`)
			.all(Math.max(1, Math.min(limit, 200))) as unknown as PaperRow[];
		return rows.map(toPaper);
	}

	searchPapers(query: string, limit = 20, sources?: SourceType[]): Paper[] {
		if (sources?.length === 0) return [];
		const tokens = normalizeTitle(query).split(" ").filter(Boolean);
		if (!tokens.length) return this.listPapers(limit);
		const parameters: Record<string, string | number> = {
			$limit: Math.max(1, Math.min(limit, 100)),
		};
		const clauses = tokens
			.map((token, index) => {
				parameters[`$token${index}`] = `%${token}%`;
				return `(lower(p.title) LIKE $token${index} OR lower(COALESCE(p.abstract, '')) LIKE $token${index})`;
			})
			.join(" OR ");
		const score = tokens
			.map(
				(_, index) =>
					`CASE WHEN lower(p.title) LIKE $token${index} OR lower(COALESCE(p.abstract, '')) LIKE $token${index} THEN 1 ELSE 0 END`,
			)
			.join(" + ");
		const sourceFilter = sources?.length
			? `AND EXISTS (
				SELECT 1 FROM paper_sources selected_source
				WHERE selected_source.paper_id = p.id
				AND selected_source.source_type IN (${sources
					.map((source, index) => {
						parameters[`$source${index}`] = source;
						return `$source${index}`;
					})
					.join(", ")})
			)`
			: "";
		const rows = this.db
			.prepare(`
				SELECT p.*, s.source_type, s.source_record_id, s.source_url, s.access_level, ${score} AS match_score
				FROM papers p
				JOIN paper_sources s ON s.id = (
					SELECT id FROM paper_sources WHERE paper_id = p.id ORDER BY rowid LIMIT 1
				)
				WHERE (${clauses})
				${sourceFilter}
				ORDER BY match_score DESC, COALESCE(p.published_at, p.created_at) DESC
				LIMIT $limit
			`)
			.all(parameters) as unknown as PaperRow[];
		return rows.map(toPaper);
	}

	saveFeedback(paperId: string, action: "save" | "skip" | "read" | "like" | "dislike", userId = "local-user"): void {
		if (!this.getPaper(paperId)) throw new Error("论文不存在");
		this.db
			.prepare("INSERT INTO feedback(id, user_id, paper_id, action, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(randomUUID(), userId, paperId, action, new Date().toISOString());
	}

	saveMemory(input: {
		userId?: string;
		memoryType: MemoryType;
		content: string;
		tags?: string[];
		sourceRunId?: string;
		confidence?: number;
		metadata?: Record<string, unknown>;
	}): MemoryItem {
		const userId = input.userId?.trim() || "local-user";
		const content = input.content.trim();
		if (!content) throw new Error("记忆内容不能为空");
		const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 30);
		const confidence = Math.max(0, Math.min(input.confidence ?? 1, 1));
		const now = new Date().toISOString();
		const existing = this.db
			.prepare("SELECT id, created_at FROM memory_items WHERE user_id = ? AND memory_type = ? AND content = ?")
			.get(userId, input.memoryType, content) as { id: string; created_at: string } | undefined;
		const id = existing?.id ?? randomUUID();
		this.db
			.prepare(`
				INSERT INTO memory_items
				(id, user_id, memory_type, content, tags_json, source_run_id, confidence, metadata_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id, memory_type, content) DO UPDATE SET
					tags_json = excluded.tags_json,
					source_run_id = COALESCE(excluded.source_run_id, memory_items.source_run_id),
					confidence = excluded.confidence,
					metadata_json = excluded.metadata_json,
					updated_at = excluded.updated_at
			`)
			.run(
				id,
				userId,
				input.memoryType,
				content,
				JSON.stringify(tags),
				input.sourceRunId ?? null,
				confidence,
				JSON.stringify(input.metadata ?? {}),
				existing?.created_at ?? now,
				now,
			);
		return toMemory(this.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as unknown as MemoryRow);
	}

	recallMemory(query: string, userId = "local-user", limit = 8): MemoryRecallResult {
		const startedAt = Date.now();
		const rows = this.db
			.prepare("SELECT * FROM memory_items WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200")
			.all(userId) as unknown as MemoryRow[];
		const terms = memoryTerms(query);
		const items = rows
			.map((row) => {
				const item = toMemory(row);
				const haystack = normalizeTitle(`${item.content} ${item.tags.join(" ")} ${JSON.stringify(item.metadata)}`);
				const matches = terms.filter((term) => haystack.includes(term)).length;
				const recency = Math.max(0, 1 - (Date.now() - Date.parse(item.updatedAt)) / (1000 * 60 * 60 * 24 * 180));
				return { ...item, relevanceScore: query.trim() ? matches * item.confidence + recency * 0.2 : recency };
			})
			.filter((item) => !query.trim() || (item.relevanceScore ?? 0) > 0.2)
			.sort(
				(left, right) =>
					(right.relevanceScore ?? 0) - (left.relevanceScore ?? 0) ||
					right.updatedAt.localeCompare(left.updatedAt),
			)
			.slice(0, Math.max(1, Math.min(limit, 20)));
		const feedbackRows = this.db
			.prepare(`
				SELECT f.paper_id, p.title, f.action, f.created_at
				FROM feedback f JOIN papers p ON p.id = f.paper_id
				WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 100
			`)
			.all(userId) as unknown as Array<{
			paper_id: string;
			title: string;
			action: MemoryFeedback["action"];
			created_at: string;
		}>;
		const latestFeedback = [...new Map(feedbackRows.map((row) => [row.paper_id, row])).values()].map((row) => ({
			paperId: row.paper_id,
			title: row.title,
			action: row.action,
			createdAt: row.created_at,
		}));
		const total = (
			this.db.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE user_id = ?").get(userId) as {
				count: number;
			}
		).count;
		return {
			userId,
			query,
			items,
			feedback: {
				positive: latestFeedback.filter((item) => item.action === "save" || item.action === "like"),
				negative: latestFeedback.filter((item) => item.action === "skip" || item.action === "dislike"),
				read: latestFeedback.filter((item) => item.action === "read"),
			},
			stats: { total, scanned: rows.length, returned: items.length },
			telemetry: { durationMs: Date.now() - startedAt },
		};
	}

	rankPapersByMemory(
		papers: Paper[],
		userId = "local-user",
	): {
		papers: Paper[];
		signalCount: number;
		rerankedCount: number;
	} {
		const recall = this.recallMemory("", userId, 20);
		const preferredTerms = recall.items
			.filter((item) => item.memoryType === "preference" || item.memoryType === "interest")
			.flatMap((item) => [...item.tags, ...memoryTerms(item.content)]);
		const feedbackScore = new Map<string, number>();
		for (const item of recall.feedback.positive) feedbackScore.set(item.paperId, 4);
		for (const item of recall.feedback.negative) feedbackScore.set(item.paperId, -6);
		for (const item of recall.feedback.read) feedbackScore.set(item.paperId, -1);
		const indexed = papers.map((paper, index) => {
			const haystack = normalizeTitle(`${paper.title} ${paper.abstract ?? ""} ${paper.venue ?? ""}`);
			const preferenceScore = preferredTerms.filter((term) => haystack.includes(normalizeTitle(term))).length;
			return { paper, index, score: (feedbackScore.get(paper.id) ?? 0) + Math.min(preferenceScore, 4) };
		});
		const ranked = [...indexed].sort((left, right) => right.score - left.score || left.index - right.index);
		return {
			papers: ranked.map((item) => item.paper),
			signalCount: preferredTerms.length + feedbackScore.size,
			rerankedCount: ranked.filter((item, index) => item.index !== index).length,
		};
	}

	forgetMemory(input: { userId?: string; memoryId?: string; clearAll?: boolean }): number {
		const userId = input.userId?.trim() || "local-user";
		if (input.clearAll) {
			const memoryResult = this.db.prepare("DELETE FROM memory_items WHERE user_id = ?").run(userId);
			const feedbackResult = this.db.prepare("DELETE FROM feedback WHERE user_id = ?").run(userId);
			return Number(memoryResult.changes) + Number(feedbackResult.changes);
		}
		if (!input.memoryId) throw new Error("需要提供 memoryId 或 clearAll=true");
		return Number(
			this.db.prepare("DELETE FROM memory_items WHERE id = ? AND user_id = ?").run(input.memoryId, userId).changes,
		);
	}

	stats(): { papers: number; feedback: number; memories: number; ccfVenues: number } {
		const count = (table: string) =>
			(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
		return {
			papers: count("papers"),
			feedback: count("feedback"),
			memories: count("memory_items"),
			ccfVenues: count("ccf_venues"),
		};
	}
}
