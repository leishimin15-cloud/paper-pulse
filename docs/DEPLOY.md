# PaperPulse 部署说明

## 运行条件

- Node.js 22.19 或更高版本
- 可持久化写入的 `data/` 目录
- Pi 支持的模型凭证
- `SERPAPI_API_KEY`

## 环境变量

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `HOST` | 否 | 本地默认 `127.0.0.1`；容器或云平台使用 `0.0.0.0` |
| `PORT` | 否 | 默认 `3220` |
| `PAPER_PULSE_DB` | 否 | SQLite 文件绝对路径 |
| `PAPER_PULSE_TRACE_PATH` | 否 | JSONL Trace 文件绝对路径 |
| `SERPAPI_API_KEY` | 是 | 实时 Google Scholar 检索 |
| `SERPAPI_COST_PER_REQUEST_USD` | 否 | 当前套餐折算的单请求成本 |

密钥必须通过部署平台的 Secret 管理注入，不能写入镜像、仓库或前端环境变量。

## 启动命令

从项目目录执行：

```sh
npm ci --ignore-scripts
HOST=0.0.0.0 PORT=3220 npm run dev
```

健康检查：

```sh
curl http://127.0.0.1:3220/api/health
```

预期返回 `status: ok`、MCP 连接状态和当前运行数。

## 上线前检查

1. `npm run test` 与 `npm run eval` 均通过。
2. 为 `data/` 配置持久卷，并验证重启后 SQLite 和 Trace 仍存在。
3. 在反向代理层启用 HTTPS、请求体限制和 IP/用户限流。
4. 不公开 `/api/status` 中的本地路径信息；正式环境应删减诊断字段。
5. 设置模型与 SerpApi 的日预算告警。
6. 用 3–5 个真实问题完成冒烟测试，检查论文链接、CCF 匹配和归纳引用。

目前仓库只完成部署就绪配置，尚未绑定公开域名或云平台账户。
