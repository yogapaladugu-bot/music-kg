#!/usr/bin/env node

/*
 * MUSICBRAINZ RELEASE-FAMILY IMPORTER
 * -----------------------------------
 * A MusicBrainz release line contains nested Medium and Track objects. This
 * program reads the 21 GB archive once and creates both kinds of graph nodes.
 * It deliberately does not recreate Release or Recording nodes, which were
 * imported separately. Relationship edges are a later, independently
 * checkpointed step.
 *
 * The program never holds the archive in memory. `tar` decompresses bytes,
 * readline supplies one Release at a time, and only two small JSON batches are
 * retained: one for Mediums and one for Tracks.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Resolve generated paths relative to the repository, not the caller's shell.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const checkpointDirectory = join(projectRoot, "data", "processed", "checkpoints");
const liveCheckpointPath = join(checkpointDirectory, "release-family.json");

function usage(exitCode = 0) {
  console.log(`MusicBrainz Medium + Track importer

Usage:
  node scripts/import-musicbrainz-release-family.mjs --input <release.tar.xz> [options]

Options:
  --input <path>          MusicBrainz release.tar.xz (required)
  --batch-size <number>  Nodes per HTTP request (default 5000, max 20000)
  --limit-releases <n>   Inspect only this many release rows (default 100)
  --all                   Read the complete archive
  --skip-mediums <n>      Already committed Medium candidates (default 0)
  --skip-tracks <n>       Already committed Track candidates (default 0)
  --dry-run               Validate and count without writing nodes
  --graph <name>          Graph name sent to Samyama (default music_kg)
  --help                  Show this help

Resume values are printed and saved after every confirmed batch.`);
  process.exit(exitCode);
}

// Reject decimals, negative values, and accidental text in numeric options.
function integer(value, option, allowZero = false) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseArguments(args) {
  const options = {
    batchSize: 5_000,
    dryRun: false,
    graph: "music_kg",
    limitReleases: 100,
    skipMediums: 0,
    skipTracks: 0,
  };
  let all = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index].trim().replace(/^[–—]/, "--");
    const next = () => {
      const value = args[++index];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      return value.trim();
    };
    if (argument === "--help") usage();
    else if (argument === "--all") all = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--input") options.input = resolve(next());
    else if (argument === "--graph") options.graph = next();
    else if (argument === "--batch-size") options.batchSize = integer(next(), argument);
    else if (argument === "--limit-releases") options.limitReleases = integer(next(), argument);
    else if (argument === "--skip-mediums") options.skipMediums = integer(next(), argument, true);
    else if (argument === "--skip-tracks") options.skipTracks = integer(next(), argument, true);
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (!options.input) throw new Error("--input is required.");
  if (!options.input.endsWith(".tar.xz")) throw new Error("Input must be a .tar.xz archive.");
  if (options.batchSize > 20_000) throw new Error("--batch-size cannot exceed 20000.");
  if (all) options.limitReleases = Infinity;
  return options;
}

// Empty values waste disk and make the UI harder to interpret, so omit them.
function compact(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) =>
    value !== null && value !== undefined && value !== ""
  ));
}

// Medium IDs are genuine MusicBrainz IDs. Parent MBIDs are retained now so
// the edge importer can connect Medium -> Release without reopening metadata.
function mediumNode(release, medium) {
  return compact({
    mbid: medium.id,
    title: medium.title,
    format: medium.format,
    position: medium.position,
    track_count: medium["track-count"],
    track_offset: medium["track-offset"],
    release_mbid: release.id,
    source: "MusicBrainz",
    source_entity: "medium",
  });
}

// A Track is an appearance on a Medium. recording_mbid allows a later edge to
// point at the underlying Recording while preserving edition-specific details.
function trackNode(release, medium, track) {
  return compact({
    mbid: track.id,
    title: track.title,
    number: track.number,
    position: track.position,
    length_ms: track.length,
    medium_mbid: medium.id,
    release_mbid: release.id,
    recording_mbid: track.recording?.id,
    source: "MusicBrainz",
    source_entity: "track",
  });
}

// Samyama's native JSON endpoint creates a complete batch with one label.
async function writeBatch(endpoint, graph, label, nodes) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graph, label, nodes }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text}`);
  let result;
  try { result = JSON.parse(text); }
  catch { throw new Error(`${label} endpoint returned non-JSON: ${text}`); }
  if (result.nodes_created !== nodes.length) {
    throw new Error(`${label} endpoint created ${result.nodes_created}; expected ${nodes.length}.`);
  }
}

// The two committed counters are independent. If power fails after a Medium
// batch but before a Track batch, a restart skips exactly what Samyama confirmed.
async function saveCheckpoint(state, completed = false, dryRun = false) {
  await mkdir(checkpointDirectory, { recursive: true });
  // A validation run must never overwrite the counters needed to resume a
  // real overnight import.
  const path = dryRun
    ? join(checkpointDirectory, "release-family-dry-run.json")
    : liveCheckpointPath;
  await writeFile(path, `${JSON.stringify({
    ...state,
    completed,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const endpoint = process.env.SAMYAMA_IMPORT_URL ?? "http://localhost:8080/api/import/json";
  const startedAt = Date.now();
  const mediumBatch = [];
  const trackBatch = [];
  let releaseRows = 0;
  let invalidReleases = 0;
  let invalidMediums = 0;
  let invalidTracks = 0;
  let mediumCandidates = 0;
  let trackCandidates = 0;
  let committedMediums = options.skipMediums;
  let committedTracks = options.skipTracks;
  let stoppedAtLimit = false;

  console.log(`Input: ${options.input} (mbdump/release)`);
  console.log(`Mode: ${options.dryRun ? "dry run" : "Samyama disk-first bulk import"}`);
  console.log(`Plan: ${Number.isFinite(options.limitReleases) ? `${options.limitReleases.toLocaleString()} release rows` : "all release rows"}`);
  console.log(`Resume: skip ${options.skipMediums.toLocaleString()} Mediums and ${options.skipTracks.toLocaleString()} Tracks`);

  // Save after every successful request. These values are safe to paste into a
  // resume command even if the process is interrupted immediately afterward.
  const checkpoint = () => saveCheckpoint({
    input: options.input,
    graph: options.graph,
    releaseRows,
    mediumCandidates,
    trackCandidates,
    committedMediums,
    committedTracks,
    invalidReleases,
    invalidMediums,
    invalidTracks,
    batchSize: options.batchSize,
  }, false, options.dryRun);

  async function flushMediums() {
    if (mediumBatch.length === 0 || options.dryRun) return;
    const nodes = mediumBatch.splice(0);
    await writeBatch(endpoint, options.graph, "Medium", nodes);
    committedMediums += nodes.length;
    await checkpoint();
  }

  async function flushTracks() {
    if (trackBatch.length === 0 || options.dryRun) return;
    const nodes = trackBatch.splice(0);
    await writeBatch(endpoint, options.graph, "Track", nodes);
    committedTracks += nodes.length;
    await checkpoint();
  }

  // tar writes only the JSONL member to stdout; stderr is retained for a useful
  // error if decompression or archive validation fails.
  const tar = spawn("tar", ["-xOJf", options.input, "mbdump/release"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tarError = "";
  tar.stderr.on("data", chunk => { tarError = `${tarError}${chunk}`.slice(-8_192); });
  const tarExit = new Promise(resolveExit => tar.once("close", resolveExit));
  const lines = createInterface({ input: tar.stdout, crlfDelay: Infinity });

  for await (const line of lines) {
    releaseRows += 1;
    let release;
    try {
      release = JSON.parse(line);
      if (!release.id || !Array.isArray(release.media)) throw new Error("missing id or media array");
    } catch {
      invalidReleases += 1;
      continue;
    }

    for (const medium of release.media) {
      if (!medium?.id) {
        invalidMediums += 1;
        continue;
      }
      mediumCandidates += 1;
      if (mediumCandidates > options.skipMediums) mediumBatch.push(mediumNode(release, medium));

      for (const track of Array.isArray(medium.tracks) ? medium.tracks : []) {
        if (!track?.id || !track.title) {
          invalidTracks += 1;
          continue;
        }
        trackCandidates += 1;
        if (trackCandidates > options.skipTracks) trackBatch.push(trackNode(release, medium, track));
        if (trackBatch.length >= options.batchSize) await flushTracks();
      }
      if (mediumBatch.length >= options.batchSize) await flushMediums();
    }

    if (releaseRows % 10_000 === 0) {
      const seconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
      const written = (committedMediums - options.skipMediums) + (committedTracks - options.skipTracks);
      console.log(`Releases ${releaseRows.toLocaleString()} | Mediums ${mediumCandidates.toLocaleString()} | Tracks ${trackCandidates.toLocaleString()} | written ${written.toLocaleString()} | ${(written / seconds).toFixed(0)} nodes/s`);
    }

    if (releaseRows >= options.limitReleases) {
      stoppedAtLimit = true;
      lines.close();
      tar.stdout.destroy();
      tar.kill("SIGTERM");
      break;
    }
  }

  // Commit the final partial arrays after the archive ends.
  await flushMediums();
  await flushTracks();
  const exitCode = await tarExit;
  if (!stoppedAtLimit && exitCode !== 0) {
    throw new Error(`tar exited with status ${exitCode}${tarError.trim() ? `: ${tarError.trim()}` : ""}`);
  }

  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
  await saveCheckpoint({
    input: options.input, graph: options.graph, releaseRows, mediumCandidates,
    trackCandidates, committedMediums, committedTracks, invalidReleases,
    invalidMediums, invalidTracks, batchSize: options.batchSize,
    elapsedSeconds,
  }, !stoppedAtLimit && !options.dryRun, options.dryRun);

  console.log(`Finished: ${releaseRows.toLocaleString()} Releases inspected.`);
  console.log(`Mediums: ${mediumCandidates.toLocaleString()}; Tracks: ${trackCandidates.toLocaleString()}.`);
  console.log(options.dryRun
    ? "Dry run only; Samyama was not changed."
    : `Committed ${committedMediums.toLocaleString()} Mediums and ${committedTracks.toLocaleString()} Tracks.`);
  console.log(`Checkpoint: ${options.dryRun ? join(checkpointDirectory, "release-family-dry-run.json") : liveCheckpointPath}`);
}

main().catch(error => {
  console.error(`Release-family import failed: ${error.message}`);
  process.exitCode = 1;
});
