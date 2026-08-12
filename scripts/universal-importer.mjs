#!/usr/bin/env node

// This program is the shared import engine for every kind of music entity.
// An "entity" is a node type such as Artist, Recording, Work, Release, or Genre.

// spawn starts an external decompression program without loading a whole archive into memory.
import { spawn } from "node:child_process";
// createReadStream reads an ordinary JSONL file a small piece at a time.
import { createReadStream } from "node:fs";
// mkdir and writeFile create the progress directory and save import checkpoints.
import { mkdir, writeFile } from "node:fs/promises";
// extname and path helpers let the script safely work with user-supplied file paths.
import { dirname, extname, join, resolve } from "node:path";
// readline turns a byte stream into a sequence of lines; each source line is one JSON record.
import { createInterface } from "node:readline";
// fileURLToPath converts this module's URL into a normal filesystem path.
import { fileURLToPath } from "node:url";

// Find the repository root by moving up one directory from the scripts directory.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Put generated checkpoints in data/processed, which is ignored by Git.
const checkpointDirectory = join(projectRoot, "data", "processed", "checkpoints");

// Keep only useful scalar values. Large nested source objects belong in raw storage, not node properties.
function compactProperties(properties) {
  // Object.entries converts {name: "A"} into [["name", "A"]] so fields can be filtered.
  const presentEntries = Object.entries(properties).filter(([, value]) => {
    // Omit null and undefined because they do not add useful information to a graph node.
    //[ , value] ignores the first element of the array, which is the property name. Only the value is checked for presence.
    if (value === null || value === undefined) return false;
    // Omit empty strings after trimming them.
    if (typeof value === "string" && value.trim() === "") return false; 
    // Keep only strings, numbers, and booleans; nested relationships are imported separately later.
    return ["string", "number", "boolean"].includes(typeof value);
  });
  // Object.fromEntries converts the filtered [key, value] pairs back into an object.
  return Object.fromEntries(presentEntries);
}

// These adapters explain how each MusicBrainz JSON record becomes one graph node.
// Adding a future entity generally means adding one entry here instead of copying the import engine.
const entitySpecs = {
  // MusicBrainz uses Artist for people, bands, orchestras, choirs, and fictional characters.
  artist: {
    label: "Artist",
    displayField: "name",
    properties: (record) => compactProperties({
      name: record.name,
      sort_name: record["sort-name"],
      disambiguation: record.disambiguation,
      artist_type: record.type,
      gender: record.gender,
      country: record.country,
    }),
  },
  // A Recording is a particular recorded performance, not the abstract composition.
  recording: {
    label: "Recording",
    displayField: "title",
    properties: (record) => compactProperties({
      title: record.title,
      disambiguation: record.disambiguation,
      length_ms: record.length,
      video: record.video,
    }),
  },
  // A Work is the underlying composition; a Work whose type is Song is what users call a song.
  work: {
    label: "Work",
    displayField: "title",
    properties: (record) => compactProperties({
      title: record.title,
      disambiguation: record.disambiguation,
      work_type: record.type,
      language: record.language,
    }),
  },
  // A Release is one specific edition, such as a particular country's CD or digital edition.
  release: {
    label: "Release",
    displayField: "title",
    properties: (record) => compactProperties({
      title: record.title,
      status: record.status,
      barcode: record.barcode,
      country: record.country,
      release_date: record.date,
      packaging: record.packaging,
      disambiguation: record.disambiguation,
    }),
  },
  // A ReleaseGroup combines editions into the user-facing idea of an album, single, EP, and so on.
  "release-group": {
    label: "ReleaseGroup",
    displayField: "title",
    properties: (record) => compactProperties({
      title: record.title,
      primary_type: record["primary-type"],
      first_release_date: record["first-release-date"],
      disambiguation: record.disambiguation,
    }),
  },
  // A Label can represent a record label, publisher, distributor, or related organization.
  label: {
    label: "Label",
    displayField: "name",
    properties: (record) => compactProperties({
      name: record.name,
      sort_name: record["sort-name"],
      label_type: record.type,
      label_code: record["label-code"],
      country: record.country,
      disambiguation: record.disambiguation,
    }),
  },
  // An Instrument is something used to perform music, including voice types.
  // Artist/recording relationship files can later connect performers to these nodes.
  instrument: {
    label: "Instrument",
    displayField: "name",
    properties: (record) => compactProperties({
      name: record.name,
      instrument_type: record.type,
      description: record.description,
      disambiguation: record.disambiguation,
    }),
  },
  // Genre records are canonical categories; noisy user tags will need a separate normalization stage.
  genre: {
    label: "Genre",
    displayField: "name",
    // Unlike MusicBrainz entities, these staged genre records use Wikidata QIDs.
    identityProperty: "qid",
    source: "Wikidata",
    properties: (record) => compactProperties({
      name: record.name,
      qid: record.qid ?? record.id,
      country: record.country,
      inception: record.inception,
      disambiguation: record.disambiguation,
    }),
  },
  // A Track is a recording's position on one specific release medium.
  // Tracks may arrive from a future flattened release export rather than their own MusicBrainz archive.
  track: {
    label: "Track",
    displayField: "title",
    properties: (record) => compactProperties({
      title: record.title,
      number: record.number,
      position: record.position,
      length_ms: record.length,
    }),
  },
};

