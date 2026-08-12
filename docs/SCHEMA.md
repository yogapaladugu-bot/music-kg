# Music Knowledge Graph schema

This document is the canonical description of what each node and relationship
means. Counts below were verified after the 9 August 2026 MusicBrainz imports.

## Node types

| Label | Meaning | Count | Primary identity |
|---|---|---:|---|
| `Artist` | A person, band, orchestra, choir, or credited performer | 2,948,199 | MusicBrainz ID (`mbid`) |
| `Recording` | One particular recorded performance | 39,718,611 | MusicBrainz ID (`mbid`) |
| `Label` | A record label, publisher, distributor, or related organization | 345,587 | MusicBrainz ID (`mbid`) |
| `Work` | The underlying composition or written work | 2,802,273 | MusicBrainz ID (`mbid`) |
| `ReleaseGroup` | The general album, single, EP, or other release concept | 4,443,713 | MusicBrainz ID (`mbid`) |
| `Instrument` | A musical instrument or voice type | 1,057 | MusicBrainz ID (`mbid`) |
| `Release` | One country/format/date-specific edition | 5,682,676 | MusicBrainz ID (`mbid`) |
| `Medium` | One CD, vinyl, cassette, digital disc, or equivalent inside a Release | 6,240,799 | MusicBrainz ID (`mbid`) |
| `Track` | One position on one Medium's track list | 57,155,622 | MusicBrainz ID (`mbid`) |

Total: **119,338,537 nodes**.

## Core relationship model

```text
(Artist)-[:MEMBER_OF]->(Artist)

(Release)-[:PART_OF_RELEASE_GROUP]->(ReleaseGroup)
(Release)-[:CONTAINS_MEDIUM]->(Medium)
(Medium)-[:CONTAINS_TRACK]->(Track)
(Track)-[:REPRESENTS_RECORDING]->(Recording)

(Artist)-[:CREDITED_ON]->(Recording)
(Recording)-[:PERFORMANCE_OF]->(Work)
(Release)-[:ON_LABEL]->(Label)
(Artist)-[:PLAYS]->(Instrument)

(Artist)-[:PERFORMS]->(Genre)
(Genre)-[:SUBGENRE_OF]->(Genre)
(Genre)-[:INFLUENCED]->(Genre)
```

The first four Release-family relationships are the immediate import priority.
The remaining relationships are added from MusicBrainz relationship records,
Wikidata, AcousticBrainz, and the project's hand-curated genre data.

## Provenance

Every imported node must retain:

- `source`: the dataset name, such as `MusicBrainz` or `Wikidata`;
- `source_entity`: the source's entity category;
- a stable source identifier such as `mbid` or a Wikidata QID.

Human-authored genre relationships must use `source: "curated"`. They should
remain distinct from externally sourced facts rather than being discarded.

## Curation rules

1. Stable source IDs define identity; names and titles do not.
2. Empty values are omitted.
3. Repeated source IDs are deduplicated before CREATE-only bulk ingestion.
4. Nested source objects become nodes and relationships instead of opaque JSON.
5. Invalid records without an identity or display name are quarantined/skipped.
6. Audiobooks, interviews, spoken word, and other non-musical audio must be
   classified explicitly before the public website applies a music-only filter.
7. Browser queries are bounded; the complete graph is never loaded into RAM.
