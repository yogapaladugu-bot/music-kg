# Music Knowledge Graph

Music Genres web application backed by a Samyama graph, with MusicBrainz data import utilities.

## Import the MusicBrainz artist dump

The bulk importer streams `data/raw/artist.tar.xz`; it does not extract the roughly 16 GB archive or load it all into memory.

Validate the first 100 rows without changing Samyama:

```bash
node scripts/import-musicbrainz-artists.mjs --limit 100 --dry-run
```

With Samyama running at `http://localhost:8080/api/query`, import 100 artists into the `music_kg` graph:

```bash
node scripts/import-musicbrainz-artists.mjs --limit 100
```

After checking the imported nodes, increase the limit gradually:

```bash
node scripts/import-musicbrainz-artists.mjs --limit 10000
```

An unlimited import must be requested explicitly:

```bash
node scripts/import-musicbrainz-artists.mjs --all
```

Use `SAMYAMA_URL` to select a different endpoint. Progress and the `nextSkip` value are written to `data/processed/artist-import-progress.json`. Pass that value through `--skip` when continuing at a later source row. Because the archive is compressed, resuming still has to decompress and skip the earlier rows, but those rows are not sent to Samyama again.

## Universal importer

`scripts/universal-importer.mjs` is the shared, commented import engine for Artists, Recordings, Works/Songs, Releases, Release Groups/Albums, Labels, Genres, and Tracks. Places are deliberately not part of the current schema.

Test the existing artist archive without writing:

```bash
node scripts/universal-importer.mjs \
  --entity artist \
  --input data/raw/artist.tar.xz \
  --limit 100 \
  --dry-run
```

Import a different MusicBrainz JSON archive by selecting its entity:

```bash
node scripts/universal-importer.mjs \
  --entity recording \
  --input data/raw/recording.tar.xz \
  --limit 10000
```

The importer also accepts newline-delimited `.jsonl`, `.json`, `.ndjson`, and gzip-compressed JSON inputs. It records source rows, valid records, successful writes, failures, elapsed time, throughput, and the next resume position under `data/processed/checkpoints/`.

The default `cypher` writer remains one HTTP request per node for compatibility and idempotent `MERGE` behavior. The `json-bulk` writer below provides faster bounded batches when importing a new, non-overlapping source range.

### Bounded Samyama JSON batches

Samyama v1.1.0 exposes `POST /api/import/json`, which creates an array of nodes without parsing one Cypher query per node. Use it only when the input range has not already been imported: this endpoint always creates nodes and does not deduplicate MBIDs.

```bash
node scripts/universal-importer.mjs \
  --entity artist \
  --input data/raw/artist.tar.xz \
  --skip NEXT_SKIP \
  --limit 10000 \
  --writer json-bulk \
  --batch-size 5000
```

The bulk checkpoint's `nextSkip` advances only after Samyama confirms a complete batch. If a request fails, reuse the last confirmed `nextSkip`. Do not overlap ranges when using `json-bulk`; use the default `cypher` writer when idempotent `MERGE` behavior is required.

## Artist relationships (edges)

Edges are handled as a separate two-stage pipeline. First, extract and validate Artist-to-Artist relationships from the same dump without touching Samyama:

```bash
node scripts/extract-musicbrainz-artist-edges.mjs \
  --input data/raw/artist.tar.xz \
  --limit 1000 \
  --dry-run
```

Then stage the complete set as newline-delimited JSON. This streams the archive, so memory usage remains bounded, but the output file can still be large:

```bash
node scripts/extract-musicbrainz-artist-edges.mjs \
  --input data/raw/artist.tar.xz \
  --all
```

Always validate a small range of the staged file before a real edge write:

```bash
node scripts/import-musicbrainz-artist-edges.mjs \
  --input data/staged/edges/artist-relationships.jsonl \
  --limit 1000 \
  --dry-run
```

Import all validated relationships in bounded batches:

```bash
node scripts/import-musicbrainz-artist-edges.mjs \
  --input data/staged/edges/artist-relationships.jsonl \
  --all \
  --batch-size 5000
```

The stock Samyama 1.1.0 HTTP runtime cannot execute `MATCH … CREATE/MERGE` for relationships. This project therefore uses a custom native `/api/import/edges` endpoint that resolves external MBIDs, holds one mutable store lock per batch, creates relationships directly, and skips existing source/target/type triples. The endpoint reports missing endpoints without creating broken edges. Import all Artist nodes before starting this stage; if more endpoint nodes are added later, restart Samyama to rebuild its cached MBID lookup.

## Wikidata genres

`data/query.json` is a Wikidata genre export. Prepare it before importing so
repeated rows become one node per Wikidata QID and one unique `SUBGENRE_OF`
relationship per child/parent pair:

```bash
node scripts/stage-wikidata-genres.mjs
```

Validate 100 prepared Genre nodes without changing Samyama:

```bash
node scripts/universal-importer.mjs \
  --entity genre \
  --input data/staged/wikidata/genres.jsonl \
  --limit 100 \
  --dry-run
```

After reviewing `data/staged/wikidata/report.json`, import every Genre node:

```bash
node scripts/universal-importer.mjs \
  --entity genre \
  --input data/staged/wikidata/genres.jsonl \
  --writer json-bulk \
  --batch-size 1000 \
  --all
```

Validate the first 100 parent relationships:

```bash
node scripts/import-staged-edges.mjs \
  --input data/staged/wikidata/subgenre-edges.jsonl \
  --source-label Genre \
  --target-label Genre \
  --source-id-property qid \
  --target-id-property qid \
  --name wikidata-subgenres \
  --limit 100 \
  --dry-run
```

Only after the Genre node import has completed, import all parent relationships:

```bash
node scripts/import-staged-edges.mjs \
  --input data/staged/wikidata/subgenre-edges.jsonl \
  --source-label Genre \
  --target-label Genre \
  --source-id-property qid \
  --target-id-property qid \
  --name wikidata-subgenres \
  --batch-size 1000 \
  --all
```

The staged records preserve `source: Wikidata`, stable QIDs, countries,
inception dates, and the Wikidata `P279` property used for the hierarchy.
