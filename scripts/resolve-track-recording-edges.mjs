#!/usr/bin/env node

/*
 * RESOLVE TRACK -> RECORDING EDGE ENDPOINTS
 * ----------------------------------------
 * Input rows contain `recording MBID<TAB>track numeric ID`. This script asks
 * the operating-system sort utility to order those rows by MBID, then performs
 * a streaming merge with the already sorted unique Recording JSONL file.
 * Only the current row from each file stays in RAM.
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultInput = join(projectRoot, "data", "staged", "edges", "track-recording-unresolved.tsv");
const defaultRecordings = join(projectRoot, "data", "staged", "nodes", "recordings-from-releases.jsonl");
const defaultOutput = join(projectRoot, "data", "staged", "edges", "track-recording.jsonl");
const defaultSortDirectory = join(projectRoot, "data", "staged", "sort-temp", "track-recording");

// Embedded unique Recordings were imported immediately after node 79,773,334.
const RECORDING_FIRST_ID = 79_773_335;

function parseArguments(args) {
  const options = {
    input: defaultInput,
    recordings: defaultRecordings,
    output: defaultOutput,
    sortDirectory: defaultSortDirectory,
    reuseSorted: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index].trim().replace(/^[–—]/, "--");
    const next = () => {
      const value = args[++index];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      return resolve(value.trim());
    };
    if (argument === "--reuse-sorted") options.reuseSorted = true;
    else if (argument === "--input") options.input = next();
    else if (argument === "--recordings") options.recordings = next();
    else if (argument === "--output") options.output = next();
    else if (argument === "--sort-dir") options.sortDirectory = next();
    else if (argument === "--help") {
      console.log("Usage: node scripts/resolve-track-recording-edges.mjs [--reuse-sorted] [--input path] [--recordings path] [--output path] [--sort-dir path]");
      process.exit(0);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

async function writeSafely(stream, line) {
  if (!stream.write(line)) await new Promise(resolveDrain => stream.once("drain", resolveDrain));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.sortDirectory, { recursive: true });
  const sortedInputPath = join(options.sortDirectory, "track-recording-sorted.tsv");

  console.log(`Unresolved edges: ${options.input}`);
  console.log(`Sorted Recordings: ${options.recordings}`);
  console.log(`Final edges: ${options.output}`);
  console.log("Phase 1: external disk sort by Recording MBID...");

  // LC_ALL=C guarantees bytewise UUID ordering, matching JavaScript's ordering
  // for ASCII UUIDs and avoiding language-specific collation surprises.
  if (!options.reuseSorted) {
    const sorter = spawn("sort", ["-t", "\t", "-k1,1", "-T", options.sortDirectory, "-o", sortedInputPath, options.input], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
    let sortError = "";
    sorter.stderr.on("data", chunk => { sortError = `${sortError}${chunk}`.slice(-8_192); });
    const sortCode = await new Promise(resolveExit => sorter.once("close", resolveExit));
    if (sortCode !== 0) throw new Error(`sort exited ${sortCode}: ${sortError.trim()}`);
  } else {
    console.log(`Reusing completed sorted file: ${sortedInputPath}`);
  }
  // The Recording staging file is already sorted by MBID. Its line number maps
  // directly to the sequential Samyama ID assigned during the final node import.
  const recordingLines = createInterface({
    input: createReadStream(options.recordings),
    crlfDelay: Infinity,
  });
  const recordingIterator = recordingLines[Symbol.asyncIterator]();
  let recordingLineNumber = 0;
  let currentRecording = null;
  let recordingsExhausted = false;

  async function advanceRecording() {
    if (recordingsExhausted) {
      currentRecording = null;
      return;
    }
    let next;
    try {
      next = await recordingIterator.next();
    } catch (error) {
      // Node's readline iterator may report its natural EOF as "readline was
      // closed" when another sorted edge asks to advance beyond the last row.
      if (error?.code !== "ERR_USE_AFTER_CLOSE" && !String(error?.message).includes("readline was closed")) throw error;
      recordingsExhausted = true;
      currentRecording = null;
      return;
    }
    if (next.done) {
      recordingsExhausted = true;
      currentRecording = null;
      return;
    }
    recordingLineNumber += 1;
    const record = JSON.parse(next.value);
    currentRecording = {
      mbid: record.id,
      nodeId: RECORDING_FIRST_ID + recordingLineNumber - 1,
    };
  }

  await advanceRecording();
  const output = createWriteStream(options.output);
  const startedAt = Date.now();
  let inspected = 0;
  let resolved = 0;
  let missing = 0;

  console.log("Phase 2: streaming merge and numeric edge creation...");
  // Create this reader only when we are ready to consume it. readline streams
  // begin flowing immediately, so constructing it before the Recording reader
  // was initialized could discard early lines in a tiny/fast test file.
  const sortedEdges = createInterface({
    input: createReadStream(sortedInputPath),
    crlfDelay: Infinity,
  });
  for await (const line of sortedEdges) {
    inspected += 1;
    const separator = line.indexOf("\t");
    if (separator === -1) {
      missing += 1;
      continue;
    }
    const recordingMbid = line.slice(0, separator);
    const trackNodeId = Number(line.slice(separator + 1));

    // Move forward through the Recording address book until its MBID catches up
    // to the current sorted edge. Neither input ever needs to move backward.
    while (currentRecording && currentRecording.mbid < recordingMbid) {
      await advanceRecording();
    }

    if (!currentRecording || currentRecording.mbid !== recordingMbid || !Number.isSafeInteger(trackNodeId)) {
      missing += 1;
      continue;
    }

    const edge = {
      source_node_id: trackNodeId,
      target_node_id: currentRecording.nodeId,
      relationship_type: "REPRESENTS_RECORDING",
      properties: { data_source: "MusicBrainz" },
    };
    await writeSafely(output, `${JSON.stringify(edge)}\n`);
    resolved += 1;

    if (inspected % 1_000_000 === 0) {
      const seconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
      console.log(`Inspected ${inspected.toLocaleString()} | resolved ${resolved.toLocaleString()} | missing ${missing.toLocaleString()} | ${(resolved / seconds).toFixed(0)} edges/s`);
    }
  }

  await new Promise((resolveFinish, rejectFinish) => {
    output.once("finish", resolveFinish);
    output.once("error", rejectFinish);
    output.end();
  });
  console.log(`Finished: ${inspected.toLocaleString()} inspected, ${resolved.toLocaleString()} resolved, ${missing.toLocaleString()} missing.`);
  console.log(`Final staged file: ${options.output}`);
  if (missing > 0) process.exitCode = 2;
}

main().catch(error => {
  console.error(`Track/Recording resolution failed: ${error.message}`);
  process.exitCode = 1;
});
