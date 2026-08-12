/*
 * BROWSER USER INTERFACE
 * ----------------------
 * importEdges.js supplies loadGraph(); vis-network supplies the global `vis`
 * object; this file connects both of them to the controls in index.html.
 *
 * Beginner glossary:
 * - `const`: a variable that will not be reassigned.
 * - `let`: a variable whose value may change later.
 * - `function`: reusable instructions that run when called.
 * - `async`/`await`: wait for work such as an HTTP request without freezing.
 * - event listener: a function the browser calls after a click or keypress.
 */

// Look up each HTML control once and retain a reference to it.
const button = document.getElementById("hide");
const searchButton = document.getElementById("searchButton");
const searchInput = document.getElementById("search");

    
// These are assigned after Samyama has responded in startGraph().
let nodes;
let edges;
const container = document.getElementById("network");
const info = document.getElementById("info");
const graphStatus = document.getElementById("graphStatus");
// const data = {
//     nodes: nodes,
//     edges: edges
// };

const options = { //combines nodes and edges into one object and determines which features this object will comprise of
      interaction: {
        dragNodes: true,
        dragView: true, //able to drag the entire graph, not just individual nodes
    },
    physics:{
    enabled:true
    // barnesHut:{
    //     gravitationalConstant:-2000,
    //     centralGravity:0.3,
    //     springLength:95,
    //     springConstant:0.04,
    // }

},
// configure:{
//     enabled:true,
//     container: document.getElementById("config"),
//     filter:'physics',
//     showButton:false},
edges: { 
    arrows:{
        to:{
            enabled:true
        }
    },
    scaling: { //controls how thick edges are and these values are given to the edges above
        min: 1,
        max: 5
    }
}};
// const network = new vis.Network( //creating the graph with the data you have!
//     container, //where it should appear
//     data, //what should be displayed
//     options //how it should behave
// );

// The vis Network instance is kept here so searchGenre() can focus it later.
let network;

async function startGraph(){
    // Large disk-backed graph queries can take several seconds. Showing this
    // message distinguishes "still loading" from a genuinely empty webpage.
    info.textContent = "Loading connected music data…";
    info.style.display = "block";
    graphStatus.textContent = "Connecting to Samyama and finding three connected relationships…";
    try {
        // Fetch plain arrays, then wrap them in vis DataSets. DataSets allow
        // later calls such as get() and interactive selection.
        const graph = await loadGraph();
        graphStatus.textContent = `Received ${graph.nodes.length} nodes and ${graph.edges.length} edges. Drawing them now…`;
        if (!graph.nodes.length || !graph.edges.length) {
            throw new Error("Samyama returned no connected graph data.");
        }

        nodes = new vis.DataSet(graph.nodes);
        edges = new vis.DataSet(graph.edges);


        const data = { nodes, edges };


        network = new vis.Network(container, data, options);
        // vis-network exposes `.on()` for graph events.
        network.on("click", onClick);
        network.once("afterDrawing", () => {
            graphStatus.textContent = `Showing ${graph.nodes.length} connected nodes and ${graph.edges.length} relationships.`;
        });
        info.style.display = "none";
    } catch (error) {
        console.error(error);
        info.textContent = `The graph could not load: ${error.message}`;
        info.style.display = "block";
        graphStatus.textContent = `Graph error: ${error.message}`;
    }

}

// Begin loading only after all three browser scripts have been evaluated.
startGraph();

function hideBox(){
        // Hide both the information panel and its close button.
        info.style.display = "none";
        button.style.display = "none";
}
function searchGenre(){
    let searchTerm = searchInput.value.toLowerCase(); //makes the search term lowercase so that it can be compared to the lowercase labels of the nodes
    let allNodes = nodes.get(); //gets all the nodes from the node object
    for(let i of allNodes){ //loops through all the nodes
        if(i.label.toLowerCase() === searchTerm){ //makes the label of the node lowercase and compares it to the search term
            network.focus(i.id, {scale: 2, animation: {duration: 1000}}); //if equal, focuses on the node(using its id) and zooms in on it with a scale of 2 and an animation duration of 1000 milliseconds
            network.selectNodes([i.id]); //selects the node using its id
            break;
        }
    }
}
function clickEnter(event){
    // Reuse the button's click handler instead of duplicating search logic.
    if(event.key === "Enter"){
        searchButton.click();
    }
}
function onClick(params){ //params is the information about the click event and then params.nodes is simply an array which goes into more specific about the details given by js when you click smth, if the array is empty, you did not click on a node
    if(params.nodes.length > 0){ //checks to see if the user clicked on a node
        let nodeID = params.nodes[0]; //in the nodes object, the first index value is the id so gets the nodes id

        let genre = nodes.get(nodeID); //gets the entire node object using the id and stores it in a variable called genre

        // Build elements with textContent instead of inserting database/user
        // text into innerHTML. This fixes the XSS issue identified in REVIEW.md.
        info.replaceChildren();
        const heading = document.createElement("h2");
        heading.textContent = genre.label;
        info.appendChild(heading);

        const typeLine = document.createElement("p");
        typeLine.textContent = `Type: ${genre.entityType ?? "Unknown"}`;
        info.appendChild(typeLine);

        const descriptionLine = document.createElement("p");
        descriptionLine.textContent = genre.description || "No description is available yet.";
        info.appendChild(descriptionLine);

        if (genre.year) {
            const dateLine = document.createElement("p");
            dateLine.textContent = `Date: ${genre.year}`;
            info.appendChild(dateLine);
        }
         info.style.display = "block";
    button.style.display = "block";
    }
   
}
// Wire HTML events to the functions above. Passing a function name here does
// not run it immediately; the browser runs it when the event happens.
searchButton.addEventListener("click", searchGenre);
button.addEventListener("click", hideBox);
searchInput.addEventListener("keypress", clickEnter);
