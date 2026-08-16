/*
 * GRAPH LOADER FOR THE WEBPAGE
 * ----------------------------
 * Despite its old filename, this file does not import edges into Samyama.
 * It reads nodes and edges FROM Samyama and converts them to the object shape
 * expected by vis-network. script.js then draws those objects.
 *
 * Never request the entire database here. A browser cannot draw millions of
 * nodes, and serializing that response can exhaust Samyama's memory. The
 * webpage intentionally loads only a bounded preview until search-driven
 * neighborhood loading is added.
 */

// Use the explicit IPv4 loopback address so the browser and terminal reach the
// same Docker port even if `localhost` prefers IPv6 on one of them.
const TSAMYAMA_URL = "http://127.0.0.1:8080/api/query";
// Label pages check this lightweight endpoint before querying. It reads one
// metadata key—not 119 million nodes—so it remains safe during migration.
const LABEL_INDEX_STATUS_URL = "http://127.0.0.1:8080/api/index/labels/status";
const GENRE_NODES_URL = "data/staged/wikidata/genres.jsonl";
const GENRE_EDGES_URL = "data/staged/wikidata/subgenre-edges.jsonl";
let genreDataPromise;

// Return the progress of Samyama's persistent label index. Keeping this next
// to the query loader means every label webpage uses the same server contract.
async function getLabelIndexStatus() {
    const response = await fetch(LABEL_INDEX_STATUS_URL, {
        method: "GET",
        cache: "no-store",
    });
    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Label-index status returned HTTP ${response.status}: ${details}`);
    }
    return response.json();
}

// One visual identity per graph entity type. Keeping this mapping in one place
// means every Artist, Release, Track, and future search result is styled the
// same way without adding a redundant `color` property to millions of nodes.
const ENTITY_STYLES = {
    Artist:       { background: "#1ed760", border: "#8af0ae" }, // green
    Recording:    { background: "#3b82f6", border: "#93c5fd" }, // blue
    Work:         { background: "#8b5cf6", border: "#c4b5fd" }, // violet
    Label:        { background: "#f97316", border: "#fdba74" }, // orange
    ReleaseGroup: { background: "#ec4899", border: "#f9a8d4" }, // pink
    Release:      { background: "#eab308", border: "#fde047" }, // gold
    Medium:       { background: "#14b8a6", border: "#5eead4" }, // teal
    Track:        { background: "#06b6d4", border: "#67e8f9" }, // cyan
    Instrument:   { background: "#ef4444", border: "#fca5a5" }, // red
    Genre:        { background: "#a3e635", border: "#d9f99d" }, // lime
    Series:       { background: "#6366f1", border: "#a5b4fc" }, // indigo
    Event:        { background: "#f43f5e", border: "#fda4af" }, // rose
};

// Unknown future labels remain visible instead of silently receiving a broken
// style. This neutral color also makes unsupported types easy to notice.
const DEFAULT_ENTITY_STYLE = { background: "#64748b", border: "#cbd5e1" };

function entityType(node) {
    // Samyama returns labels as an array. source_entity is a useful fallback for
    // older imported records whose label may not be included by another API.
    const label = node.labels?.[0];
    if (label) return label;
    const sourceEntity = node.properties?.source_entity;
    if (!sourceEntity) return "Unknown";
    // Convert release-group into ReleaseGroup to match the style table.
    return sourceEntity.split("-").map(part =>
        part.charAt(0).toUpperCase() + part.slice(1)
    ).join("");
}
// Build a short explanation from facts already stored on the node. Doing this
// when a node is displayed avoids writing duplicated sentences millions of
// times into the database.
function factualDescription(type, properties = {}) {
    const p = properties;
    const milliseconds = Number(p.length_ms);
    const duration = Number.isFinite(milliseconds)
        ? `${Math.floor(milliseconds / 60000)}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}`
        : "";
    const descriptions = {
        Artist: `${p.artist_type || "Artist"}${p.country ? ` associated with ${p.country}` : ""}.`,
        Recording: `A recorded musical performance${duration ? ` lasting ${duration}` : ""}.`,
        Work: `${p.work_type || "Musical work"}${p.language ? ` in ${p.language}` : ""}.`,
        Label: `${p.label_type || "Music label or related organization"}${p.country ? ` associated with ${p.country}` : ""}.`,
        ReleaseGroup: `${p.primary_type || "Release group"}${p.first_release_date ? ` first released ${p.first_release_date}` : ""}.`,
        Release: `${p.status || "Music"} release${p.packaging ? ` issued as ${p.packaging}` : ""}${p.country ? ` in ${p.country}` : ""}${p.release_date ? ` on ${p.release_date}` : ""}.`,
        Medium: `${p.format || "Release medium"}${p.position ? ` at position ${p.position}` : ""}${p.track_count ? ` containing ${p.track_count} tracks` : ""}.`,
        Track: `A track${p.number ? ` numbered ${p.number}` : ""}${duration ? ` lasting ${duration}` : ""}.`,
        Instrument: `${p.instrument_type || "Musical instrument or voice type"}.`,
        Genre: `A music genre${p.inception ? ` documented from ${String(p.inception).slice(0, 4)}` : ""}${p.country ? ` associated with ${p.country}` : ""}.`,
    };
    return p.description || p.disambiguation || descriptions[type]
        || `A ${type.toLowerCase()} entity in the music knowledge graph.`;
}

function visualNode(node) {
    const type = entityType(node);
    const colors = ENTITY_STYLES[type] ?? DEFAULT_ENTITY_STYLE;
    return {
        id: node.id,
        label: node.properties.name ?? node.properties.title ?? `${type} ${node.id}`,
        entityType: type,
        color: {
            background: colors.background,
            border: colors.border,
            highlight: { background: colors.border, border: "#ffffff" },
            hover: { background: colors.border, border: "#ffffff" },
        },
        borderWidth: 2,
        // vis-network draws node labels on a canvas, so ordinary CSS text
        // colors cannot reach them. Set their font color on the node itself.
        font: { color: "#ffffff" },
        description: factualDescription(type, node.properties),
        year: node.properties.year ?? node.properties.release_date
            ?? node.properties.first_release_date ?? "",
        artists: node.properties.artists ?? "",
        shape: "dot",
    };
}

/*
 * LOAD ONE BOUNDED PAGE FOR A PARTICULAR NODE LABEL
 * -------------------------------------------------
 * Every label page calls this same function, so database-query logic does not
 * need to be copied into ten separate HTML files.
 */
async function loadLabelPage(label, afterId = 0, pageSize = 200) {
    // Labels become part of the Cypher text. Only accept labels in our schema
    // so arbitrary webpage text can never be inserted into the query.
    const allowedLabels = new Set([
        "Artist", "Recording", "Work", "Label", "ReleaseGroup",
        "Release", "Medium", "Track", "Instrument", "Genre",
    ]);
    if (!allowedLabels.has(label)) {
        throw new Error(`The node label ${label} is not supported.`);
    }

    // Convert browser values to safe integers and enforce a 500-node ceiling.
    const safeAfterId = Math.max(0, Number.parseInt(afterId, 10) || 0);
    const safePageSize = Math.min(500, Math.max(1, Number.parseInt(pageSize, 10) || 200));

    // A cursor means "start after the last ID already shown." This avoids the
    // repeated counting work that a large SKIP value would cause.
    const query = `MATCH (n:${label}) WHERE id(n) > ${safeAfterId} RETURN n ORDER BY id(n) LIMIT ${safePageSize}`;
    const response = await fetch(TSAMYAMA_URL, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        // The historical RocksDB keys use the storage tenant `default`. The
        // visible website is still the Music Knowledge Graph; this value only
        // tells the bounded disk reader where those existing records live.
        body: JSON.stringify({ graph: "default", query }),
    });

    // Preserve Samyama's response text because it usually explains failures.
    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Samyama returned HTTP ${response.status}: ${details}`);
    }

    const data = await response.json();
    // Normal responses expose data.nodes. The records fallback also accepts a
    // query response shaped like [[node], [node], ...].
    const rawNodes = data.nodes?.length
        ? data.nodes
        : (data.records ?? []).map(record => Array.isArray(record) ? record[0] : record.n).filter(Boolean);

    // Deduplicate the response for drawing only; this does not change RocksDB.
    const uniqueNodes = [...new Map(rawNodes.map(node => [node.id, node])).values()];
    const numericIds = uniqueNodes.map(node => Number(node.id)).filter(Number.isFinite);
    const lastId = numericIds.length ? Math.max(...numericIds) : safeAfterId;

    return {
        nodes: uniqueNodes.map(visualNode),
        edges: [], // Relationships will be added as a separate bounded step.
        lastId,
        hasNextPage: uniqueNodes.length === safePageSize,
        query,
    };
}

