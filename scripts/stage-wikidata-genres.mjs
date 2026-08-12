#!/usr/bin/env node

/*
 * PREPARE WIKIDATA GENRES FOR SAMYAMA
 * -----------------------------------
 * query.json contains one row for each combination of a genre, its parent,
 * country, and date. That means the same genre can occur many times. This
 * script combines those repeated facts into one Genre node and separately
 * writes each unique Genre -> parent relationship.
 *
 * This is a staging script: it only creates clean files on disk. It does not
 * contact Samyama, so it is safe to run repeatedly while checking the data.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Locate the project from this script rather than relying on the current shell.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultInput = join(projectRoot, "data", "query.json");
const defaultOutput = join(projectRoot, "data", "staged", "wikidata");

function argumentsFrom(commandLine) {
  const options = { input: defaultInput, output: defaultOutput };
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = commandLine[index];
    const next = () => {
      const value = commandLine[++index];
      if (!value) throw new Error(`${argument} requires a path.`);
      return resolve(value);
    };
    if (argument === "--input") options.input = next();
    else if (argument === "--output") options.output = next();
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

// Wikidata URLs end in a stable Q-number. Keeping only that compact identifier
// makes records easier to read while preserving a direct link to their source.
function qid(url) {
  const match = String(url ?? "").match(/\/entity\/(Q\d+)$/);
  return match?.[1] ?? "";
}

function usableLabel(label) {
  // A label that is only a Q-number means Wikidata did not return an English
  // name. We quarantine it instead of displaying a cryptic code to visitors.
  return Boolean(label) && !/^Q\d+$/.test(label);
}

function rememberNode(nodes, id, label) {
  if (!id || !usableLabel(label)) return false;
  if (!nodes.has(id)) {
    nodes.set(id, { id, name: label, qid: id, countries: new Set(), inception: "" });
  }
  return true;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const rows = JSON.parse(await readFile(options.input, "utf8"));
  if (!Array.isArray(rows)) throw new Error("The input must be a JSON array.");

  const nodes = new Map();
  const edges = new Map();
  const rejected = [];

  for (const row of rows) {
    const genreQid = qid(row.genre);
    if (!rememberNode(nodes, genreQid, row.genreLabel)) {
      rejected.push({ reason: "missing stable ID or readable genre label", row });
      continue;
    }

    const genre = nodes.get(genreQid);
    if (row.countryLabel) genre.countries.add(row.countryLabel);
    // If conflicting dates exist, retain the earliest documented date while
    // preserving the original Wikidata source for later auditing.
    if (row.inception && (!genre.inception || row.inception < genre.inception)) {
      genre.inception = row.inception;
    }

    const parentQid = qid(row.parent);
    if (!parentQid) continue;
    if (!rememberNode(nodes, parentQid, row.parentLabel)) {
      rejected.push({ reason: "parent has no readable label", row });
      continue;
    }
    const key = `${genreQid}|${parentQid}`;
    edges.set(key, {
      // Generic names let the edge importer resolve these values using the
      // `qid` property without knowing anything Wikidata-specific.
      source_id: genreQid,
      target_id: parentQid,
      relationship_type: "SUBGENRE_OF",
      properties: { data_source: "Wikidata", wikidata_property: "P279" },
    });
  }

  await mkdir(options.output, { recursive: true });
  const nodePath = join(options.output, "genres.jsonl");
  const edgePath = join(options.output, "subgenre-edges.jsonl");
  const rejectedPath = join(options.output, "rejected.jsonl");
  const reportPath = join(options.output, "report.json");

  const nodeLines = [...nodes.values()].map(node => JSON.stringify({
    id: node.id,
    name: node.name,
    qid: node.qid,
    country: [...node.countries].sort().join("; "),
    inception: node.inception,
    source: "Wikidata",
    source_entity: "genre",
  })).join("\n");
  const edgeLines = [...edges.values()].map(edge => JSON.stringify(edge)).join("\n");
  const rejectedLines = rejected.map(item => JSON.stringify(item)).join("\n");

  await writeFile(nodePath, `${nodeLines}\n`);
  await writeFile(edgePath, `${edgeLines}\n`);
  await writeFile(rejectedPath, rejectedLines ? `${rejectedLines}\n` : "");
  const report = {
    source: options.input,
    sourceRows: rows.length,
    genreNodes: nodes.size,
    subgenreEdges: edges.size,
    rejectedRows: rejected.length,
    generatedAt: new Date().toISOString(),
    files: { nodes: nodePath, edges: edgePath, rejected: rejectedPath },
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Source rows: ${rows.length.toLocaleString()}`);
  console.log(`Staged Genre nodes: ${nodes.size.toLocaleString()}`);
  console.log(`Staged SUBGENRE_OF edges: ${edges.size.toLocaleString()}`);
  console.log(`Rejected rows: ${rejected.length.toLocaleString()}`);
  console.log(`Report: ${reportPath}`);
}

main().catch(error => {
  console.error(`Wikidata genre staging failed: ${error.message}`);
  process.exitCode = 1;
});
