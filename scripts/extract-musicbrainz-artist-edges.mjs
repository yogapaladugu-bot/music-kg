#!/usr/bin/env node

// PURPOSE
// -------
// This script reads MusicBrainz Artist records and extracts only Artist-to-Artist relationships.
// It does NOT change Samyama. Its output is a newline-delimited JSON (JSONL) staging file.
// Keeping extraction separate from database writing makes the data inspectable and restartable.

// createHash produces a short, repeatable identity for each relationship.
import { createHash } from "node:crypto";
// spawn lets Node ask `tar` to decompress the large .tar.xz file as a stream.
import { spawn } from "node:child_process";
// createReadStream supports already-extracted JSONL input; createWriteStream writes staged edges gradually.
import { createReadStream, createWriteStream } from "node:fs";
// mkdir creates the staging directory without requiring it to exist beforehand.
import { mkdir } from "node:fs/promises";
// Path helpers avoid fragile string concatenation for filesystem paths.
import { dirname, extname, join, resolve } from "node:path";
// readline converts a stream into one source record per iteration.
import { createInterface } from "node:readline";
// fileURLToPath helps locate the project relative to this script.
import { fileURLToPath } from "node:url";
// once lets the script wait for output backpressure or stream completion.
import { once } from "node:events";

// The script lives in scripts/, so moving up once gives the music-net project root.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// This is the default MusicBrainz archive already downloaded for the project.
const defaultInput = join(projectRoot, "data", "raw", "artist.tar.xz");
// Extracted relationships are staged separately from raw source data and database checkpoints.
const defaultOutput = join(projectRoot, "data", "staged", "edges", "artist-relationships.jsonl");

// Some verbose MusicBrainz relationship names deserve shorter, stable graph vocabulary.
// Unknown names are still supported through the safe fallback in relationshipType().
const relationshipTypeOverrides = new Map([
  ["member of band", "MEMBER_OF"],
  ["collaboration", "COLLABORATED_WITH"],
  ["founder", "FOUNDED"],
  ["tribute", "TRIBUTE_TO"],
  ["supporting musician", "SUPPORTED"],
  ["is person", "PERSON_IDENTITY_OF"],
]);

// Print usage instructions and stop. Exit code 0 means help; nonzero codes mean failure.
function usage(exitCode = 0) {
  console.log(`Extract MusicBrainz Artist-to-Artist relationships

Usage:
  node scripts/extract-musicbrainz-artist-edges.mjs [options]

Options:
  --input <path>    Artist .tar.xz or newline-delimited JSON file
  --member <path>   Archive member (default: mbdump/artist)
  --output <path>   Staged JSONL destination
  --skip <number>   Skip source Artist rows (default: 0)
  --limit <number>  Inspect this many Artist rows (default: 1000)
  --all             Process the entire Artist source
  --dry-run         Validate and count without creating the output file
  --help            Show this message

Examples:
  node scripts/extract-musicbrainz-artist-edges.mjs --limit 1000 --dry-run
  node scripts/extract-musicbrainz-artist-edges.mjs --all`);
  process.exit(exitCode);
}

