#!/usr/bin/env node

// PURPOSE
// -------
// This script imports the JSONL produced by extract-musicbrainz-artist-edges.mjs.
// It groups work into bounded buffers and sends them to a native bulk endpoint.
// Stock Samyama 1.1.0 cannot execute MATCH...CREATE/MERGE edge writes through
// its HTTP query route. Our /api/import/edges extension bypasses that Cypher bug,
// writes under mutable store access, and skips existing endpoint/type triples.

// createReadStream reads a large staging file without loading it all into memory.
import { createReadStream, createWriteStream } from "node:fs";
// mkdir and writeFile create the diagnostic/checkpoint files used for safe restarts.
import { mkdir, writeFile } from "node:fs/promises";
// Path helpers keep generated report locations consistent across operating systems.
import { dirname, join, resolve } from "node:path";
// readline provides one staged relationship object at a time.
import { createInterface } from "node:readline";
// fileURLToPath finds the repository from this module's own location.
import { fileURLToPath } from "node:url";
// once lets failure-file writes wait when the disk stream applies backpressure.
import { once } from "node:events";

// Move from scripts/ to the project root.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// This is the extractor's default output and therefore this importer's default input.
const defaultInput = join(projectRoot, "data", "staged", "edges", "artist-relationships.jsonl");
// Checkpoints record only source rows whose preceding batches have all been flushed.
const checkpointDirectory = join(projectRoot, "data", "processed", "checkpoints");
// Missing endpoints are data-quality facts worth preserving for later investigation.
const defaultFailurePath = join(projectRoot, "data", "processed", "artist-edge-missing-endpoints.jsonl");

// Print beginner-friendly command documentation and stop.
function usage(exitCode = 0) {
  console.log(`Import staged MusicBrainz Artist relationships

Usage:
  node scripts/import-musicbrainz-artist-edges.mjs [options]

Options:
  --input <path>       Staged relationship JSONL file
  --graph <name>       Samyama graph (default: music_kg)
  --skip <number>      Skip staged edge rows (default: 0)
  --limit <number>     Process this many valid edges (default: 100)
  --all                Process every remaining edge
  --batch-size <n>     Edges per native request (default: 5000, maximum: 20000)
  --dry-run            Validate edge records without changing Samyama
  --help               Show this message

Examples:
  node scripts/import-musicbrainz-artist-edges.mjs --limit 100 --dry-run
  node scripts/import-musicbrainz-artist-edges.mjs --limit 100
  node scripts/import-musicbrainz-artist-edges.mjs --skip 100 --all`);
  process.exit(exitCode);
}

