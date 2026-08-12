#!/usr/bin/env node

/*
 * Resolve MusicBrainz MBIDs to Samyama's compact numeric NodeIds.
 *
 * Why this extra staging step exists:
 * - MusicBrainz relationships identify Artists with UUID-like MBID strings.
 * - Samyama stores relationship endpoints as small numeric NodeIds.
 * - Keeping a 2.95-million-entry MBID lookup inside Samyama used too much of
 *   Docker's memory and caused the server to be killed.
 * - This script performs that lookup outside the database once, writes the
 *   numeric IDs into a new staged file, and then releases the memory.
 *
 * NodeIds are predictable here because the JSON bulk importer creates valid
 * Artists sequentially, starting at zero, in archive order. Invalid JSON rows
 * are skipped by both this resolver and universal-importer.mjs.
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultArchive = join(projectRoot, "data", "raw", "artist.tar.xz");
const defaultInput = join(projectRoot, "data", "staged", "edges", "artist-relationships.jsonl");
const defaultOutput = join(projectRoot, "data", "staged", "edges", "artist-relationships-resolved.jsonl");

function usage(exitCode = 0) {
  console.log(`Resolve Artist edge MBIDs to Samyama NodeIds

Usage:
  node --max-old-space-size=4096 scripts/resolve-artist-edge-node-ids.mjs [options]

Options:
  --archive <path>  MusicBrainz artist.tar.xz
  --input <path>    Extracted Artist relationship JSONL
  --output <path>   Resolved relationship JSONL destination
  --help            Show this message`);
  process.exit(exitCode);
}

function parseArguments(argv) {
  const options = { archive: defaultArchive, input: defaultInput, output: defaultOutput };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      return resolve(value);
    };
    if (argument === "--help") usage();
    else if (argument === "--archive") options.archive = next();
    else if (argument === "--input") options.input = next();
    else if (argument === "--output") options.output = next();
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const mbidToNodeId = new Map();
  let sourceRows = 0;
  let validArtists = 0;
  let invalidArtists = 0;

  console.log(`Building MBID map from ${options.archive}`);
  const archive = spawn("tar", ["-xOJf", options.archive, "mbdump/artist"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const artistLines = createInterface({ input: archive.stdout, crlfDelay: Infinity });

  for await (const line of artistLines) {
    sourceRows += 1;
    try {
      const artist = JSON.parse(line);
      if (!artist.id || !artist.name) throw new Error("missing id or name");
      // Samyama starts NodeIds at 1 (not 0), so the first valid Artist is node 1.
      // Keeping this exactly aligned with insertion order is what lets the edge
      // importer connect relationships without storing millions of MBIDs in RAM.
      mbidToNodeId.set(artist.id, validArtists + 1);
      validArtists += 1;
    } catch {
      invalidArtists += 1;
    }
    if (sourceRows % 250_000 === 0) {
      console.log(`Artists scanned ${sourceRows.toLocaleString()} | mapped ${validArtists.toLocaleString()}`);
    }
  }

  const archiveExit = await new Promise((resolveExit) => archive.once("close", resolveExit));
  if (archiveExit !== 0) throw new Error(`tar exited with status ${archiveExit}.`);

  await mkdir(dirname(options.output), { recursive: true });
  const output = createWriteStream(options.output, { flags: "w" });
  const edgeLines = createInterface({ input: createReadStream(options.input), crlfDelay: Infinity });
  let edgeRows = 0;
  let resolvedEdges = 0;
  let missingEndpoints = 0;

  console.log(`Resolving edges from ${options.input}`);
  for await (const line of edgeLines) {
    edgeRows += 1;
    const edge = JSON.parse(line);
    const sourceNodeId = mbidToNodeId.get(edge.source_mbid);
    const targetNodeId = mbidToNodeId.get(edge.target_mbid);
    if (sourceNodeId === undefined || targetNodeId === undefined) {
      missingEndpoints += 1;
      continue;
    }

    const resolvedEdge = {
      ...edge,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
    };
    if (!output.write(`${JSON.stringify(resolvedEdge)}\n`)) await once(output, "drain");
    resolvedEdges += 1;
    if (resolvedEdges % 100_000 === 0) {
      console.log(`Edges resolved ${resolvedEdges.toLocaleString()} | missing ${missingEndpoints.toLocaleString()}`);
    }
  }

  output.end();
  await once(output, "finish");
  console.log(`Finished: ${validArtists.toLocaleString()} Artists mapped, ${invalidArtists} invalid Artist rows.`);
  console.log(`Edges: ${resolvedEdges.toLocaleString()} resolved, ${missingEndpoints.toLocaleString()} missing endpoints.`);
  console.log(`Resolved file: ${options.output}`);
}

main().catch((error) => {
  console.error(`NodeId resolution failed: ${error.message}`);
  process.exitCode = 1;
});
