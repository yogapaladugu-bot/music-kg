/*
 * MIXED RELATIONSHIP WEBPAGE CONTROLLER
 * --------------------------------------
 * This file draws 100 relationships at a time. It remains separate from
 * labelPage.js because label pages paginate nodes, while this page paginates
 * relationship IDs and includes both connected endpoint nodes.
 */

const relationshipPageSize = 100;
const relationshipCursors = [0]; // Cursor used to enter every visited page.
let relationshipPageNumber = 0;
let relationshipNetwork;
let visibleRelationshipNodes;

const relationshipContainer = document.getElementById("network");
const relationshipStatus = document.getElementById("graphStatus");
const relationshipInfo = document.getElementById("info");

// Search only endpoint nodes already returned with the current 100 edges.
const relationshipSearch = document.createElement("div");
relationshipSearch.className = "searchContainer";
const relationshipSearchInput = document.createElement("input");
relationshipSearchInput.type = "search";
relationshipSearchInput.placeholder = "Search visible connected nodes";
relationshipSearchInput.setAttribute("aria-label", "Search visible connected nodes");
const relationshipSearchButton = document.createElement("button");
relationshipSearchButton.type = "button";
relationshipSearchButton.textContent = "Search";
relationshipSearch.append(relationshipSearchInput, relationshipSearchButton);
relationshipStatus.before(relationshipSearch);

// Create Previous, page number, and Next with the same CSS used elsewhere.
const relationshipPagination = document.createElement("div");
relationshipPagination.id = "pagination";
const relationshipPrevious = document.createElement("button");
relationshipPrevious.type = "button";
relationshipPrevious.textContent = "Previous";
const relationshipPageStatus = document.createElement("span");
relationshipPageStatus.id = "pageStatus";
const relationshipNext = document.createElement("button");
relationshipNext.type = "button";
relationshipNext.textContent = "Next";
relationshipPagination.append(relationshipPrevious, relationshipPageStatus, relationshipNext);
relationshipStatus.before(relationshipPagination);

// Replace the old canvas so only one bounded graph occupies browser memory.
function drawRelationshipGraph(graph) {
    if (relationshipNetwork) relationshipNetwork.destroy();
    visibleRelationshipNodes = new vis.DataSet(graph.nodes);
    const edges = new vis.DataSet(graph.edges);
    relationshipNetwork = new vis.Network(relationshipContainer, { nodes: visibleRelationshipNodes, edges }, {
        interaction: { dragNodes: true, dragView: true, hover: true },
        physics: { enabled: true },
        edges: { arrows: { to: { enabled: true } }, scaling: { min: 1, max: 5 } },
    });

    // Reuse the safe text-only information panel behavior from label pages.
    relationshipNetwork.on("click", params => {
        if (!params.nodes.length) return;
        const node = visibleRelationshipNodes.get(params.nodes[0]);
        relationshipInfo.replaceChildren();
        const heading = document.createElement("h2");
        heading.textContent = node.label;
        const type = document.createElement("p");
        type.textContent = `Type: ${node.entityType}`;
        const description = document.createElement("p");
        description.textContent = node.description;
        relationshipInfo.append(heading, type, description);
        relationshipInfo.style.display = "block";
    });
}

// Focus the first partial name match among the currently connected nodes.
function searchVisibleRelationshipNodes() {
    const wanted = relationshipSearchInput.value.trim().toLocaleLowerCase();
    if (!wanted || !visibleRelationshipNodes || !relationshipNetwork) return;
    const match = visibleRelationshipNodes.get().find(node =>
        String(node.label).toLocaleLowerCase().includes(wanted)
    );
    if (!match) {
        relationshipStatus.textContent = "No matching node is displayed on this relationship page.";
        return;
    }
    relationshipNetwork.selectNodes([match.id]);
    relationshipNetwork.focus(match.id, { scale: 1.8, animation: { duration: 600 } });
    relationshipStatus.textContent = `Focused on ${match.label}.`;
}

// Fetch exactly one bounded relationship page and remember its next cursor.
async function showRelationshipPage(requestedPage) {
    relationshipPrevious.disabled = true;
    relationshipNext.disabled = true;
    relationshipStatus.textContent = `Loading up to ${relationshipPageSize} relationships…`;
    try {
        const graph = await loadRelationshipPage(
            relationshipCursors[requestedPage], relationshipPageSize
        );
        if (requestedPage === 0 && graph.edges.length === 0) {
            throw new Error("Samyama returned zero relationships.");
        }
        relationshipPageNumber = requestedPage;
        drawRelationshipGraph(graph);
        relationshipPageStatus.textContent = `Page ${relationshipPageNumber + 1}`;
        relationshipPrevious.disabled = relationshipPageNumber === 0;
        relationshipNext.disabled = !graph.hasNextPage;
        relationshipStatus.textContent = `Showing ${graph.edges.length} relationships connecting ${graph.nodes.length} nodes.`;

        // The next request begins after the final relationship shown here.
        relationshipCursors[relationshipPageNumber + 1] = graph.lastId;
        relationshipCursors.length = relationshipPageNumber + 2;
    } catch (error) {
        console.error(error);
        relationshipStatus.textContent = `The relationship graph could not load: ${error.message}`;
        relationshipPrevious.disabled = relationshipPageNumber === 0;
    }
}

// Requests happen only after the corrected direct-ID reader is deployed.
relationshipPrevious.addEventListener("click", () => showRelationshipPage(relationshipPageNumber - 1));
relationshipNext.addEventListener("click", () => showRelationshipPage(relationshipPageNumber + 1));
relationshipSearchButton.addEventListener("click", searchVisibleRelationshipNodes);
relationshipSearchInput.addEventListener("keydown", event => {
    if (event.key === "Enter") searchVisibleRelationshipNodes();
});

// Do not automatically trigger the legacy edge iterator: live testing showed
// that even three edges could read hundreds of megabytes and delay Samyama.
// Re-enable showRelationshipPage(0) after the direct-ID build is deployed.
relationshipPrevious.disabled = true;
relationshipNext.disabled = true;
relationshipPageStatus.textContent = "Temporarily unavailable";
relationshipStatus.textContent = "The relationship reader is being optimized; label pages remain available.";
