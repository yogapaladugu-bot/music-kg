#!/usr/bin/env node

/*
 * SMALL API SAMPLE (LEARNING SCRIPT)
 * ----------------------------------
 * This script searches MusicBrainz for one artist, downloads up to 25 of that
 * artist's recordings, saves the raw response, and creates both node types plus
 * PERFORMED edges in Samyama. It demonstrates the complete graph idea on a
 * human-sized sample; it is not intended for the 100-million-node bulk import.
 *
 * Example: node scripts/import-musicbrainz-sample.mjs music_kg "The Beatles"
 */

// Everything imported here is built into Node; no npm package is required.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

// process.argv holds command-line words. `??` chooses a default only when the
// requested value is null or undefined.
const graph = process.argv[2] ?? "music_kg";
const artistName = process.argv.slice(3).join(" ") || "The Beatles";
const samyamaUrl = process.env.SAMYAMA_URL ?? "http://localhost:8080/api/query";
// Collapse accidental pasted line breaks so the HTTP header remains valid.
let musicBrainzUserAgent = process.env.MUSICBRAINZ_USER_AGENT
  ?.replaceAll(/\s+/g, " ")
  .trim();
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

if (!musicBrainzUserAgent) {
  // MusicBrainz requires callers to identify their application. Prompt only
  // when the environment variable was not already supplied.
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  musicBrainzUserAgent = (await prompt.question(
    "MusicBrainz User-Agent (for example, MusicKnowledgeGraph/0.1 (you@example.com)): ",
  )).replaceAll(/\s+/g, " ").trim();
  prompt.close();
}

if (!musicBrainzUserAgent) {
  console.error("A MusicBrainz User-Agent is required.");
  process.exit(1);
}

async function getMusicBrainzJson(url) {
  // One helper centralizes the required request headers and error handling.
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": musicBrainzUserAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`MusicBrainz returned HTTP ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

function cypherString(value) {
  // This Samyama HTTP server does not accept $parameters. Its string parser
  // cannot escape ASCII quotation marks, so normalize only those characters.
  const safeValue = String(value)
    .replaceAll("\\", "/")
    .replaceAll("'", "’")
    .replaceAll('"', "″")
    .replaceAll(/\s+/g, " ")
    .trim();
  return `'${safeValue}'`;
}

async function runCypher(query) {
  // Samyama accepts a JSON object containing the graph name and Cypher text.
  const response = await fetch(samyamaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graph, query }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Samyama returned HTTP ${response.status}: ${body}`);
  }
  return body;
}

// Constructing a URL this way safely encodes spaces and punctuation in names.
const artistSearchUrl = new URL("https://musicbrainz.org/ws/2/artist/");
artistSearchUrl.search = new URLSearchParams({
  query: `artist:"${artistName}"`,
  fmt: "json",
  limit: "1",
});

const artistSearch = await getMusicBrainzJson(artistSearchUrl);
// Optional chaining (`?.`) avoids crashing if `artists` is absent.
const artist = artistSearch.artists?.[0];
if (!artist) {
  throw new Error(`MusicBrainz did not find an artist named "${artistName}".`);
}

await new Promise((resolve) => setTimeout(resolve, 1_100)); //waits for 1.1 seconds before sending the next request to the MusicBrainz API to avoid exceeding the rate limit.

const recordingsUrl = new URL("https://musicbrainz.org/ws/2/recording/");
// The artist MBID is more precise than searching recordings by a display name.
recordingsUrl.search = new URLSearchParams({
  artist: artist.id,
  fmt: "json",
  limit: "25",
});
const recordingsResponse = await getMusicBrainzJson(recordingsUrl);
const recordings = recordingsResponse.recordings ?? [];

const rawDirectory = join(projectRoot, "data", "raw");
// Keep the untouched source response for debugging and reproducibility.
await mkdir(rawDirectory, { recursive: true });
const rawPath = join(rawDirectory, `musicbrainz-${artist.id}.json`);
await writeFile(rawPath, JSON.stringify({ artist, recordings }, null, 2));

await runCypher(`
  // MERGE means “find this identity, or create it if it does not exist.”
  MERGE (a:Artist {mbid: ${cypherString(artist.id)}})
  ON CREATE SET a.name = ${cypherString(artist.name)},
                a.type = ${cypherString(artist.type ?? "unknown")},
                a.source = 'MusicBrainz'
  RETURN a
`);

for (const recording of recordings) {
  // Each loop iteration creates one Recording and connects it to the Artist.
  const lengthProperty = Number.isInteger(recording.length) //if recording has an integer length, include length_ms. Else, include nothing.
    ? `, r.length_ms = ${recording.length}`
    : "";

  await runCypher(`
    MERGE (r:Recording {mbid: ${cypherString(recording.id)}})
    ON CREATE SET r.title = ${cypherString(recording.title)},
                  r.source = 'MusicBrainz'${lengthProperty}
    RETURN r
  `);

  await runCypher(`
    MATCH (a:Artist {mbid: ${cypherString(artist.id)}})
    MATCH (r:Recording {mbid: ${cypherString(recording.id)}})
    MERGE (a)-[:PERFORMED]->(r)
    RETURN r
  `);
}

console.log(`Imported ${artist.name} and ${recordings.length} recordings into ${graph}.`);
console.log(`Saved the raw MusicBrainz response to ${rawPath}.`);
console.log(
  // End with a tiny verification query so the user sees database-side evidence.
  await runCypher(
    "MATCH (a:Artist)-[:PERFORMED]->(r:Recording) RETURN count(a) AS artist_recording_pairs",
  ),
);
