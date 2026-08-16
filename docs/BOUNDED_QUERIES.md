# Disk-first bounded queries

The reconstructed Samyama HTTP handler deliberately supports a small set of
read queries. Every supported graph-producing query has a hard `LIMIT`; a
request can return at most 1,000 nodes or relationships.

## A page for one website section

```cypher
MATCH (n:Artist)
WHERE id(n) > 0
RETURN n
ORDER BY id(n)
LIMIT 200
```

Replace `Artist` with a stored label such as `Recording`, `Work`, `Label`,
`ReleaseGroup`, `Instrument`, `Release`, `Medium`, `Track`, or `Genre`.

The response contains:

```json
{
  "page": {
    "after_id": 0,
    "next_cursor": 200,
    "limit": 200
  }
}
```

The Next button sends `next_cursor` as the next `id(n) > ...` value. The
browser keeps a stack of earlier cursors for its Previous button. It should not
translate a page number into `SKIP`, because `SKIP` gets slower as the page
number grows.

## One exact node

```cypher
MATCH (n)
WHERE id(n) = 12345
RETURN n
LIMIT 1
```

## A relationship page

```cypher
MATCH (a)-[r]->(b)
WHERE id(r) > 0
RETURN a, r, b
ORDER BY id(r)
LIMIT 100
```

This returns each relationship plus both complete endpoint nodes, so the
visualizer can draw the line and label both ends.

## Safety behavior

The disk-first handler rejects unsupported or unbounded reads, including:

```cypher
MATCH (n) RETURN n
```

This protects Samyama, the API response, and the browser from accidentally
materializing the complete music graph.

## Remaining performance requirement

Filtering a raw RocksDB ID scan by label is bounded in output size, but the
first page may still inspect many earlier IDs before reaching a late-imported
label. Before production deployment, each website section therefore needs
either:

1. a verified starting cursor for its first imported node, or
2. a durable label-to-node-ID index built once for the legacy graph.

The label index is the more general long-term solution. Starting cursors are a
smaller migration for the existing graph because MusicBrainz types were mostly
imported in large, ordered batches.
