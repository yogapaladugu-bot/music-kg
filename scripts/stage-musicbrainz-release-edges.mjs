#!/usr/bin/env node

/*
 * STAGE THE RELEASE -> MEDIUM -> TRACK -> RECORDING GRAPH
 * ------------------------------------------------------
 * Samyama assigns numeric node IDs in the exact order that confirmed node
 * batches arrive. The earlier import checkpoints give us the starting ID, and
 * this script repeats the release-family batching order to reconstruct every
 * Medium and Track ID without loading a 119-million-row lookup table into RAM.
 *
 * Track -> Recording edges are first written as `recording MBID<TAB>track ID`.
 * A separate disk-sort/merge step resolves those MBIDs against the already
 * sorted unique Recording file.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultOutputDirectory = join(projectRoot, "data", "staged", "edges");

// These ranges come from the verified import order in docs/SCHEMA.md.
const RELEASE_FIRST_ID = 10_694_238;
const RELEASE_FAMILY_FIRST_ID = 16_376_914;
const FAMILY_BATCH_SIZE = 5_000;

function usage(exitCode = 0) {
  console.log(`Stage MusicBrainz Release-family relationships

Usage:
  node scripts/stage-musicbrainz-release-edges.mjs --input <release.tar.xz> [options]

Options:
  --input <path>          MusicBrainz release.tar.xz (required)
  --output-dir <path>     Staged edge directory
  --limit-releases <n>   Test only this many source rows (default 100)
  --all                   Process the complete archive
  --help                  Show this help`);
  process.exit(exitCode);
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer.`);
  return parsed;
}

function parseArguments(args) {
  const options = { limitReleases: 100, outputDirectory: defaultOutputDirectory };
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
    else if (argument === "--input") options.input = resolve(next());
    else if (argument === "--output-dir") options.outputDirectory = resolve(next());
    else if (argument === "--limit-releases") options.limitReleases = positiveInteger(next(), argument);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.input) throw new Error("--input is required.");
  if (all) options.limitReleases = Infinity;
  return options;
}

async function writeSafely(stream, line) {
  if (!stream.write(line)) await new Promise(resolveDrain => stream.once("drain", resolveDrain));
}

function edgeLine(source, target, type, properties = {}) {
  return `${JSON.stringify({
    source_node_id: source,
    target_node_id: target,
    relationship_type: type,
    properties: { data_source: "MusicBrainz", ...properties },
  })}\n`;
}

async function finishStream(stream) {
  await new Promise((resolveFinish, rejectFinish) => {
    stream.once("finish", resolveFinish);
    stream.once("error", rejectFinish);
    stream.end();
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await mkdir(options.outputDirectory, { recursive: true });

  const releaseMediumPath = join(options.outputDirectory, "release-medium.jsonl");
  const mediumTrackPath = join(options.outputDirectory, "medium-track.jsonl");
  const trackRecordingPath = join(options.outputDirectory, "track-recording-unresolved.tsv");
  const releaseMedium = createWriteStream(releaseMediumPath);
  const mediumTrack = createWriteStream(mediumTrackPath);
  const trackRecording = createWriteStream(trackRecordingPath);

  console.log(`Input: ${options.input} (mbdump/release)`);
  console.log(`Output directory: ${options.outputDirectory}`);
  console.log(`Plan: ${Number.isFinite(options.limitReleases) ? `${options.limitReleases.toLocaleString()} rows` : "complete archive"}`);

  let nextReleaseId = RELEASE_FIRST_ID;
  let nextFamilyId = RELEASE_FAMILY_FIRST_ID;
  let sourceRows = 0;
  let validReleases = 0;
  let invalidReleaseRows = 0;
  let releaseMediumEdges = 0;
  let mediumTrackEdges = 0;
  let unresolvedTrackRecordingEdges = 0;
  let stoppedAtLimit = false;
  const mediumBatch = [];
  const trackBatch = [];

  // An edge can be emitted only after both objects receive their reconstructed
  // numeric IDs. The `emitted` flag prevents the two batch flushes from writing
  // the same Medium -> Track edge twice.
  async function emitTrackIfReady(track) {
    if (track.emitted || track.nodeId === undefined || track.medium.nodeId === undefined) return;
    await writeSafely(mediumTrack, edgeLine(
      track.medium.nodeId,
      track.nodeId,
      "CONTAINS_TRACK",
      { position: track.position ?? 0, number: track.number ?? "" },
    ));
    track.emitted = true;
    mediumTrackEdges += 1;
  }

  async function flushTracks() {
    if (trackBatch.length === 0) return;
    const batch = trackBatch.splice(0);
    for (const track of batch) {
      track.nodeId = nextFamilyId++;
      await writeSafely(trackRecording, `${track.recordingMbid}\t${track.nodeId}\n`);
      unresolvedTrackRecordingEdges += 1;
      await emitTrackIfReady(track);
    }
  }

  async function flushMediums() {
    if (mediumBatch.length === 0) return;
    const batch = mediumBatch.splice(0);
    for (const medium of batch) {
      medium.nodeId = nextFamilyId++;
      if (medium.releaseNodeId !== undefined) {
        await writeSafely(releaseMedium, edgeLine(
          medium.releaseNodeId,
          medium.nodeId,
          "CONTAINS_MEDIUM",
          { position: medium.position ?? 0, format: medium.format ?? "" },
        ));
        releaseMediumEdges += 1;
      }
      for (const track of medium.tracks) await emitTrackIfReady(track);
    }
  }

  const tar = spawn("tar", ["-xOJf", options.input, "mbdump/release"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tarError = "";
  tar.stderr.on("data", chunk => { tarError = `${tarError}${chunk}`.slice(-8_192); });
  const tarExit = new Promise(resolveExit => tar.once("close", resolveExit));
  const lines = createInterface({ input: tar.stdout, crlfDelay: Infinity });
  const startedAt = Date.now();

  for await (const line of lines) {
    sourceRows += 1;
    let release;
    try { release = JSON.parse(line); }
    catch {
      invalidReleaseRows += 1;
      continue;
    }

    // The ordinary Release importer assigned IDs only to rows having both a
    // stable ID and a title. Repeating that validation reconstructs its ID.
    let releaseNodeId;
    if (release.id && release.title) {
      releaseNodeId = nextReleaseId++;
      validReleases += 1;
    }

    // The family importer required an ID and media array before visiting any
    // nested objects. Match that exact rule to reproduce its allocation order.
    if (release.id && Array.isArray(release.media)) {
      for (const sourceMedium of release.media) {
        if (!sourceMedium?.id) continue;
        const medium = {
          format: sourceMedium.format,
          position: sourceMedium.position,
          releaseNodeId,
          tracks: [],
        };
        mediumBatch.push(medium);

        for (const sourceTrack of Array.isArray(sourceMedium.tracks) ? sourceMedium.tracks : []) {
          if (!sourceTrack?.id || !sourceTrack.title) continue;
          const recordingMbid = sourceTrack.recording?.id;
          if (!recordingMbid) continue;
          const track = {
            emitted: false,
            medium,
            number: sourceTrack.number,
            position: sourceTrack.position,
            recordingMbid,
          };
          medium.tracks.push(track);
          trackBatch.push(track);
          if (trackBatch.length >= FAMILY_BATCH_SIZE) await flushTracks();
        }
        if (mediumBatch.length >= FAMILY_BATCH_SIZE) await flushMediums();
      }
    }

    if (sourceRows % 10_000 === 0) {
      const seconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
      console.log(`Releases ${sourceRows.toLocaleString()} | release-medium ${releaseMediumEdges.toLocaleString()} | medium-track ${mediumTrackEdges.toLocaleString()} | ${(mediumTrackEdges / seconds).toFixed(0)} track edges/s`);
    }

    if (sourceRows >= options.limitReleases) {
      stoppedAtLimit = true;
      lines.close();
      tar.stdout.destroy();
      tar.kill("SIGTERM");
      break;
    }
  }

  // This order is deliberately identical to import-musicbrainz-release-family:
  // final Medium nodes were allocated before the final partial Track batch.
  await flushMediums();
  await flushTracks();
  // The Track flush may have completed edges whose Medium IDs already existed.
  for (const medium of mediumBatch) for (const track of medium.tracks) await emitTrackIfReady(track);

  const tarCode = await tarExit;
  if (!stoppedAtLimit && tarCode !== 0) throw new Error(`tar exited ${tarCode}: ${tarError.trim()}`);
  await Promise.all([
    finishStream(releaseMedium),
    finishStream(mediumTrack),
    finishStream(trackRecording),
  ]);

  const seconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
  console.log(`Finished in ${seconds.toFixed(1)}s: ${sourceRows.toLocaleString()} source rows, ${validReleases.toLocaleString()} valid Releases.`);
  console.log(`Release->Medium: ${releaseMediumEdges.toLocaleString()}`);
  console.log(`Medium->Track: ${mediumTrackEdges.toLocaleString()}`);
  console.log(`Track->Recording unresolved: ${unresolvedTrackRecordingEdges.toLocaleString()}`);
  console.log(`Next reconstructed family node ID: ${nextFamilyId.toLocaleString()}`);
  console.log(`Files: ${releaseMediumPath}, ${mediumTrackPath}, ${trackRecordingPath}`);
}

main().catch(error => {
  console.error(`Release edge staging failed: ${error.message}`);
  process.exitCode = 1;
});
