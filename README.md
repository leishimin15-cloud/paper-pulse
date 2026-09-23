# PaperPulse · Pi SDK × MCP × RAG

PaperPulse 是一个面向计算机领域的论文研究 Agent。用户输入自然语言问题后，大语言模型负责生成检索计划，MCP Server 搜索 Google Scholar；系统将论文摘要切块并生成稠密向量，在 SQLite 中执行 Top-K 召回，再用 CCF 2026 目录做确定性来源过滤，最后由 Agent 基于召回上下文归纳方法、结论与研究趋势。

这个项目用于验证六项能力：Pi SDK 会话编排、MCP 工具协议、SQLite 向量 RAG、可复用 Prompt/Skill、长期研究记忆，以及带成本和 Trace 的 Eval 闭环。

## 关键设计

- **Pi SDK**：`AgentSession` 管理模型流式输出、工具调用和生命周期事件。
- **MCP**：论文搜索、CCF 来源验证、资料库查询和用户反馈通过独立 stdio Server 暴露。
- **RAG**：论文摘要按 120 词、24 词重叠切块，使用多语言 MiniLM 生成 384 维稠密向量并持久化到 SQLite；查询向量与文献块执行余弦相似度 Top-K 召回，CCF 目录只负责来源校验。
- **Skill**：`.pi/skills/paper-research/SKILL.md` 固化“提取检索词 → 搜索 → 过滤 → 归纳”的步骤和证据边界。
- **Memory**：SQLite 持久化研究历史、长期偏好与论文反馈，检索前召回并用于关键词规划和结果重排。
- **Observability**：每次运行产生 `run_id`、Trace/Span、步骤耗时、API 次数、Token 和单次成本。
- **Eval**：固定 Fixture 定义标准答案，离线评测领域路由、CCF 匹配和 Scholar 检索式构造。

## 快速开始

需要 Node.js 22.19 或更高版本。

```sh
npm ci --ignore-scripts
cp .env.example .env
npm run dev
```

打开 http://127.0.0.1:3220 。首次检索会从 Hugging Face 下载量化 Embedding 模型并缓存到 `data/models/`。如果当前网络无法访问官方模型站，可在 `.env` 配置 `PAPER_PULSE_MODEL_HOST=https://hf-mirror.com`。未配置 `SERPAPI_API_KEY` 时，项目使用 3 篇明确标记的合成论文演示完整 RAG 链路，不调用外部搜索 API。

真实检索通过 SerpApi 调用 Google Scholar。编辑 `.env`：

```sh
SERPAPI_API_KEY=your_private_key
# 可选：用于估算每次 SerpApi 请求的成本
SERPAPI_COST_PER_REQUEST_USD=0.01
```

真实 Pi Agent 模式还需要 Pi 支持的大模型凭证。模型 Token 和费用直接读取 Pi 的 `AssistantMessage.usage`；SerpApi 套餐单价无法自动推断，未配置时界面会将外部成本标为未知。

## 验证

```sh
npm run check
npm test
npm run eval
```

CI 会在每次 push 和 pull request 中执行以上三项检查。

## 本地开发

首次安装依赖：

```sh
npm install --ignore-scripts
```

启动开发服务：

```sh
npm run dev
```

## 调用链路

```text
Web UI
→ Node HTTP / NDJSON
→ Pi AgentSession
→ 受限业务工具
→ MCP stdio Client
→ Paper Knowledge MCP Server
→ Google Scholar
→ 摘要切块 / MiniLM Embedding
→ SQLite 向量召回 / CCF 来源校验
→ RAG 上下文 / Agent 归纳
```

MCP Server 暴露 7 个工具和 1 个资源：

- `search_ccf_papers`：接收 LLM 提取的核心概念与扩展词，搜索论文，生成摘要向量并执行 Top-K 召回，再进行 CCF A/B/C 来源过滤
- `verify_ccf_venue`：单独验证期刊/会议名称是否命中 CCF 2026 A/B/C 目录
- `list_library`：读取本地去重后的论文记录和统计
- `save_feedback`：记录收藏、跳过等用户反馈
- `recall_research_memory`：按当前问题召回相关历史研究、长期偏好和论文反馈
- `save_research_memory`：保存用户明确表达的长期偏好、兴趣、约束或研究历史
- `forget_research_memory`：删除单条记忆或清空当前用户的记忆与反馈
- `paper://{paperId}`：读取标准化论文记录

Pi 模式加载 `.pi/SYSTEM.md` 和 `.pi/skills/paper-research/SKILL.md`，只启用受限 `read`、论文搜索、研究记忆和反馈 Tool，不开放 `bash/edit/write`。

## 长期研究记忆

每次研究开始前，Agent 必须调用 `recall_research_memory`。召回内容只用于检索词扩展和结果重排，用户当前明确需求始终优先，CCF 来源过滤不会被记忆绕过。每次成功研究会自动保存为 `research-history`；收藏、跳过、已读、喜欢和不喜欢等反馈参与后续排序。

页面中的“研究记忆”面板可以查看最近记忆并清空当前用户的记忆与反馈。默认用户为 `local-user`，可通过 `PAPER_PULSE_USER_ID` 覆盖。Memory 的偏好信号在向量召回后参与重排，不改变 RAG 证据，也不能绕过 CCF 来源校验。

## 向量 RAG

RAG 链路分为五步：

