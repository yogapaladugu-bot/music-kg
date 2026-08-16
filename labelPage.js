/*
 * SHARED CONTROLLER FOR EVERY LABEL WEBPAGE
 * -----------------------------------------
 * importEdges.js talks to Samyama. This file controls the webpage buttons,
 * cursor history, graph drawing, and node-information panel.
 */

// Each HTML body provides its database label, such as data-label="Artist".
const pageLabel = document.body.dataset.label;
// One hundred nodes draws faster than the previous 200-node page while still
// giving visitors a useful sample of each label.
const pageSize = 100;

// Page cursors remember the last ID before each page. This lets Previous work
// without asking Samyama to count and SKIP millions of earlier records.
const pageCursors = [0];
let pageNumber = 0;
let network;
let visibleLabelNodes; // vis DataSet containing only the current 100-node page.
let indexPollTimer; // Holds one retry timer while the background index is building.

// All label pages provide these three containers.
const networkContainer = document.getElementById("network");
const graphStatus = document.getElementById("graphStatus");
const infoPanel = document.getElementById("info");

// Create the same visible-page search bar on every label webpage. Searching
// only the current bounded batch is instant and cannot scan the full database.
const searchContainer = document.createElement("div");
searchContainer.className = "searchContainer";
const searchInput = document.createElement("input");
searchInput.type = "search";
searchInput.placeholder = `Search these ${pageLabel} nodes`;
searchInput.setAttribute("aria-label", `Search visible ${pageLabel} nodes`);
const searchButton = document.createElement("button");
searchButton.type = "button";
searchButton.textContent = "Search";
searchContainer.append(searchInput, searchButton);
graphStatus.before(searchContainer);

// Create identical pagination controls for every page in one shared place.
const pagination = document.createElement("div");
pagination.id = "pagination";
const previousButton = document.createElement("button");
previousButton.type = "button";
previousButton.textContent = "Previous";
const pageStatus = document.createElement("span");
pageStatus.id = "pageStatus";
const nextButton = document.createElement("button");
nextButton.type = "button";
nextButton.textContent = "Next";
pagination.append(previousButton, pageStatus, nextButton);
graphStatus.before(pagination);

// Replace the current canvas with the newly fetched bounded node batch.
function drawLabelGraph(graph) {
    if (network) network.destroy(); // Release the previous canvas and events.
    visibleLabelNodes = new vis.DataSet(graph.nodes);
    network = new vis.Network(networkContainer, { nodes: visibleLabelNodes, edges: [] }, {
        interaction: { dragNodes: true, dragView: true, hover: true },
        physics: { enabled: true },
    });

    // Show safe text details when the visitor selects a node.
    network.on("click", params => {
        if (!params.nodes.length) return;
        const node = visibleLabelNodes.get(params.nodes[0]);
        infoPanel.replaceChildren();
        const heading = document.createElement("h2");
        heading.textContent = node.label;
        const type = document.createElement("p");
        type.textContent = `Type: ${node.entityType}`;
        const description = document.createElement("p");
        description.textContent = node.description;
        infoPanel.append(heading, type, description);
        infoPanel.style.display = "block";
    });
}

// Find a partial, case-insensitive name match among the nodes currently drawn.
// Searching "beat" can therefore find "The Beatles" without exact spelling.
function searchVisibleLabelNodes() {
    const wanted = searchInput.value.trim().toLocaleLowerCase();
    if (!wanted || !visibleLabelNodes || !network) return;
    const match = visibleLabelNodes.get().find(node =>
        String(node.label).toLocaleLowerCase().includes(wanted)
    );
    if (!match) {
        graphStatus.textContent = `No matching ${pageLabel} is displayed on this page. Try Next or Previous.`;
        return;
    }
    network.selectNodes([match.id]);
    network.focus(match.id, { scale: 1.8, animation: { duration: 600 } });
    graphStatus.textContent = `Focused on ${match.label}.`;
}

// Disable both buttons while awaiting Samyama so double-clicks cannot launch
// multiple copies of the same query.
async function showPage(requestedPage) {
    previousButton.disabled = true;
    nextButton.disabled = true;
    graphStatus.textContent = `Loading up to ${pageSize} ${pageLabel} nodes…`;
    try {
        const cursor = pageCursors[requestedPage];
        const graph = await loadLabelPage(pageLabel, cursor, pageSize);
        // HTTP 200 does not always mean the disk-backed query worked. The old
        // Samyama build can return an empty in-memory result even while RocksDB
        // contains millions of nodes, so treat an empty first page as an error.
        if (requestedPage === 0 && graph.nodes.length === 0) {
            throw new Error(`Samyama returned zero ${pageLabel} nodes. Its bounded disk reader may not be active.`);
        }
        pageNumber = requestedPage;
        drawLabelGraph(graph);
        pageStatus.textContent = `Page ${pageNumber + 1}`;
        previousButton.disabled = pageNumber === 0;
        nextButton.disabled = !graph.hasNextPage;
        graphStatus.textContent = `Showing ${graph.nodes.length} ${pageLabel} nodes. No complete-graph scan was requested.`;

        // The final ID on this page becomes the starting cursor for Next.
        pageCursors[pageNumber + 1] = graph.lastId;
        pageCursors.length = pageNumber + 2;
    } catch (error) {
        console.error(error);
        graphStatus.textContent = `The ${pageLabel} page could not load: ${error.message}`;
        previousButton.disabled = pageNumber === 0;
    }
}

// Never issue a label query until RocksDB says its label index is complete.
// Without this guard, finding 100 late-ID Artists could scan tens of millions
// of unrelated records and make Samyama appear frozen.
async function waitForLabelIndex() {
    previousButton.disabled = true;
    nextButton.disabled = true;
    try {
        const status = await getLabelIndexStatus();
        if (status.complete) {
            clearTimeout(indexPollTimer);
            await showPage(0);
            return;
        }

        const scanned = Number(status.nodes_scanned || 0).toLocaleString();
        const total = Number(status.total_nodes || 0).toLocaleString();
        const state = status.building ? "is building" : "has not started";
        graphStatus.textContent = `The fast label index ${state}: ${scanned} of ${total} nodes inspected. This page will load automatically when it is ready.`;

        // Poll metadata every five seconds. This does not scan graph data.
        indexPollTimer = setTimeout(waitForLabelIndex, 5000);
    } catch (error) {
        console.error(error);
        graphStatus.textContent = `Could not check the label index: ${error.message}`;
        indexPollTimer = setTimeout(waitForLabelIndex, 5000);
    }
}

// Fetch only when navigation is deliberately requested.
previousButton.addEventListener("click", () => showPage(pageNumber - 1));
nextButton.addEventListener("click", () => showPage(pageNumber + 1));
searchButton.addEventListener("click", searchVisibleLabelNodes);
searchInput.addEventListener("keydown", event => {
    // Pressing Enter behaves exactly like clicking the Search button.
    if (event.key === "Enter") searchVisibleLabelNodes();
});

// Opening a label page first confirms that bounded label lookup is safe.
waitForLabelIndex();