/*
 * LOAD ONE BOUNDED PAGE OF MIXED RELATIONSHIPS
 * --------------------------------------------
 * This powers relationships.html. Unlike a label page, it intentionally shows
 * connections from across the complete music schema so visitors can see how
 * Artists, Releases, Tracks, Recordings, and other entities fit together.
 */
async function loadRelationshipPage(afterId = 0, pageSize = 100) {
    // Relationship IDs provide the cursor, just as node IDs paginate label
    // pages. A 100-item default and 500-item ceiling protect the visualizer.
    const safeAfterId = Math.max(0, Number.parseInt(afterId, 10) || 0);
    const safePageSize = Math.min(500, Math.max(1, Number.parseInt(pageSize, 10) || 100));
    const query = `MATCH (a)-[r]->(b) WHERE id(r) > ${safeAfterId} RETURN a,r,b ORDER BY id(r) LIMIT ${safePageSize}`;

    const response = await fetch(TSAMYAMA_URL, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        // Historical RocksDB records are stored under the `default` tenant.
        body: JSON.stringify({ graph: "default", query }),
    });
    if (!response.ok) {
        const details = await response.text();
        throw new Error(`Samyama returned HTTP ${response.status}: ${details}`);
    }

    const data = await response.json();
    // The bounded server normally returns these top-level arrays. Reconstruct
    // them from a,r,b records as a compatibility fallback.
    const rawNodes = data.nodes?.length
        ? data.nodes
        : (data.records ?? []).flatMap(record => [record[0], record[2]]).filter(Boolean);
    const rawEdges = data.edges?.length
        ? data.edges
        : (data.records ?? []).map(record => record[1]).filter(Boolean);
    const uniqueNodes = [...new Map(rawNodes.map(node => [node.id, node])).values()];

    // Convert Samyama relationships to the field names expected by vis-network.
    const visualEdges = rawEdges.map(edge => {
        const relationshipType = edge.type ?? "RELATED_TO";
        const readableType = relationshipType.toLowerCase().replaceAll("_", " ");
        return {
            id: edge.id,
            from: edge.source,
            to: edge.target,
            relationshipType,
            value: edge.properties?.strength ?? 1,
            title: edge.properties?.description
                ?? edge.properties?.musicbrainz_type
                ?? `This ${readableType} relationship connects the two music records.`,
        };
    });
    const numericIds = rawEdges.map(edge => Number(edge.id)).filter(Number.isFinite);

    return {
        nodes: uniqueNodes.map(visualNode),
        edges: visualEdges,
        lastId: numericIds.length ? Math.max(...numericIds) : safeAfterId,
        hasNextPage: rawEdges.length === safePageSize,
        query,
    };
}

