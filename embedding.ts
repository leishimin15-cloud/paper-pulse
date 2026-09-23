import { env, type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";

const DEFAULT_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const createFeatureExtractionPipeline = pipeline as (
	task: "feature-extraction",
	model: string,
	options: { dtype: "q8" },
) => Promise<FeatureExtractionPipeline>;

export interface EmbeddingProvider {
	readonly id: string;
	embed(texts: string[]): Promise<number[][]>;
}

export class LocalTransformerEmbeddingProvider implements EmbeddingProvider {
	readonly id: string;
	private readonly model: string;
	private extractor: Promise<FeatureExtractionPipeline> | undefined;

	constructor(model = process.env.PAPER_PULSE_EMBEDDING_MODEL?.trim() || DEFAULT_MODEL) {
		this.model = model;
		this.id = `transformers-js:${model}`;
		env.cacheDir = process.env.PAPER_PULSE_MODEL_CACHE?.trim() || "./data/models";
		const modelHost = process.env.PAPER_PULSE_MODEL_HOST?.trim();
		if (modelHost) env.remoteHost = modelHost.endsWith("/") ? modelHost : `${modelHost}/`;
	}

	private getExtractor(): Promise<FeatureExtractionPipeline> {
		this.extractor ??= createFeatureExtractionPipeline("feature-extraction", this.model, { dtype: "q8" });
		return this.extractor;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (!texts.length) return [];
		const extractor = await this.getExtractor();
		const output = await extractor(texts, { pooling: "mean", normalize: true });
		const dimensions = output.dims.at(-1);
		if (!dimensions || output.dims[0] !== texts.length) throw new Error("Embedding 模型返回了无效维度");
		const values = Array.from(output.data, Number);
		return texts.map((_, index) => values.slice(index * dimensions, (index + 1) * dimensions));
	}
}

export interface PaperChunkInput {
	index: number;
	content: string;
}

export function chunkPaperText(
	title: string,
	abstract: string | undefined,
	maxWords = 120,
	overlap = 24,
): PaperChunkInput[] {
	const body = abstract?.trim();
	if (!body) return [{ index: 0, content: title.trim() }];
	const words = body.split(/\s+/).filter(Boolean);
	if (words.length <= maxWords) return [{ index: 0, content: `${title.trim()}\n${body}` }];
	const chunks: PaperChunkInput[] = [];
	const step = Math.max(1, maxWords - overlap);
	for (let start = 0; start < words.length; start += step) {
		chunks.push({
			index: chunks.length,
			content: `${title.trim()}\n${words.slice(start, start + maxWords).join(" ")}`,
		});
		if (start + maxWords >= words.length) break;
	}
	return chunks;
}
