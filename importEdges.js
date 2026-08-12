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
        description: factualDescription(type, node.properties),
        year: node.properties.year ?? node.properties.release_date
            ?? node.properties.first_release_date ?? "",
        artists: node.properties.artists ?? "",
        shape: "dot",
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
