#!/usr/bin/env node

/*
 * SAMYAMA QUERY HELPER
 * --------------------
 * Sends one Cypher query without making the user manually construct JSON.
 * Example:
 *   node scripts/query-samyama.mjs music_kg "MATCH (n) RETURN count(n)"
 * This is read/write capable: the effect depends entirely on the Cypher passed.
 */
// Separate the graph (first argument) from every word belonging to the query.
const [graph, ...queryParts] = process.argv.slice(2);
// Join shell-split pieces defensively, although quoting the query is recommended.
const query = queryParts.join(" ");
const endpoint = process.env.SAMYAMA_URL ?? "http://localhost:8080/api/query";

if (!graph || !query) {
  console.error('Usage: node scripts/query-samyama.mjs <graph> "<Cypher query>"');
  process.exit(1);
}

// POST the same JSON envelope used by all of this project's Samyama scripts.
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ graph, query }),
});

// Read text first so even a non-JSON server error can be shown to the user.
const body = await response.text();

if (!response.ok) {
  console.error(`Samyama returned HTTP ${response.status}: ${body}`);
  process.exit(1);
}

console.log(body);
