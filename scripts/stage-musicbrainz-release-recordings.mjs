#!/usr/bin/env node

/*
 * STAGE UNIQUE RECORDINGS EMBEDDED IN MUSICBRAINZ RELEASES
 * -------------------------------------------------------
 * One Recording may appear as a Track on many Releases. Importing every
 * appearance would create false duplicate Recording nodes, so this script:
 *
 *   release.tar.xz -> stream JSON -> `MBID<TAB>record` rows -> disk sort
 *                  -> one row per MBID -> ordinary JSONL
 *
 * `sort` is intentionally used instead of a JavaScript Set: tens of millions
 * of UUID strings would overflow laptop RAM, while sort can spill safely to
 * the 562 GB of available disk space.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const stagedDirectory = join(projectRoot, "data", "staged", "nodes");
const sortDirectory = join(projectRoot, "data", "staged", "sort-temp");
const defaultOutput = join(stagedDirectory, "recordings-from-releases.jsonl");

function usage(exitCode = 0) {
  console.log(`Stage unique MusicBrainz Recordings from release.tar.xz

Usage:
  node scripts/stage-musicbrainz-release-recordings.mjs --input <path> [options]

Options:
  --input <path>          MusicBrainz release.tar.xz (required)
  --output <path>         Output JSONL path
  --limit-releases <n>   Test only this many Release rows (default 100)
  --all                   Process the complete archive
  --help                  Show this help`);
  process.exit(exitCode);
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}

function parseArguments(args) {
  const options = { limitReleases: 100, output: defaultOutput };
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
    else if (argument === "--output") options.output = resolve(next());
    else if (argument === "--limit-releases") options.limitReleases = positiveInteger(next(), argument);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.input) throw new Error("--input is required.");
  if (!options.input.endsWith(".tar.xz")) throw new Error("--input must be a .tar.xz archive.");
  if (all) options.limitReleases = Infinity;
  return options;
}

// Retain the fields understood by universal-importer.mjs's Recording adapter.
// JSON.stringify escapes tabs/newlines inside text, so the tab separator used
// by the disk sort remains unambiguous.
function compactRecording(recording) {
  return {
    id: recording.id,
    title: recording.title,
    disambiguation: recording.disambiguation ?? "",
    length: recording.length ?? null,
    video: recording.video ?? false,
  };
}

// Respect stream backpressure. Without this wait, Node could buffer gigabytes
// faster than the disk-based sort can consume them.
async function writeSafely(stream, value) {
  if (!stream.write(value)) {
    await new Promise(resolveDrain => stream.once("drain", resolveDrain));
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(sortDirectory, { recursive: true });

  console.log(`Input: ${options.input} (mbdump/release)`);
  console.log(`Output: ${options.output}`);
  console.log(`Plan: ${Number.isFinite(options.limitReleases) ? `${options.limitReleases.toLocaleString()} Release rows` : "complete archive"}`);

  // BSD sort on macOS accepts an actual tab as its field separator. `-u` with
  // key 1 keeps one complete JSON row for every Recording MBID.
  const sorter = spawn("sort", [
    "-t", "\t", "-k1,1", "-u", "-T", sortDirectory,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const cutter = spawn("cut", ["-f2-"], { stdio: ["pipe", "pipe", "pipe"] });
  const output = createWriteStream(options.output);
  sorter.stdout.pipe(cutter.stdin);
  cutter.stdout.pipe(output);

  let sorterError = "";
  let cutterError = "";
  sorter.stderr.on("data", chunk => { sorterError = `${sorterError}${chunk}`.slice(-8_192); });
  cutter.stderr.on("data", chunk => { cutterError = `${cutterError}${chunk}`.slice(-8_192); });
  const sorterExit = new Promise(resolveExit => sorter.once("close", resolveExit));
  const cutterExit = new Promise(resolveExit => cutter.once("close", resolveExit));
  const outputFinished = new Promise((resolveFinish, rejectFinish) => {
    output.once("finish", resolveFinish);
    output.once("error", rejectFinish);
  });

  const tar = spawn("tar", ["-xOJf", options.input, "mbdump/release"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tarError = "";
  tar.stderr.on("data", chunk => { tarError = `${tarError}${chunk}`.slice(-8_192); });
  const tarExit = new Promise(resolveExit => tar.once("close", resolveExit));
  const lines = createInterface({ input: tar.stdout, crlfDelay: Infinity });
  const startedAt = Date.now();
  let releaseRows = 0;
  let trackAppearances = 0;
  let invalidReleases = 0;
  let missingRecordings = 0;
  let stoppedAtLimit = false;

  for await (const line of lines) {
    releaseRows += 1;
    let release;
    try { release = JSON.parse(line); }
    catch {
      invalidReleases += 1;
      continue;
    }

    for (const medium of Array.isArray(release.media) ? release.media : []) {
      for (const track of Array.isArray(medium.tracks) ? medium.tracks : []) {
        const recording = track.recording;
        if (!recording?.id || !recording.title) {
          missingRecordings += 1;
          continue;
        }
        trackAppearances += 1;
        await writeSafely(sorter.stdin, `${recording.id}\t${JSON.stringify(compactRecording(recording))}\n`);
      }
    }

    if (releaseRows % 10_000 === 0) {
      const seconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
      console.log(`Releases ${releaseRows.toLocaleString()} | Recording appearances ${trackAppearances.toLocaleString()} | ${Math.round(trackAppearances / seconds).toLocaleString()} appearances/s`);
    }

    if (releaseRows >= options.limitReleases) {
      stoppedAtLimit = true;
      lines.close();
      tar.stdout.destroy();
      tar.kill("SIGTERM");
      break;
    }
  }

  // Closing sort's input tells it that all rows are available and it can merge
  // temporary runs into the final globally deduplicated stream.
  sorter.stdin.end();
  const tarCode = await tarExit;
  const sortCode = await sorterExit;
  const cutCode = await cutterExit;
  await outputFinished;

  if (!stoppedAtLimit && tarCode !== 0) throw new Error(`tar exited ${tarCode}: ${tarError.trim()}`);
  if (sortCode !== 0) throw new Error(`sort exited ${sortCode}: ${sorterError.trim()}`);
  if (cutCode !== 0) throw new Error(`cut exited ${cutCode}: ${cutterError.trim()}`);

  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
  console.log(`Finished: ${releaseRows.toLocaleString()} Releases inspected in ${elapsedSeconds.toFixed(1)}s.`);
  console.log(`Saw ${trackAppearances.toLocaleString()} Recording appearances; skipped ${missingRecordings.toLocaleString()} missing Recording objects.`);
  console.log(`Invalid Release rows: ${invalidReleases.toLocaleString()}.`);
  console.log(`Deduplicated JSONL: ${options.output}`);
  console.log("Count the unique staged nodes with: wc -l " + options.output);
}

main().catch(error => {
  console.error(`Recording staging failed: ${error.message}`);
  process.exitCode = 1;
});
