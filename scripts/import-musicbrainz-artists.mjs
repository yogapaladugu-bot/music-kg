#!/usr/bin/env node

/*
 * OLDER ARTIST-ONLY IMPORTER
 * --------------------------
 * This script streams `mbdump/artist` out of MusicBrainz's compressed archive
 * and sends one Cypher request per artist. It taught us the basic pipeline,
 * but universal-importer.mjs is now the preferred, faster importer.
 *
 * Data path: artist.tar.xz -> `tar` -> one JSON line -> validation -> Cypher
 * -> Samyama. Streaming matters because the full file should never be loaded
 * into RAM at once. This file remains as a smaller example and fallback.
 */

// Node's built-in modules provide processes, files, paths, and line streaming.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Convert this module's URL to a path, then move up from scripts/ to the repo.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultArchive = join(projectRoot, "data", "raw", "artist.tar.xz");
const progressPath = join(projectRoot, "data", "processed", "artist-import-progress.json"); //This is where the importer saves project information.

function usage(exitCode = 0) {
  // Keep command documentation beside the parser so they stay synchronized.
  console.log(`Usage:
  node scripts/import-musicbrainz-artists.mjs [options]

Options:
  --limit <number>       Artists to process (default: 100)
  --all                  Process the complete dump; required instead of an unlimited limit
  --skip <number>        Skip this many source rows before importing (default: 0)
  --graph <name>         Samyama graph name (default: music_kg)
  --archive <path>       Dump archive (default: data/raw/artist.tar.xz)
  --concurrency <number> Simultaneous Samyama requests (default: 4, maximum: 32)
  --dry-run              Parse and validate without writing to Samyama
  --help                 Show this help

Examples:
  node scripts/import-musicbrainz-artists.mjs --limit 100 --dry-run
  node scripts/import-musicbrainz-artists.mjs --limit 100
  node scripts/import-musicbrainz-artists.mjs --skip 100 --limit 1000
  node scripts/import-musicbrainz-artists.mjs --all`);
  process.exit(exitCode);
}

function positiveInteger(value, option, { allowZero = false } = {}) {
  // CLI arguments begin as strings. Reject unsafe, fractional, or wrong-sign
  // numbers before they can silently create a surprising import.
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return number;
}

function parseArguments(argv) {
  // Defaults make a first run small and safe; --all must be explicit.
  const options = {
    archive: defaultArchive,
    concurrency: 4,
    dryRun: false,
    graph: "music_kg",
    limit: 100,
    skip: 0,
  };
  let all = false;

  // Walk left-to-right through every token after the script filename.
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      return value;
    };

    if (argument === "--help") usage();
    else if (argument === "--all") all = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--limit") options.limit = positiveInteger(next(), argument);
    else if (argument === "--skip") options.skip = positiveInteger(next(), argument, { allowZero: true });
    else if (argument === "--graph") options.graph = next();
    else if (argument === "--archive") options.archive = resolve(next());
    else if (argument === "--concurrency") options.concurrency = positiveInteger(next(), argument);
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (all) options.limit = Infinity;
  if (options.concurrency > 32) throw new Error("--concurrency cannot exceed 32.");
  if (!options.graph.trim()) throw new Error("--graph cannot be empty.");
  return options;
}

function cypherString(value) {
  // Normalize characters that could terminate a quoted Cypher string. This is
  // specific to the current Samyama parser; parameterized Cypher is preferable
  // whenever a database driver supports it.
  const safeValue = String(value ?? "")
    .replaceAll("\\", "/")
    .replaceAll("'", "’")
    .replaceAll('"', "″")
    .replaceAll(/\s+/g, " ")
    .trim();
  return `'${safeValue}'`;
}

function artistQuery(artist) {
  // MERGE uses the stable MusicBrainz ID, making a repeated import idempotent:
  // the same artist is matched and updated instead of duplicated.
  const properties = [
    `a.name = ${cypherString(artist.name)}`,
    `a.sort_name = ${cypherString(artist["sort-name"] ?? artist.name)}`,
    `a.disambiguation = ${cypherString(artist.disambiguation)}`,
    `a.source = 'MusicBrainz'`,
  ];
  if (artist.type) properties.push(`a.type = ${cypherString(artist.type)}`);
  if (artist.gender) properties.push(`a.gender = ${cypherString(artist.gender)}`);
  if (artist.country) properties.push(`a.country = ${cypherString(artist.country)}`);

  return `MERGE (a:Artist {mbid: ${cypherString(artist.id)}}) SET ${properties.join(", ")} RETURN a`;
}