async function loadGraph(){
    // Ask for connected paths in one request. Samyama returns every endpoint
    // node used by these relationships, so vis-network can draw every edge.
    const response = await fetch(TSAMYAMA_URL, {
        method:"POST",
        cache: "no-store",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
            // The server can contain several named graphs. Without this field,
            // Samyama may successfully query an empty default graph.
            graph: "music_kg",
            query: "MATCH (a)-[r]->(b) RETURN a,r,b LIMIT 100"
        })
    });
    if (!response.ok) throw new Error(`Samyama query failed with HTTP ${response.status}.`);
    const data = await response.json();
    console.log(data);
    // Normal Samyama responses provide top-level `nodes` and `edges`. Rebuild
    // those arrays from records as a compatibility fallback if an endpoint
    // returns only the three query columns.
    const rawNodes = data.nodes?.length
        ? data.nodes
        : [...new Map((data.records ?? []).flatMap(record => [record[0], record[2]])
            .filter(Boolean).map(node => [node.id, node])).values()];
    const rawEdges = data.edges?.length
        ? data.edges
        : (data.records ?? []).map(record => record[1]).filter(Boolean);
    return {
        nodes: rawNodes.map(visualNode),
        edges: rawEdges.map(edge => {
            const relationshipType = edge.type ?? "RELATED_TO";
            const readableType = relationshipType.toLowerCase().replaceAll("_", " ");
            return {
                from: edge.source,
                to: edge.target,
                value: edge.properties?.strength ?? 1,
                relationshipType,
                title: edge.properties?.description
                    ?? edge.properties?.musicbrainz_type
                    ?? `This ${readableType} relationship connects the two music records.`,
            };
        }),
    };
}

// A JSONL file stores one JSON object on each line. These staged files are
// small enough for a browser to cache once, while only one 50-node slice is
// converted into a vis-network graph at any moment.
function parseJsonLines(text) {
    return text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
}

async function loadAllGenreData() {
    if (!genreDataPromise) {
        genreDataPromise = Promise.all([
            fetch(GENRE_NODES_URL, { cache: "no-store" }),
            fetch(GENRE_EDGES_URL, { cache: "no-store" }),
        ]).then(async ([nodeResponse, edgeResponse]) => {
            if (!nodeResponse.ok || !edgeResponse.ok) {
                throw new Error("The prepared Wikidata Genre files could not be loaded.");
            }
            return {
                nodes: parseJsonLines(await nodeResponse.text()),
                edges: parseJsonLines(await edgeResponse.text()),
            };
        });
    }
    return genreDataPromise;
}

async function loadGenrePage(pageIndex, pageSize = 50) {
    const all = await loadAllGenreData();
    const pageCount = Math.ceil(all.nodes.length / pageSize);
    const safePage = Math.max(0, Math.min(pageIndex, pageCount - 1));
    const records = all.nodes.slice(safePage * pageSize, (safePage + 1) * pageSize);
    const visibleQids = new Set(records.map(record => record.qid));

    const rawNodes = records.map(record => ({
        id: record.qid,
        labels: ["Genre"],
        properties: record,
    }));
    const pageEdges = all.edges
        .filter(edge => visibleQids.has(edge.source_id) && visibleQids.has(edge.target_id))
        .map((edge, index) => ({
            from: edge.source_id,
            to: edge.target_id,
            value: 1,
            relationshipType: edge.relationship_type,
            title: "This genre is classified as a subgenre of the connected genre.",
            id: `${safePage}-${index}`,
        }));

    return {
        nodes: rawNodes.map(visualNode),
        edges: pageEdges,
        pageIndex: safePage,
        pageCount,
        totalNodes: all.nodes.length,
    };
}