// Convert an option into a safe whole number.
function integerOption(value, option, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

// Parse terminal arguments with safe, small defaults.
function parseArguments(argv) {
  const options = {
    batchSize: 5_000,
    dryRun: false,
    graph: "music_kg",
    input: defaultInput,
    limit: 100,
    skip: 0,
  };
  let processEverything = false;

  for (let index = 0; index < argv.length; index += 1) {
    // Handle accidental surrounding whitespace and smart dashes from copied commands.
    const argument = argv[index].trim().replace(/^[–—]/, "--");
    const nextValue = () => {
      const value = argv[++index]?.trim();
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      return value;
    };

    if (argument === "--help") usage();
    else if (argument === "--all") processEverything = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--input") options.input = resolve(nextValue());
    else if (argument === "--graph") options.graph = nextValue();
    else if (argument === "--skip") options.skip = integerOption(nextValue(), argument, { allowZero: true });
    else if (argument === "--limit") options.limit = integerOption(nextValue(), argument);
    else if (argument === "--batch-size") options.batchSize = integerOption(nextValue(), argument);
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (processEverything) options.limit = Infinity;
  // Buffers are bounded so checkpoints remain frequent and memory use stays predictable.
  if (options.batchSize > 20_000) throw new Error("--batch-size cannot exceed 20000.");
  if (!options.graph.trim()) throw new Error("--graph cannot be empty.");
  return options;
}

// Relationship types become Cypher syntax, not quoted values, so validation must be strict.
function validRelationshipType(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value);
}

// Send one native JSON request containing many edges. This endpoint holds the
// mutable graph lock once and bypasses the broken Cypher edge-write operators.
async function runBatch(endpoint, graph, type, edges) {
  const nativeEndpoint = new URL("/api/import/edges", endpoint).toString();
  const response = await fetch(nativeEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      graph,
      source_label: "Artist",
      target_label: "Artist",
      source_id_property: "mbid",
      target_id_property: "mbid",
      edges: edges.map((edge) => ({
        source_node_id: edge.source_node_id,
        target_node_id: edge.target_node_id,
        source_id: edge.source_mbid,
        target_id: edge.target_mbid,
        relationship_type: type,
        properties: {
          edge_key: edge.edge_key,
          musicbrainz_type: edge.musicbrainz_type,
          musicbrainz_type_id: edge.musicbrainz_type_id,
          begin_date: edge.begin_date,
          end_date: edge.end_date,
          ended: edge.ended === true,
          attributes: edge.attributes,
          source_credit: edge.source_credit,
          target_credit: edge.target_credit,
          data_source: edge.data_source ?? "MusicBrainz",
        },
      })),
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);

  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error(`Samyama returned non-JSON batch response: ${body}`);
  }
  if (result.status !== "ok" || result.received !== edges.length) {
    throw new Error(`Samyama returned an incomplete native edge response: ${body}`);
  }
  const rejected = new Set([
    ...(result.missing_endpoint_indices ?? []),
    ...(result.invalid_edge_indices ?? []),
  ]);
  const results = edges.map((_, index) => !rejected.has(index));
  return results;
}