// Print command help and then stop with the requested operating-system exit code.
function usage(exitCode = 0) {
  console.log(`Universal music node importer

Usage:
  node scripts/universal-importer.mjs --entity <type> --input <path> [options]

Required:
  --entity <type>        artist, recording, work, release, release-group, label, instrument, genre, or track
  --input <path>         .tar.xz, .jsonl/.json, or .json.gz source file

Options:
  --member <path>        Member inside a tar.xz archive (default: mbdump/<entity>)
  --graph <name>         Samyama graph (default: music_kg)
  --writer <mode>        cypher (deduplicating) or json-bulk (fast, create-only; default: cypher)
  --batch-size <number>  Nodes per json-bulk request (default: 5000, maximum: 20000)
  --limit <number>       Maximum valid records to process (default: 100)
  --all                  Process the entire input instead of the safe 100-record default
  --skip <number>        Skip source rows already processed (default: 0)
  --concurrency <number> Active Samyama requests (default: 4, maximum: 32)
  --dry-run              Parse and validate records without changing Samyama
  --help                 Show this message

Examples:
  node scripts/universal-importer.mjs --entity artist --input data/raw/artist.tar.xz --dry-run
  node scripts/universal-importer.mjs --entity recording --input data/raw/recording.tar.xz --limit 10000
  node scripts/universal-importer.mjs --entity work --input data/raw/work.json.gz --all
  node scripts/universal-importer.mjs --entity artist --input data/raw/artist.tar.xz --writer json-bulk --batch-size 5000 --all`);
  process.exit(exitCode);
}

// Convert a command-line number into a safe integer and reject dangerous or confusing values.
function integerOption(value, option, { allowZero = false } = {}) {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

// Read and validate all command-line arguments in one place.
function parseArguments(argumentsToParse) {
  // Defaults make an accidental run small and point it at the existing local graph.
  const options = {
    batchSize: 5_000,
    concurrency: 4,
    dryRun: false,
    graph: "music_kg",
    limit: 100,
    skip: 0,
    writer: "cypher",
  };
  let importEverything = false;

  // Visit each argument and consume the following value when an option needs one.
  for (let index = 0; index < argumentsToParse.length; index += 1) {
    // Trim whitespace that can be introduced when a command is copied from formatted notes.
    // Also convert typographic en/em dashes into two normal hyphens for pasted option names.
    const argument = argumentsToParse[index]
      .trim()
      .replace(/^[–—]/, "--");
    const nextValue = () => {
      // Values are trimmed too, but internal spaces such as those in file paths remain untouched.
      const value = argumentsToParse[++index]?.trim();
      if (value === undefined) throw new Error(`${argument} requires a value.`);
      return value;
    };

    if (argument === "--help") usage();
    else if (argument === "--all") importEverything = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--entity") options.entity = nextValue().toLowerCase();
    else if (argument === "--input") options.input = resolve(nextValue()); //resolve converts a relative path into an absolute path for safety to prevent confusion about where the file is located.
    else if (argument === "--member") options.member = nextValue();
    else if (argument === "--graph") options.graph = nextValue();
    else if (argument === "--writer") options.writer = nextValue().toLowerCase();
    else if (argument === "--batch-size") options.batchSize = integerOption(nextValue(), argument);
    else if (argument === "--limit") options.limit = integerOption(nextValue(), argument);
    else if (argument === "--skip") options.skip = integerOption(nextValue(), argument, { allowZero: true });
    else if (argument === "--concurrency") options.concurrency = integerOption(nextValue(), argument);
    else throw new Error(`Unknown option: ${argument}`);
  }

  // Refuse to guess the entity because a wrong label would corrupt the graph's meaning.
  if (!options.entity || !entitySpecs[options.entity]) {
    throw new Error(`--entity must be one of: ${Object.keys(entitySpecs).join(", ")}.`);
  }
  // Refuse to guess the input file because imports are data-changing operations.
  if (!options.input) throw new Error("--input is required.");
  // Use the conventional MusicBrainz JSON archive member when none was supplied.
  options.member ??= `mbdump/${options.entity}`;
  // Infinity is an internal way to represent the explicit --all request.
  if (importEverything) options.limit = Infinity;
  // Bound concurrency so a typo cannot create thousands of simultaneous requests.
  if (options.concurrency > 32) throw new Error("--concurrency cannot exceed 32.");
  // Bulk requests are deliberately bounded because Samyama reads each JSON request fully into memory.
  if (options.batchSize > 20_000) throw new Error("--batch-size cannot exceed 20000.");
  // Only known writer names are accepted so a typo cannot silently choose unsafe behavior.
  if (!["cypher", "json-bulk"].includes(options.writer)) {
    throw new Error("--writer must be either cypher or json-bulk.");
  }
  // An empty graph name cannot identify a Samyama graph.
  if (!options.graph.trim()) throw new Error("--graph cannot be empty.");
  return options;
}

// Escape source text for the currently limited Samyama Cypher string parser.
function cypherString(value) {
  const safeText = String(value ?? "")
    .replaceAll("\\", "/")
    .replaceAll("'", "’")
    .replaceAll('"', "″")
    .replaceAll(/\s+/g, " ")
    .trim();
  return `'${safeText}'`;
}

// Convert supported JavaScript scalar values into Cypher literals.
function cypherValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return cypherString(value);
}

