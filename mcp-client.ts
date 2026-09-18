import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export class PaperMcpClient {
	private readonly client: Client;
	private readonly transport: StdioClientTransport;

	private constructor(client: Client, transport: StdioClientTransport) {
		this.client = client;
		this.transport = transport;
	}

	static async connect(root: string, databasePath: string): Promise<PaperMcpClient> {
		const client = new Client({ name: "paper-pulse-pi-bridge", version: "0.1.0" });
		const env: Record<string, string> = { ...getDefaultEnvironment(), PAPER_PULSE_DB: databasePath };
		if (process.env.SERPAPI_API_KEY) env.SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: ["--import", "tsx", `${root}/mcp-server.ts`],
			cwd: root,
			env,
			stderr: "inherit",
		});
		await client.connect(transport);
		return new PaperMcpClient(client, transport);
	}

	async listTools(): Promise<string[]> {
		const result = await this.client.listTools();
		return result.tools.map((tool) => tool.name);
	}

	async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
		const result = await this.client.callTool({ name, arguments: args });
		if (result.isError) {
			const message = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			throw new Error(message || `MCP tool ${name} failed`);
		}
		if (result.structuredContent !== undefined) return result.structuredContent as T;
		const first = result.content.find((item) => item.type === "text");
		if (!first || first.type !== "text") throw new Error(`MCP tool ${name} returned no JSON content`);
		return JSON.parse(first.text) as T;
	}

	async close(): Promise<void> {
		await this.client.close();
		await this.transport.close();
	}
}