async function sendArtist(endpoint, graph, artist) {
  // Send exactly one artist query to Samyama and surface non-2xx responses.
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graph, query: artistQuery(artist) }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
}

async function saveProgress(progress) {
  // A checkpoint records the correct --skip value for a later resumed run.
  await mkdir(dirname(progressPath), { recursive: true });
  await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);
}

async function main() {
  // `pending` tracks requests that started but have not finished. Limiting its
  // size prevents unbounded promises, sockets, and memory usage.
  const options = parseArguments(process.argv.slice(2));
  const endpoint = process.env.SAMYAMA_URL ?? "http://localhost:8080/api/query";
  const startedAt = new Date().toISOString();
  let sourceRows = 0;
  let imported = 0;
  let failed = 0;
  let stoppedEarly = false;
  const pending = new Set();

  console.log(`Archive: ${options.archive}`);
  console.log(`Mode: ${options.dryRun ? "dry run" : `import into ${options.graph}`}`);
  console.log(`Rows: skip ${options.skip}, process ${Number.isFinite(options.limit) ? options.limit : "all"}`);

  const archive = spawn("tar", ["-xOJf", options.archive, "mbdump/artist"], { //tar decompresses files and sends it directly to the js program. It saves storage in a computer
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: archive.stdout, crlfDelay: Infinity });

  async function queue(artist) {
    // Dry-run validates source records without touching the graph.
    if (options.dryRun) return;
    const task = sendArtist(endpoint, options.graph, artist)
      .catch((error) => {
        failed += 1;
        console.error(`Failed ${artist.id}: ${error.message}`);
      })
      .finally(() => pending.delete(task));
    pending.add(task);
    if (pending.size >= options.concurrency) await Promise.race(pending);
  }

  for await (const line of lines) {
    // `for await` consumes the decompressed stream one line at a time.
    sourceRows += 1;
    if (sourceRows <= options.skip) continue;

    let artist;
    try {
      artist = JSON.parse(line);
      if (!artist.id || !artist.name) throw new Error("missing id or name");
    } catch (error) {
      failed += 1;
      console.error(`Invalid source row ${sourceRows}: ${error.message}`);
      continue;
    }

    await queue(artist);
    imported += 1;

    if (imported <= 3 && options.dryRun) {
      console.log(`Validated ${artist.id}: ${artist.name}`);
    }
    if (imported % 100 === 0) {
      console.log(`Processed ${imported.toLocaleString()} artists (${failed} failed)`);
      await saveProgress({
        archive: options.archive,
        graph: options.graph,
        sourceRows,
        imported,
        failed,
        nextSkip: sourceRows,
        startedAt,
        updatedAt: new Date().toISOString(),
      });
    }

    if (imported >= options.limit) {
      stoppedEarly = true;
      lines.close();
      archive.stdout.destroy();
      archive.kill("SIGTERM");
      break;
    }
  }

  await Promise.all(pending);
  if (!stoppedEarly) {
    const exitCode = await new Promise((resolveExit) => archive.once("close", resolveExit));
    if (exitCode !== 0) throw new Error(`tar exited with status ${exitCode}.`);
  }

  await saveProgress({
    archive: options.archive,
    graph: options.graph,
    sourceRows,
    imported,
    failed,
    nextSkip: sourceRows,
    startedAt,
    completedAt: new Date().toISOString(),
  });
  console.log(`Finished: ${imported.toLocaleString()} processed, ${failed.toLocaleString()} failed.`);
  console.log(`Progress: ${progressPath}`);
  if (failed > 0) process.exitCode = 2;
}

// Keep one top-level error boundary so failures produce a useful message and a
// nonzero exit status that shell scripts can detect.
main().catch((error) => {
  console.error(`Import failed: ${error.message}`);
  process.exitCode = 1;
});