//Turns normalized properties into a Cypher MERGE query that creates or updates one node in Samyama.
function nodeQuery(entity, record) {
  const spec = entitySpecs[entity];
  const assignments = Object.entries(nodeProperties(entity, record))
    .map(([name, value]) => `n.${name} = ${cypherValue(value)}`);
  // This Samyama build requires SET after MERGE to be qualified as ON CREATE or ON MATCH.
  // Applying the same assignments in both branches creates new nodes and refreshes existing nodes.
  const propertySet = assignments.join(", ");
  const identityProperty = spec.identityProperty ?? "mbid";
  return `MERGE (n:${spec.label} {${identityProperty}: ${cypherString(record.id)}}) ON CREATE SET ${propertySet} ON MATCH SET ${propertySet} RETURN n`;
}

// Produce the same normalized property object for both the Cypher and bulk JSON writers.
//convert one raw source record into the final properties Samyama should store
function nodeProperties(entity, record) {
  const spec = entitySpecs[entity];
  const identityProperty = spec.identityProperty ?? "mbid";
  return {
    [identityProperty]: record.id,
    ...spec.properties(record),
    source: record.source ?? spec.source ?? "MusicBrainz",
    source_entity: entity,
  };
}

// Send one compatibility-mode HTTP write to Samyama.
// This writer proves correctness; it will be replaced or supplemented by a true bulk writer after benchmarking Samyama.
async function writeNode(endpoint, graph, entity, record) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graph, query: nodeQuery(entity, record) }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
}