// Save a checkpoint only after all buffered types have been committed.
async function saveCheckpoint(checkpoint, dryRun) {
  await mkdir(checkpointDirectory, { recursive: true });
  const path = join(checkpointDirectory, `artist-edges${dryRun ? "-dry-run" : ""}.json`);
  await writeFile(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return path;
}

// Respect output-stream backpressure while recording a missing endpoint.
async function writeFailure(output, edge) {
  if (!output.write(`${JSON.stringify(edge)}\n`)) await once(output, "drain");
}

// main handles validation, grouping, bounded writes, diagnostics, and safe resume positions.
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const endpoint = process.env.SAMYAMA_URL ?? "http://localhost:8080/api/query";
  const lines = createInterface({ input: createReadStream(options.input), crlfDelay: Infinity });
  const buffers = new Map();
  const startedAt = Date.now();
  let sourceRows = 0;
  let validEdges = 0;
  let matchedEdges = 0;
  let missingEndpoints = 0;
  let invalidRows = 0;
  let committedSourceRows = options.skip;
  let failureOutput = null;

  if (!options.dryRun) {
    await mkdir(dirname(defaultFailurePath), { recursive: true });
    // Replace the previous diagnostic file for a fresh import run.
    failureOutput = createWriteStream(defaultFailurePath, { flags: "w" });
  }

  console.log(`Input: ${options.input}`);
  console.log(`Mode: ${options.dryRun ? "dry run" : `Samyama graph ${options.graph}`}`);
  console.log(`Plan: skip ${options.skip.toLocaleString()}, process ${Number.isFinite(options.limit) ? options.limit.toLocaleString() : "all"} edges, native batch ${options.batchSize}`);
  if (!options.dryRun) console.log("Writer: native /api/import/edges (retry-safe endpoint/type deduplication)");

  // Each result corresponds to its input edge, so missing endpoints can be
  // reported exactly without retrying successful relationships.
  async function importWithDiagnostics(type, edges) {
    if (edges.length === 0) return;
    const results = await runBatch(endpoint, options.graph, type, edges);
    for (let index = 0; index < results.length; index += 1) {
      if (results[index]) {
        matchedEdges += 1;
      } else {
        missingEndpoints += 1;
        await writeFailure(failureOutput, {
          reason: "source or target Artist MBID was not found",
          ...edges[index],
        });
      }
    }
  }

  // Flush every relationship-type buffer; afterward every source row read so far is safe to checkpoint.
  async function flushAllBuffers() {
    if (options.dryRun) return;
    for (const [type, edges] of buffers) {
      if (edges.length === 0) continue;
      await importWithDiagnostics(type, edges.splice(0, edges.length));
    }
    committedSourceRows = sourceRows;
  }

  for await (const line of lines) {
    sourceRows += 1;
    if (sourceRows <= options.skip) continue;

    let edge;
    try {
      edge = JSON.parse(line);
      if (!edge.source_mbid || !edge.target_mbid || !edge.edge_key) throw new Error("missing endpoint MBID or edge_key");
      if (!validRelationshipType(edge.relationship_type)) throw new Error(`unsafe relationship type ${edge.relationship_type}`);
    } catch (error) {
      invalidRows += 1;
      console.error(`Invalid staged edge row ${sourceRows}: ${error.message}`);
      continue;
    }

    validEdges += 1;
    if (options.dryRun && validEdges <= 3) {
      console.log(`Validated: ${edge.source_mbid} -[:${edge.relationship_type}]-> ${edge.target_mbid}`);
    }

    if (!options.dryRun) {
      const buffer = buffers.get(edge.relationship_type) ?? [];
      buffer.push(edge);
      buffers.set(edge.relationship_type, buffer);
      // Flush a full single-type buffer without waiting for unrelated relationship types.
      if (buffer.length >= options.batchSize) {
        await importWithDiagnostics(edge.relationship_type, buffer.splice(0, buffer.length));
      }
    }

    // Flush everything at reporting boundaries so nextSkip never moves past uncommitted buffered edges.
    if (validEdges % 10_000 === 0) {
      await flushAllBuffers();
      const elapsed = Math.max((Date.now() - startedAt) / 1_000, 0.001);
      console.log(`Valid ${validEdges.toLocaleString()} | matched ${matchedEdges.toLocaleString()} | missing ${missingEndpoints.toLocaleString()} | ${(matchedEdges / elapsed).toFixed(1)} edges/s`);
      await saveCheckpoint({
        input: options.input,
        graph: options.graph,
        sourceRows,
        validEdges,
        matchedEdges,
        missingEndpoints,
        invalidRows,
        nextSkip: options.dryRun ? sourceRows : committedSourceRows,
        updatedAt: new Date().toISOString(),
      }, options.dryRun);
    }

    if (validEdges >= options.limit) {
      lines.close();
      break;
    }
  }

  await flushAllBuffers();
  if (failureOutput) {
    failureOutput.end();
    await once(failureOutput, "finish");
  }

  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
  const checkpointPath = await saveCheckpoint({
    input: options.input,
    graph: options.graph,
    sourceRows,
    validEdges,
    matchedEdges,
    missingEndpoints,
    invalidRows,
    nextSkip: options.dryRun ? sourceRows : committedSourceRows,
    elapsedSeconds,
    edgesPerSecond: matchedEdges / elapsedSeconds,
    completedAt: new Date().toISOString(),
  }, options.dryRun);

  const action = options.dryRun ? `${validEdges.toLocaleString()} validated; Samyama was not changed` : `${matchedEdges.toLocaleString()} matched/imported`;
  console.log(`Finished: ${action}, ${missingEndpoints.toLocaleString()} missing endpoints, ${invalidRows.toLocaleString()} invalid rows.`);
  console.log(`Checkpoint: ${checkpointPath}`);
  if (failureOutput) console.log(`Missing endpoint report: ${defaultFailurePath}`);
  if (missingEndpoints > 0 || invalidRows > 0) process.exitCode = 2;
}

// Turn unexpected failures into a concise message and nonzero process status.
main().catch((error) => {
  console.error(`Artist edge import failed: ${error.message}`);
  process.exitCode = 1;
});