1. **Ingestion**：Google Scholar 结果标准化、去重并写入 `papers`。
2. **Chunking**：标题与摘要写入 `paper_chunks`，长摘要按 120 词切分并保留 24 词重叠。
3. **Embedding**：Transformers.js 在本地运行 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`，生成归一化的 384 维向量。
4. **Retrieval**：向量存入 `chunk_embeddings`；查询向量与文献块计算余弦相似度，召回 Top-K 上下文并按论文聚合。
5. **Generation**：MCP Tool 把带 `paperId`、`chunkId` 和相似度的 `contexts` 交给 Agent，Skill 要求归纳只能使用这些证据并保留论文引用。

SQLite 同时保存论文元数据、文本块和向量，适合个人项目的数据规模，也便于在 Windows 与 macOS 上运行。CCF 目录属于检索后的结构化校验规则，不作为向量知识库冒充 RAG。

## CCF 本地知识库

项目中的 `ccf-2026.json` 从《中国计算机学会推荐国际学术会议和期刊目录（2026年）》PDF 提取，包含 681 条会议和期刊记录。数据库启动时写入：

- `ccf_sources`：目录版本、官方地址、PDF SHA-256 和导入时间
- `ccf_venues`：领域、A/B/C 等级、期刊或会议类型、简称、全称、别名、DBLP 地址和 PDF 页码
- `paper_chunks`：带论文外键、块序号和内容哈希的 RAG 文本块
- `chunk_embeddings`：按 Embedding 模型版本保存的稠密向量

论文不会与 PDF 中的标题匹配，而是将其发表会议或期刊与 `ccf_venues` 匹配。仅 A/B/C 类结果进入论文库和 Agent 上下文。

## 可观测性与成本

每次 `/api/chat` 运行都会写入 `data/traces.jsonl`。一条 Trace 包含：

- `runId`、开始/结束时间、总耗时、成功或失败状态
- 模型名称、模型/MCP/Scholar 调用次数
- input、output、cache read/write 和总 Token
- 模型实际费用、SerpApi 估算费用和单次总成本
- 每个模型与工具 Span 的名称、状态和耗时
- Scholar 候选数、CCF 入选数和排除数
- Embedding 模型、当次新建向量数、Top-K 召回块数和向量检索耗时
- 记忆召回、写入、删除数量，以及 `memory.recall`、`memory.write` Span

页面中的“本次运行详情”可以展开查看关键指标和步骤耗时。最近运行也可以通过只读接口查看：

```sh
curl 'http://127.0.0.1:3220/api/runs?limit=10'
```

可通过 `PAPER_PULSE_TRACE_PATH` 修改 Trace 文件位置。Trace 不记录 API Key。

## Eval 与标准答案

普通单元测试只能证明代码按预期运行，不能证明检索和归纳质量。项目因此增加了版本化离线 Fixture：

- 10 个计算机子领域问题及人工指定的正确 CCF 领域
- 12 个真实/干扰发表来源及正确的 CCF 命中结果
- 2 组核心词、扩展词及期望 Scholar 检索式
- 2 组连续记忆行为，验证相关记忆召回和反馈重排

执行：

```sh
npm run eval
```

报告写入 `data/eval-latest.json`，输出领域准确率、来源匹配 Precision/Recall/F1、检索式通过率和记忆行为通过率。共 26 个固定标准答案样例，阈值为各项不低于 90%。这套离线 Eval 尚不能证明 Scholar 实时召回率和最终归纳忠实度；下一阶段需要人工标注的论文相关性集合，以及不与生成模型同源的 Judge Eval。

## 数据和测试

默认数据库位于 `data/paper-pulse.db`，已加入 `.gitignore`。可通过 `PAPER_PULSE_DB` 和 `PORT` 覆盖：

```sh
PAPER_PULSE_DB=/absolute/path/papers.db PORT=3221 npm run dev
```

运行测试：

```sh
npm test
```

当前测试覆盖文本切块、SQLite 向量持久化、余弦 Top-K 召回、CCF PDF 目录完整性、领域路由、期刊会议匹配、SQLite 去重、MCP 调用链、Trace 聚合与离线 Eval。它们与真实在线效果评测分开统计。

## 结果边界

- CCF 匹配由本地结构化知识库和确定性规则完成，不交给大模型临时判断。
- 按日期搜索并依次扩展到 CCF A/B/C，尽量补足 15 篇；严格过滤后不足时如实返回。
- Google Scholar 通常返回检索片段，不保证获得出版商提供的完整摘要。
- CCF 目录只回答“发表来源是否在目录”，不评价单篇论文质量。

## 部署与交付

服务提供 `/api/health` 健康检查。公开部署时设置 `HOST=0.0.0.0`、持久化 `data/`，并通过平台 Secret 注入模型凭证和 `SERPAPI_API_KEY`。具体清单见 [部署说明](docs/DEPLOY.md)。

项目复盘记录问题、决策、失败案例和下一阶段指标，见 [项目复盘](docs/RETROSPECTIVE.md)。

## 技术栈

TypeScript、Node.js、Pi Coding Agent SDK、Model Context Protocol、Transformers.js、MiniLM、SQLite、SerpApi、原生 HTML/CSS/JavaScript。

## License

[MIT](LICENSE)

## 当前边界

- Google Scholar 没有官方公共搜索 API；当前 Scholar MCP 内部使用 SerpApi，稳定性和配额受其套餐影响。
- Scholar 结果通常只有检索片段，Agent 的归纳结论不能替代全文阅读。
- 公开部署前还需要接入限流、访问认证和服务端 Secret 管理。
