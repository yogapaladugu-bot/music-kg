/*
 * LEGACY BROWSER IMPORTER
 * -----------------------
 * This file imports the small hand-written arrays from data.js. It is useful
 * for learning and for the original genre demo, but it is NOT the scalable
 * MusicBrainz importer. The scripts/ directory contains the command-line
 * importers used for millions of records.
 *
 * Because this file runs in a browser, `fetch` sends HTTP requests directly
 * to the locally running Samyama server. index.html currently leaves this
 * script commented out so merely opening the page cannot re-import the demo.
 */
const SAMYAMA_URL = "http://localhost:8080/api/query";


// ---------- IMPORT NODES ----------

async function importNodes(){
    // `await` pauses this function until each request finishes. This is simple
    // and predictable, although deliberately slower than a bounded batch job.
    for(let node of OGnodes){
        // Build one POST request containing one Cypher CREATE query.
        const response = await fetch(SAMYAMA_URL,{
            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body: JSON.stringify({
                query: `
                    CREATE (n:Genre {
                        name: "${node.label}",
                        description: "${node.description}",
                        year: "${node.year}",
                        artists: "${node.artists}"
                    })
                    RETURN n
                `
            })
        });

        // Convert the response body from JSON text into a JavaScript value.
        const data = await response.json();

        console.log("Node imported:", node.label);
        console.log(data);
    }
}




function getGenreName(id){
    // Edges store numeric IDs, while Cypher below matches genres by name.
    let node = OGnodes.find(node => node.id === id);
    // `.find` returns the first object whose id matches the requested id.
    return node.label;
}


// ---------- IMPORT EDGES ----------

 async function importEdges(){
     // Import an edge only after its two endpoint nodes exist.
     for(let edge of OGedges){

        let fromName = getGenreName(edge.from);
        let toName = getGenreName(edge.to);


         const response = await fetch(SAMYAMA_URL,{
             method:"POST",
             headers:{
                 "Content-Type":"application/json"
             },
             body: JSON.stringify({

                 query: `
                     MATCH (a:Genre {name:"${fromName}"})
                     MATCH (b:Genre {name:"${toName}"})

                     CREATE (a)-[r:INFLUENCED {
                         strength: ${edge.value},
                         description: "${edge.title}"
                     }]->(b)

                     RETURN r
                 `
            })
         });


         const data = await response.json();

         console.log(
             `${fromName} → ${toName}`,
             data
         );
     }
 }


// ---------- RUN IMPORT ----------

async function runImport(){
    // Function calls execute in order because each one is awaited.
    await importNodes();

   await importEdges();

    console.log("Finished importing music");
}


// Start the asynchronous workflow. This legacy file logs request failures in
// the browser console; the command-line importers have fuller error reports.
runImport();
