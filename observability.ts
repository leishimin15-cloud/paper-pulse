import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SearchResult } from "./types.ts";

type SpanKind = "model" | "mcp" | "application";
type SpanStatus = "ok" | "error";
type RunStatus = "ok" | "error";
type AttributeValue = string | number | boolean | null;

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

interface AssistantMessageLike {
	provider: string;
	model: string;
	usage: UsageLike;
}

export interface TraceSpan {
	spanId: string;
	name: string;
	kind: SpanKind;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	status?: SpanStatus;
	attributes: Record<string, AttributeValue>;
}

export interface RunTrace {
	runId: string;
	query: string;
	mode: "pi" | "demo";
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	status: RunStatus;
	error?: string;
	model?: { provider: string; name: string };
	calls: { model: number; mcp: number; scholar: number };
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: {
		modelUsd: number;
		serpApiUsd: number | null;
		totalUsd: number | null;
		serpApiUnitCostUsd: number | null;
	};
	results: { candidates: number; accepted: number; excluded: number };
	memory: {
		recallCalls: number;
		writeCalls: number;
		forgetCalls: number;
		recalledItems: number;
		savedItems: number;
		deletedItems: number;
	};
	spans: TraceSpan[];
	persistenceError?: string;
}

interface ActiveSpan {
	span: TraceSpan;
	startedAtMs: number;
}

function finiteNonNegative(value: string | undefined): number | null {
	if (!value?.trim()) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export class RunTraceRecorder {
	readonly runId = randomUUID();
	private readonly tracePath: string;
	private readonly query: string;
	private readonly mode: RunTrace["mode"];
	private readonly serpApiUnitCostUsd: number | null;
	private readonly startedAtMs = Date.now();
	private readonly spans: TraceSpan[] = [];
	private readonly activeSpans = new Map<string, ActiveSpan>();
	private readonly calls = { model: 0, mcp: 0, scholar: 0 };
	private readonly tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	private readonly results = { candidates: 0, accepted: 0, excluded: 0 };
	private readonly memory = {
		recallCalls: 0,
		writeCalls: 0,
		forgetCalls: 0,
		recalledItems: 0,
		savedItems: 0,
		deletedItems: 0,
	};
	private model: RunTrace["model"];
	private modelCostUsd = 0;

	constructor(
		tracePath: string,
		query: string,
		mode: RunTrace["mode"],
		serpApiUnitCostUsd = finiteNonNegative(process.env.SERPAPI_COST_PER_REQUEST_USD),
	) {
		this.tracePath = tracePath;
		this.query = query;
		this.mode = mode;
		this.serpApiUnitCostUsd = serpApiUnitCostUsd;
	}

	startSpan(name: string, kind: SpanKind, attributes: Record<string, AttributeValue> = {}): string {
		const spanId = randomUUID();
		const startedAtMs = Date.now();
		const span: TraceSpan = {
			spanId,
			name,
			kind,
			startedAt: new Date(startedAtMs).toISOString(),
			attributes,
		};
		this.activeSpans.set(spanId, { span, startedAtMs });
		this.spans.push(span);
		return spanId;
	}

	finishSpan(spanId: string, status: SpanStatus, attributes: Record<string, AttributeValue> = {}): void {
		const active = this.activeSpans.get(spanId);
		if (!active) return;
		const finishedAtMs = Date.now();
		active.span.finishedAt = new Date(finishedAtMs).toISOString();
		active.span.durationMs = finishedAtMs - active.startedAtMs;
		active.span.status = status;
		Object.assign(active.span.attributes, attributes);
		this.activeSpans.delete(spanId);
	}

	recordMcpCall(): void {
		this.calls.mcp++;
	}

	recordModel(message: AssistantMessageLike): void {
		this.calls.model++;
		this.model = { provider: message.provider, name: message.model };
		this.tokens.input += message.usage.input;
		this.tokens.output += message.usage.output;
		this.tokens.cacheRead += message.usage.cacheRead;
		this.tokens.cacheWrite += message.usage.cacheWrite;
		this.tokens.total += message.usage.totalTokens;
		this.modelCostUsd += message.usage.cost.total;
	}

	recordSearch(result: SearchResult): void {
		this.calls.scholar += result.policy.telemetry.scholarApiCalls;
		this.results.candidates = result.policy.candidateCount;
		this.results.accepted = result.papers.length;
		this.results.excluded = result.policy.excludedCount;
	}

	recordMemoryRecall(recalledItems: number): void {
		this.memory.recallCalls++;
		this.memory.recalledItems += recalledItems;
	}

	recordMemoryWrite(savedItems: number): void {
		this.memory.writeCalls++;
		this.memory.savedItems += savedItems;
	}

	recordMemoryForget(deletedItems: number): void {
		this.memory.forgetCalls++;
		this.memory.deletedItems += deletedItems;
	}

	async finish(status: RunStatus, error?: string): Promise<RunTrace> {
		for (const spanId of this.activeSpans.keys()) this.finishSpan(spanId, status);
		const finishedAtMs = Date.now();
		const serpApiUsd =
			this.calls.scholar === 0
				? 0
				: this.serpApiUnitCostUsd === null
					? null
					: this.calls.scholar * this.serpApiUnitCostUsd;
		const trace: RunTrace = {
			runId: this.runId,
			query: this.query,
			mode: this.mode,
			startedAt: new Date(this.startedAtMs).toISOString(),
			finishedAt: new Date(finishedAtMs).toISOString(),
			durationMs: finishedAtMs - this.startedAtMs,
			status,
			...(error ? { error } : {}),
			...(this.model ? { model: this.model } : {}),
			calls: { ...this.calls },
			tokens: { ...this.tokens },
			cost: {
				modelUsd: this.modelCostUsd,
				serpApiUsd,
				totalUsd: serpApiUsd === null ? null : this.modelCostUsd + serpApiUsd,
				serpApiUnitCostUsd: this.serpApiUnitCostUsd,
			},
			results: { ...this.results },
			memory: { ...this.memory },
			spans: this.spans,
		};
		try {
			await mkdir(dirname(this.tracePath), { recursive: true });
			await appendFile(this.tracePath, `${JSON.stringify(trace)}\n`, "utf8");
		} catch (writeError) {
			trace.persistenceError = writeError instanceof Error ? writeError.message : "Trace 写入失败";
		}
		return trace;
	}
}

export async function readRecentRuns(tracePath: string, limit = 20): Promise<RunTrace[]> {
	try {
		const content = await readFile(tracePath, "utf8");
		return content
			.split("\n")
			.filter(Boolean)
			.slice(-Math.max(1, Math.min(limit, 100)))
			.reverse()
			.map((line) => JSON.parse(line) as RunTrace);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}
