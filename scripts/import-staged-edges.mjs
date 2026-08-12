#!/usr/bin/env node

/* Generic checkpointed importer for staged numeric-ID relationship JSONL. */
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checkpointDirectory = join(root, "data", "processed", "checkpoints");

function integer(value, name, zero = false) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (zero ? 0 : 1)) throw new Error(`${name} must be an integer.`);
  return number;
}

function options(args) {
  const out = { batchSize: 20_000, dryRun: false, graph: "music_kg", limit: 100, skip: 0 };
  let all = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i].trim().replace(/^[–—]/, "--");
    const next = () => { const value = args[++i]; if (value === undefined) throw new Error(`${arg} requires a value.`); return value.trim(); };
    if (arg === "--all") all = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--input") out.input = resolve(next());
    else if (arg === "--source-label") out.sourceLabel = next();
    else if (arg === "--target-label") out.targetLabel = next();
    else if (arg === "--name") out.name = next();
    else if (arg === "--source-id-property") out.sourceIdProperty = next();
    else if (arg === "--target-id-property") out.targetIdProperty = next();
    else if (arg === "--graph") out.graph = next();
    else if (arg === "--batch-size") out.batchSize = integer(next(), arg);
    else if (arg === "--limit") out.limit = integer(next(), arg);
    else if (arg === "--skip") out.skip = integer(next(), arg, true);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!out.input || !out.sourceLabel || !out.targetLabel || !out.name) throw new Error("--input, --source-label, --target-label, and --name are required.");
  if (out.batchSize > 20_000) throw new Error("--batch-size cannot exceed 20000.");
  if (all) out.limit = Infinity;
  return out;
}

async function save(name, state) {
  await mkdir(checkpointDirectory, { recursive: true });
  const path = join(checkpointDirectory, `${name}.json`);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  return path;
}

async function send(endpoint, config, edges) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      graph: config.graph,
      source_label: config.sourceLabel,
      target_label: config.targetLabel,
      source_id_property: config.sourceIdProperty,
      target_id_property: config.targetIdProperty,
      edges,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  const result = JSON.parse(text);
  if (result.edges_created !== edges.length || result.invalid_edge_indices?.length || result.missing_endpoint_indices?.length) {
    throw new Error(`Samyama did not confirm the complete batch: ${text}`);
  }
}

async function main() {
  const config = options(process.argv.slice(2));
  const endpoint = process.env.SAMYAMA_EDGE_URL ?? "http://localhost:8080/api/import/edges";
  const lines = createInterface({ input: createReadStream(config.input), crlfDelay: Infinity });
  const batch = [];
  const started = Date.now();
  let sourceRows = 0;
  let succeeded = 0;

  console.log(`Input: ${config.input}`);
  console.log(`Relationship: ${config.sourceLabel} -> ${config.targetLabel}`);
  console.log(`Mode: ${config.dryRun ? "dry run (Samyama will not change)" : "live import"}`);
  console.log(`Plan: skip ${config.skip.toLocaleString()}, import ${Number.isFinite(config.limit) ? config.limit.toLocaleString() : "all"}`);

  async function flush() {
    if (!batch.length) return;
    const sending = batch.splice(0);
    if (!config.dryRun) await send(endpoint, config, sending);
    succeeded += sending.length;
    await save(config.name, { ...config, sourceRows, succeeded, nextSkip: sourceRows, updatedAt: new Date().toISOString() });
  }

  for await (const line of lines) {
    sourceRows += 1;
    if (sourceRows <= config.skip) continue;
    const edge = JSON.parse(line);
    const hasNumericIds = Number.isSafeInteger(edge.source_node_id) && Number.isSafeInteger(edge.target_node_id);
    const hasExternalIds = Boolean(edge.source_id) && Boolean(edge.target_id)
      && Boolean(config.sourceIdProperty) && Boolean(config.targetIdProperty);
    if ((!hasNumericIds && !hasExternalIds) || !edge.relationship_type) {
      throw new Error(`Invalid edge at source row ${sourceRows}.`);
    }
    batch.push(edge);
    if (batch.length >= config.batchSize) await flush();
    if (succeeded + batch.length >= config.limit) break;
    if ((succeeded + batch.length) % 1_000_000 === 0) {
      const seconds = Math.max((Date.now() - started) / 1000, 0.001);
      console.log(`Prepared ${(succeeded + batch.length).toLocaleString()} | confirmed ${succeeded.toLocaleString()} | ${(succeeded / seconds).toFixed(0)} edges/s`);
    }
  }
  await flush();
  const seconds = Math.max((Date.now() - started) / 1000, 0.001);
  const path = await save(config.name, { ...config, sourceRows, succeeded, nextSkip: sourceRows, completed: true, elapsedSeconds: seconds });
  console.log(`Finished: ${succeeded.toLocaleString()} relationships ${config.dryRun ? "validated" : "imported"} in ${seconds.toFixed(1)}s.`);
  console.log(`Checkpoint: ${path}`);
}

main().catch(error => { console.error(`Edge import failed: ${error.message}`); process.exitCode = 1; });