// Parse a whole-number option and reject negatives, decimals, and accidental text.
function integerOption(value, option, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

// Turn terminal arguments into a predictable options object.
function parseArguments(argv) {
  // Safe defaults make an accidental run small and non-destructive to the complete staging file.
  const options = {
    dryRun: false,
    input: defaultInput,
    limit: 1_000,
    member: "mbdump/artist",
    output: defaultOutput,
    skip: 0,
  };
  let processEverything = false;

  // Read each option and, where necessary, consume its following value.
  for (let index = 0; index < argv.length; index += 1) {
    // Trimming helps commands copied from formatted messages.
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
    else if (argument === "--member") options.member = nextValue();
    else if (argument === "--output") options.output = resolve(nextValue());
    else if (argument === "--skip") options.skip = integerOption(nextValue(), argument, { allowZero: true });
    else if (argument === "--limit") options.limit = integerOption(nextValue(), argument);
    else throw new Error(`Unknown option: ${argument}`);
  }

  // Infinity is used internally only after the user explicitly requests --all.
  if (processEverything) options.limit = Infinity;
  return options;
}

// Open either the compressed archive or an ordinary line-oriented JSON file.
function openInput(options) {
  let child = null;
  let stream;
  let decompressorError = "";
  const lowerName = options.input.toLowerCase();

  if (lowerName.endsWith(".tar.xz")) {
    // -x extracts, -O writes to stdout, -J decompresses XZ, and -f selects the archive file.
    child = spawn("tar", ["-xOJf", options.input, options.member], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    stream = child.stdout;
    // Save only the last part of a decompressor error so an unusual failure cannot consume unlimited memory.
    child.stderr.on("data", (chunk) => {
      decompressorError = `${decompressorError}${chunk}`.slice(-8_192);
    });
  } else if ([".json", ".jsonl", ".ndjson"].includes(extname(lowerName))) {
    stream = createReadStream(options.input);
  } else {
    throw new Error("Unsupported input. Use .tar.xz, .json, .jsonl, or .ndjson.");
  }

  // Attach the close listener immediately so a fast child cannot exit before we begin waiting for it.
  const childExit = child
    ? new Promise((resolveExit) => child.once("close", resolveExit))
    : Promise.resolve(0);

  // A limited run intentionally stops decompression after enough records have been inspected.
  const stop = () => {
    stream.destroy();
    if (child && !child.killed) child.kill("SIGTERM");
  };

  return { childExit, getError: () => decompressorError.trim(), stop, stream };
}

// Convert a MusicBrainz date object or string into a readable value.
function dateText(value) {
  // Some dump fields are already strings such as "2001-04-20".
  if (typeof value === "string") return value.trim() || null;
  // Defensive handling also supports structured dates with year/month/day fields.
  if (value && typeof value === "object") {
    const parts = [value.year, value.month, value.day].filter((part) => part !== null && part !== undefined);
    return parts.length > 0 ? parts.join("-") : null;
  }
  return null;
}

// Turn arbitrary MusicBrainz relationship names into safe uppercase Cypher relationship types.
function relationshipType(sourceType) {
  const normalizedName = String(sourceType ?? "").trim().toLowerCase();
  if (!normalizedName) return null;
  if (relationshipTypeOverrides.has(normalizedName)) return relationshipTypeOverrides.get(normalizedName);
  // Replace punctuation/spaces with underscores and remove leading/trailing separators.
  const fallback = normalizedName
    .normalize("NFKD")
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .toUpperCase();
  return fallback || null;
}

// Normalize roles such as ["guitar", "lead vocals"] into one inspectable string property.
function attributeText(relation) {
  if (!Array.isArray(relation.attributes) || relation.attributes.length === 0) return null;
  return relation.attributes.map(String).sort().join(" | ");
}

// Create the same short key every time the same meaningful relationship is encountered.
function edgeKey(edge) {
  const identity = [
    edge.source_mbid,
    edge.relationship_type,
    edge.target_mbid,
    edge.begin_date ?? "",
    edge.end_date ?? "",
    edge.attributes ?? "",
  ].join("\u001f");
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

// Convert one raw MusicBrainz relation into the stable staging schema used by the edge importer.
function normalizeArtistRelation(currentArtist, relation) {
  // Only relations containing another Artist are relevant to this first edge milestone.
  const relatedArtist = relation?.artist;
  if (!relatedArtist?.id || !currentArtist?.id) return null;
  const type = relationshipType(relation.type);
  if (!type) return null;

  // MusicBrainz direction is relative to the current outer record.
  // "forward" means current -> related; "backward" means related -> current.
  const backward = relation.direction === "backward";
  const edge = {
    source_mbid: backward ? relatedArtist.id : currentArtist.id,
    target_mbid: backward ? currentArtist.id : relatedArtist.id,
    relationship_type: type,
    musicbrainz_type: String(relation.type),
    musicbrainz_type_id: relation["type-id"] ?? null,
    begin_date: dateText(relation.begin),
    end_date: dateText(relation.end),
    ended: typeof relation.ended === "boolean" ? relation.ended : null,
    attributes: attributeText(relation),
    source_credit: relation["source-credit"] || null,
    target_credit: relation["target-credit"] || null,
    data_source: "MusicBrainz",
  };
  // Add the deterministic identity after every identity-bearing field is normalized.
  return { edge_key: edgeKey(edge), ...edge };
}

// Write one JSONL record while respecting stream backpressure on slower disks.
async function writeJsonLine(output, value) {
  if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, "drain");
}

// main coordinates reading, normalizing, deduplicating, writing, and reporting.
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const input = openInput(options);
  const lines = createInterface({ input: input.stream, crlfDelay: Infinity });
  let output = null;
  let sourceRows = 0;
  let processedArtists = 0;
  let rawArtistRelations = 0;
  let stagedEdges = 0;
  let duplicateEdges = 0;
  let invalidRows = 0;
  let stoppedAtLimit = false;
  // The Set prevents the same normalized relationship from being written twice in this extraction run.
  const seenEdgeKeys = new Set();

  if (!options.dryRun) {
    await mkdir(dirname(options.output), { recursive: true });
    // flags: "w" intentionally replaces an earlier staging file so a full rerun starts cleanly.
    output = createWriteStream(options.output, { flags: "w" });
  }

  console.log(`Input: ${options.input}`);
  console.log(`Mode: ${options.dryRun ? "dry run" : `write ${options.output}`}`);
  console.log(`Plan: skip ${options.skip.toLocaleString()}, inspect ${Number.isFinite(options.limit) ? options.limit.toLocaleString() : "all"} Artists`);

  for await (const line of lines) {
    sourceRows += 1;
    if (sourceRows <= options.skip) continue;

    let artist;
    try {
      artist = JSON.parse(line);
      if (!artist.id) throw new Error("missing Artist MBID");
    } catch (error) {
      invalidRows += 1;
      console.error(`Invalid Artist source row ${sourceRows}: ${error.message}`);
      continue;
    }

    processedArtists += 1;
    const relations = Array.isArray(artist.relations) ? artist.relations : [];
    for (const relation of relations) {
      const edge = normalizeArtistRelation(artist, relation);
      if (!edge) continue;
      rawArtistRelations += 1;
      if (seenEdgeKeys.has(edge.edge_key)) {
        duplicateEdges += 1;
        continue;
      }
      seenEdgeKeys.add(edge.edge_key);
      stagedEdges += 1;
      if (output) await writeJsonLine(output, edge);
      if (options.dryRun && stagedEdges <= 3) {
        console.log(`Example: ${edge.source_mbid} -[:${edge.relationship_type}]-> ${edge.target_mbid}`);
      }
    }

    if (processedArtists % 1_000 === 0) {
      console.log(`Artists ${processedArtists.toLocaleString()} | unique edges ${stagedEdges.toLocaleString()} | repeated ${duplicateEdges.toLocaleString()}`);
    }

    if (processedArtists >= options.limit) {
      stoppedAtLimit = true;
      lines.close();
      input.stop();
      break;
    }
  }

  // Finish flushing the output file before declaring success.
  if (output) {
    output.end();
    await once(output, "finish");
  }
  // An unlimited read should verify that decompression reached a clean end.
  if (!stoppedAtLimit) {
    const exitCode = await input.childExit;
    if (exitCode !== 0) throw new Error(`Input decompressor exited with ${exitCode}: ${input.getError()}`);
  }

  console.log(`Finished: ${processedArtists.toLocaleString()} Artists inspected.`);
  console.log(`Artist relations: ${rawArtistRelations.toLocaleString()} found, ${stagedEdges.toLocaleString()} unique, ${duplicateEdges.toLocaleString()} repeated.`);
  console.log(`Invalid Artist rows: ${invalidRows.toLocaleString()}.`);
  if (output) console.log(`Staged file: ${options.output}`);
}

// Report unexpected failures clearly instead of printing a difficult raw Promise rejection.
main().catch((error) => {
  console.error(`Artist edge extraction failed: ${error.message}`);
  process.exitCode = 1;
});
