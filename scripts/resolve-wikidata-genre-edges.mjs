#!/usr/bin/env node

/* Convert staged Wikidata QID relationships into Samyama numeric NodeIds.
 *
 * The clean Genre file is imported sequentially with no invalid records, so
 * its first line receives `firstNodeId`, its second line receives the next ID,
 * and so on. The resulting edge file avoids a large server-side QID cache.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      return value;
    };
    if (argument === "--nodes") options.nodes = resolve(next());
    else if (argument === "--edges") options.edges = resolve(next());
    else if (argument === "--output") options.output = resolve(next());
    else if (argument === "--first-node-id") options.firstNodeId = Number(next());
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.nodes || !options.edges || !options.output) {
    throw new Error("--nodes, --edges, and --output are required.");
  }
  if (!Number.isSafeInteger(options.firstNodeId) || options.firstNodeId < 1) {
    throw new Error("--first-node-id must be a positive safe integer.");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const qidToNodeId = new Map();
  const nodeLines = createInterface({ input: createReadStream(options.nodes), crlfDelay: Infinity });
  let nodeCount = 0;

  for await (const line of nodeLines) {
    if (!line.trim()) continue;
    const node = JSON.parse(line);
    if (!node.qid) throw new Error(`Genre row ${nodeCount + 1} has no QID.`);
    if (qidToNodeId.has(node.qid)) throw new Error(`Duplicate staged QID: ${node.qid}`);
    qidToNodeId.set(node.qid, options.firstNodeId + nodeCount);
    nodeCount += 1;
  }

  const output = createWriteStream(options.output);
  const edgeLines = createInterface({ input: createReadStream(options.edges), crlfDelay: Infinity });
  let edgeCount = 0;
  let missing = 0;
  let minimumNodeId = Infinity;
  let maximumNodeId = 0;

  for await (const line of edgeLines) {
    if (!line.trim()) continue;
    const edge = JSON.parse(line);
    const sourceNodeId = qidToNodeId.get(edge.source_id);
    const targetNodeId = qidToNodeId.get(edge.target_id);
    if (sourceNodeId === undefined || targetNodeId === undefined) {
      missing += 1;
      continue;
    }
    minimumNodeId = Math.min(minimumNodeId, sourceNodeId, targetNodeId);
    maximumNodeId = Math.max(maximumNodeId, sourceNodeId, targetNodeId);
    const resolved = {
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      relationship_type: edge.relationship_type,
      properties: edge.properties,
    };
    if (!output.write(`${JSON.stringify(resolved)}\n`)) await once(output, "drain");
    edgeCount += 1;
  }
  output.end();
  await once(output, "finish");

  console.log(`Genre nodes mapped: ${nodeCount.toLocaleString()}`);
  console.log(`Relationships resolved: ${edgeCount.toLocaleString()}`);
  console.log(`Relationships missing endpoints: ${missing.toLocaleString()}`);
  console.log(`Numeric endpoint range: ${minimumNodeId.toLocaleString()}–${maximumNodeId.toLocaleString()}`);
  console.log(`Output: ${options.output}`);
}

main().catch(error => {
  console.error(`Genre edge resolution failed: ${error.message}`);
  process.exitCode = 1;
});