// Convert the configured Cypher endpoint into Samyama's bulk JSON endpoint.
function jsonImportEndpoint(queryEndpoint) {
  const url = new URL(queryEndpoint);
  // SAMYAMA_URL traditionally points at /api/query; replace that suffix when present.
  url.pathname = url.pathname.replace(/\/api\/query\/?$/, "/api/import/json");
  // If a caller supplied only a server base URL, append the documented import path.
  if (!url.pathname.endsWith("/api/import/json")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/import/json`;
  }
  return url;
}

// Send one bounded array directly to Samyama's node importer, bypassing one-Cypher-query-per-node overhead.
async function writeJsonBatch(endpoint, graph, entity, records) {
  const label = entitySpecs[entity].label;
  const nodes = records.map(({ record }) => nodeProperties(entity, record));
  const response = await fetch(jsonImportEndpoint(endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graph, label, nodes }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);

  // A successful HTTP status is insufficient: verify that Samyama reports the expected number created.
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error(`Samyama returned non-JSON bulk response: ${body}`);
  }
  if (result.nodes_created !== nodes.length) {
    throw new Error(`Samyama reported ${result.nodes_created} created; expected ${nodes.length}.`);
  }
  return result.nodes_created;
}

// Open one supported source and return both its readable stream and a cleanup function.
function openInput(options) {
  const inputName = options.input.toLowerCase();
  let child = null;
  let stream;
  let decompressorError = "";

  if (inputName.endsWith(".tar.xz")) {
    child = spawn("tar", ["-xOJf", options.input, options.member], { stdio: ["ignore", "pipe", "pipe"] });
    stream = child.stdout;
  } else if (inputName.endsWith(".json.gz") || inputName.endsWith(".jsonl.gz")) {
    child = spawn("gzip", ["-dc", options.input], { stdio: ["ignore", "pipe", "pipe"] });
    stream = child.stdout;
  } else if ([".json", ".jsonl", ".ndjson"].includes(extname(inputName))) {
    stream = createReadStream(options.input);
  } else {
    throw new Error("Unsupported input format. Use .tar.xz, .jsonl/.json/.ndjson, or .json.gz/.jsonl.gz.");
  }

  // Retain decompressor diagnostics for genuine failures, but avoid printing an expected broken pipe at a test limit.
  child?.stderr.on("data", (chunk) => {
    decompressorError = `${decompressorError}${chunk}`.slice(-8_192);
  });

  // Begin listening immediately so a fast child process cannot exit before the listener exists.
  const childExit = child
    ? new Promise((resolveExit) => child.once("close", resolveExit))
    : Promise.resolve(0);
  // Cleanup stops decompression when a test reaches its limit before the archive ends.
  const stop = () => {
    stream.destroy();
    if (child && !child.killed) child.kill("SIGTERM");
  };
  return { childExit, getDecompressorError: () => decompressorError.trim(), stop, stream };
}

// Save a machine-readable checkpoint so a long import can be audited or resumed.
async function saveCheckpoint(entity, checkpoint, dryRun = false) {
  await mkdir(checkpointDirectory, { recursive: true });
  // Keep validation reports separate so a dry run can never erase a real import's resume position.
  const path = join(checkpointDirectory, `${entity}${dryRun ? "-dry-run" : ""}.json`);
  await writeFile(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return path;
}

// main coordinates input, transformation, writes, metrics, and shutdown.
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const spec = entitySpecs[options.entity];
  const endpoint = process.env.SAMYAMA_URL ?? "http://localhost:8080/api/query";
  const startedAt = Date.now();
  let sourceRows = 0;
  let valid = 0;
  let succeeded = 0;
  let failed = 0;
  // For bulk mode, this advances only after Samyama confirms the batch, preventing unsafe resume skips.
  let committedSourceRows = options.skip;
  let stoppedAtLimit = false;
  const pendingWrites = new Set();
  const bulkBatch = [];
  const input = openInput(options);
  const lines = createInterface({ input: input.stream, crlfDelay: Infinity });

  console.log(`Entity: ${options.entity} -> :${spec.label}`);
  console.log(`Input: ${options.input}${options.input.endsWith(".tar.xz") ? ` (${options.member})` : ""}`);
  console.log(`Mode: ${options.dryRun ? "dry run" : `Samyama graph ${options.graph}`}`);
  console.log(`Writer: ${options.writer}${options.writer === "json-bulk" ? ` (${options.batchSize.toLocaleString()} nodes/batch, CREATE-only)` : ` (${options.concurrency} concurrent MERGE requests)`}`);
  console.log(`Plan: skip ${options.skip.toLocaleString()}, process ${Number.isFinite(options.limit) ? options.limit.toLocaleString() : "all"}`);

  // Flush buffered JSON nodes as one request; retain them if the request fails so no checkpoint advances.
  async function flushBulkBatch() {
    if (bulkBatch.length === 0 || options.dryRun) return;
    const batchToWrite = bulkBatch.splice(0, bulkBatch.length);
    try {
      const created = await writeJsonBatch(endpoint, options.graph, options.entity, batchToWrite);
      succeeded += created;
      committedSourceRows = batchToWrite.at(-1).sourceRow;
    } catch (error) {
      // Put the records back in their original order for accurate failure reporting and possible debugging.
      bulkBatch.unshift(...batchToWrite);
      failed += batchToWrite.length;
      throw new Error(`Bulk batch beginning at source row ${batchToWrite[0].sourceRow} failed: ${error.message}`);
    }
  }

  // Queue one write while enforcing the configured upper bound on active requests.
  async function queueWrite(record) {
    if (options.dryRun) return;
    // Bulk mode buffers a bounded number of normalized records, then waits for one confirmed batch response.
    if (options.writer === "json-bulk") {
      bulkBatch.push({ record, sourceRow: sourceRows });
      if (bulkBatch.length >= options.batchSize) await flushBulkBatch();
      return;
    }
    // Compatibility mode retains idempotent MERGE behavior for small or overlapping imports.
    const task = writeNode(endpoint, options.graph, options.entity, record)
      .then(() => { succeeded += 1; })
      .catch((error) => {
        failed += 1;
        console.error(`Write failed for ${record.id}: ${error.message}`);
      })
      .finally(() => pendingWrites.delete(task));
    pendingWrites.add(task);
    if (pendingWrites.size >= options.concurrency) await Promise.race(pendingWrites);
  }

  // Read and handle exactly one source object at a time.
  for await (let line of lines) {
    sourceRows += 1;
    if (sourceRows <= options.skip) continue;

    // Wikidata-style JSON arrays may leave a comma at the end of each otherwise independent line.
    line = line.trim().replace(/,$/, "");
    // Ignore array brackets and empty lines; ordinary MusicBrainz JSONL has none of these.
    if (!line || line === "[" || line === "]") continue;

    let record;
    try {
      record = JSON.parse(line);
      if (!record.id) throw new Error("missing stable source id");
      const displayValue = spec.properties(record)[spec.displayField];
      if (!displayValue) throw new Error(`missing ${spec.displayField}`);
    } catch (error) {
      failed += 1;
      console.error(`Invalid ${options.entity} source row ${sourceRows}: ${error.message}`);
      continue;
    }

    valid += 1;
    await queueWrite(record);

    // Show a few real records during a dry run so the user can verify the selected entity adapter.
    if (options.dryRun && valid <= 3) {
      console.log(`Validated ${record.id}: ${spec.properties(record)[spec.displayField]}`);
    }

    // Report speed and save a checkpoint every 1,000 valid records.
    if (valid % 1_000 === 0) {
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
      const rate = succeeded / elapsedSeconds;
      console.log(`Valid ${valid.toLocaleString()} | written ${succeeded.toLocaleString()} | failed ${failed.toLocaleString()} | ${rate.toFixed(1)} nodes/s`);
      await saveCheckpoint(options.entity, {
        entity: options.entity,
        input: options.input,
        member: options.member,
        graph: options.graph,
        sourceRows,
        valid,
        succeeded,
        failed,
        nextSkip: options.writer === "json-bulk" ? committedSourceRows : sourceRows,
        writer: options.writer,
        batchSize: options.writer === "json-bulk" ? options.batchSize : undefined,
        updatedAt: new Date().toISOString(),
      }, options.dryRun);
    }

    // Stop immediately after the safe limit instead of decompressing unused archive data.
    if (valid >= options.limit) {
      stoppedAtLimit = true;
      lines.close();
      input.stop();
      break;
    }
  }

  // Write the final partial batch, which may contain fewer records than --batch-size.
  await flushBulkBatch();
  // Do not print a final result until every request that was already started has completed.
  await Promise.all(pendingWrites);
  // A complete, unlimited read should also verify that its decompression process exited successfully.
  if (!stoppedAtLimit) {
    const exitCode = await input.childExit;
    if (exitCode !== 0) {
      const detail = input.getDecompressorError();
      throw new Error(`Input decompressor exited with status ${exitCode}${detail ? `: ${detail}` : "."}`);
    }
  }

  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);
  const checkpointPath = await saveCheckpoint(options.entity, {
    entity: options.entity,
    input: options.input,
    member: options.member,
    graph: options.graph,
    sourceRows,
    valid,
    succeeded,
    failed,
    nextSkip: options.writer === "json-bulk" ? committedSourceRows : sourceRows,
    writer: options.writer,
    batchSize: options.writer === "json-bulk" ? options.batchSize : undefined,
    elapsedSeconds,
    nodesPerSecond: succeeded / elapsedSeconds,
    completedAt: new Date().toISOString(),
  }, options.dryRun);

  const resultDescription = options.dryRun
    ? `${valid.toLocaleString()} validated; Samyama was not changed`
    : `${succeeded.toLocaleString()} written`;
  console.log(`Finished: ${resultDescription}, ${failed.toLocaleString()} failed in ${elapsedSeconds.toFixed(1)}s.`);
  console.log(`Checkpoint: ${checkpointPath}`);
  if (failed > 0) process.exitCode = 2;
}

// Convert unexpected failures into a readable error and a conventional nonzero exit status.
main().catch((error) => {
  console.error(`Universal import failed: ${error.message}`);
  process.exitCode = 1;
});
