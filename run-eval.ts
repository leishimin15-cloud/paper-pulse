import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOfflineEval } from "./eval.ts";

const root = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(process.env.PAPER_PULSE_EVAL_REPORT ?? resolve(root, "data", "eval-latest.json"));
const report = runOfflineEval();
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...report, outputPath }, null, 2));
if (!report.passed) process.exitCode = 1;
