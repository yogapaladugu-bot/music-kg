//! HTTP handlers for the Visualizer API

use axum::{
    extract::{Query, State, Json, Multipart},
    response::IntoResponse,
};
use crate::query::Value;
use crate::graph::{Edge, EdgeId, EdgeType, Label, Node, NodeId, PropertyMap, PropertyValue};
use crate::http::server::AppState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, BTreeMap, BTreeSet};
use std::sync::{OnceLock, RwLock as StdRwLock};
use std::sync::atomic::Ordering;
use regex::Regex;

// Native edge batches reuse these external-ID lookups. Without this cache,
// every 5,000-edge request would rescan millions of nodes, erasing the benefit
// of bulk ingestion. Restart the server after importing additional endpoint
// nodes so the lazily rebuilt cache sees them.
static IDENTITY_CACHE: OnceLock<StdRwLock<HashMap<(String, String), std::sync::Arc<HashMap<String, NodeId>>>>> = OnceLock::new();

// Existing music-net records were historically stored in this RocksDB tenant.
// Requests still call the logical graph `music_kg`, but durable reads and writes
// must use `default` so the existing 119M records do not incorrectly look empty.
const DURABLE_TENANT: &str = "default";

/// Request for executing a Cypher query
#[derive(Deserialize)]
pub struct QueryRequest {
    pub query: String,
    #[serde(default = "default_graph")]
    pub graph: String,
}

fn default_graph() -> String {
    "default".to_string()
}

/// Response containing both graph data and raw tabular data
#[derive(Serialize)]
pub struct QueryResponse {
    nodes: Vec<serde_json::Value>,
    edges: Vec<serde_json::Value>,
    columns: Vec<String>,
    records: Vec<Vec<serde_json::Value>>,
}

fn node_json(node: &Node) -> serde_json::Value {
    let properties = node.properties.iter()
        .map(|(key, value)| (key.clone(), value.to_json()))
        .collect::<serde_json::Map<_, _>>();
    json!({
        "id": node.id.as_u64().to_string(),
        "labels": node.labels.iter().map(|label| label.as_str()).collect::<Vec<_>>(),
        "properties": properties,
    })
}

fn edge_json(edge: &Edge) -> serde_json::Value {
    let properties = edge.properties.iter()
        .map(|(key, value)| (key.clone(), value.to_json()))
        .collect::<serde_json::Map<_, _>>();
    json!({
        "id": edge.id.as_u64().to_string(),
        "source": edge.source.as_u64().to_string(),
        "target": edge.target.as_u64().to_string(),
        "type": edge.edge_type.as_str(),
        "properties": properties,
    })
}

/// Recognize the intentionally small, safe Cypher-shaped read interface used
/// by the website.  It is not a second Cypher engine: it simply translates a
/// bounded page request into a RocksDB cursor read.
fn durable_node_query(query: &str) -> Option<(Option<String>, u64, usize)> {
    static PAGE: OnceLock<Regex> = OnceLock::new();
    let regex = PAGE.get_or_init(|| Regex::new(
        r"(?i)^\s*MATCH\s*\(\s*n\s*(?::\s*([A-Za-z_][A-Za-z0-9_]*))?\s*\)\s*(?:WHERE\s+id\s*\(\s*n\s*\)\s*>\s*(\d+)\s*)?RETURN\s+n\s*(?:ORDER\s+BY\s+id\s*\(\s*n\s*\)\s*)?LIMIT\s+(\d+)\s*;?\s*$"
    ).expect("valid bounded-node regex"));
    let captures = regex.captures(query)?;
    let label = captures.get(1).map(|value| value.as_str().to_string());
    let after_id = captures.get(2).and_then(|value| value.as_str().parse().ok()).unwrap_or(0);
    let limit = captures.get(3)?.as_str().parse::<usize>().ok()?.min(1_000);
    Some((label, after_id, limit))
}

fn durable_exact_node_query(query: &str) -> Option<u64> {
    static EXACT: OnceLock<Regex> = OnceLock::new();
    let regex = EXACT.get_or_init(|| Regex::new(
        r"(?i)^\s*MATCH\s*\(\s*n\s*\)\s*WHERE\s+id\s*\(\s*n\s*\)\s*=\s*(\d+)\s*RETURN\s+n\s*(?:LIMIT\s+1\s*)?;?\s*$"
    ).expect("valid exact-node regex"));
    regex.captures(query)?.get(1)?.as_str().parse().ok()
}

fn durable_edge_query(query: &str) -> Option<(u64, usize)> {
    static PAGE: OnceLock<Regex> = OnceLock::new();
    let regex = PAGE.get_or_init(|| Regex::new(
        r"(?i)^\s*MATCH\s*\(\s*a\s*\)\s*-\s*\[\s*r\s*\]\s*->\s*\(\s*b\s*\)\s*(?:WHERE\s+id\s*\(\s*r\s*\)\s*>\s*(\d+)\s*)?RETURN\s+a\s*,\s*r\s*,\s*b\s*(?:ORDER\s+BY\s+id\s*\(\s*r\s*\)\s*)?LIMIT\s+(\d+)\s*;?\s*$"
    ).expect("valid bounded-edge regex"));
    let captures = regex.captures(query)?;
    let after_id = captures.get(1).and_then(|value| value.as_str().parse().ok()).unwrap_or(0);
    let limit = captures.get(2)?.as_str().parse::<usize>().ok()?.min(1_000);
    Some((after_id, limit))
}

/// Handler for Cypher queries
pub async fn query_handler(
    State(state): State<AppState>,
    Json(payload): Json<QueryRequest>,
) -> impl IntoResponse {
    if let Some(persistence) = &state.persistence {
        if let Some(id) = durable_exact_node_query(&payload.query) {
            return match persistence.durable_node(DURABLE_TENANT, id) {
                Ok(Some(node)) => {
                    let value = node_json(&node);
                    Json(json!({"nodes": [value.clone()], "edges": [], "columns": ["n"], "records": [[value]]})).into_response()
                }
                Ok(None) => Json(json!({"nodes": [], "edges": [], "columns": ["n"], "records": []})).into_response(),
                Err(error) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": error.to_string()}))).into_response(),
            };
        }

        if let Some((label, after_id, limit)) = durable_node_query(&payload.query) {
            return match persistence.durable_nodes_page(DURABLE_TENANT, label.as_deref(), after_id, limit) {
                Ok(nodes) => {
                    let values = nodes.iter().map(node_json).collect::<Vec<_>>();
                    let records = values.iter().cloned().map(|value| vec![value]).collect::<Vec<_>>();
                    let next_cursor = nodes.last().map(|node| node.id.as_u64()).unwrap_or(after_id);
                    Json(json!({
                        "nodes": values,
                        "edges": [],
                        "columns": ["n"],
                        "records": records,
                        "page": {"after_id": after_id, "next_cursor": next_cursor, "limit": limit}
                    })).into_response()
                }
                Err(error) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": error.to_string()}))).into_response(),
            };
        }

        if let Some((after_id, limit)) = durable_edge_query(&payload.query) {
            return match persistence.durable_edges_page(DURABLE_TENANT, after_id, limit) {
                Ok(edges) => {
                    let mut nodes = HashMap::new();
                    for edge in &edges {
                        for id in [edge.source.as_u64(), edge.target.as_u64()] {
                            if !nodes.contains_key(&id) {
                                if let Ok(Some(node)) = persistence.durable_node(DURABLE_TENANT, id) {
                                    nodes.insert(id, node_json(&node));
                                }
                            }
                        }
                    }
                    let edge_values = edges.iter().map(edge_json).collect::<Vec<_>>();
                    let records = edges.iter().map(|edge| vec![
                        nodes.get(&edge.source.as_u64()).cloned().unwrap_or(serde_json::Value::Null),
                        edge_json(edge),
                        nodes.get(&edge.target.as_u64()).cloned().unwrap_or(serde_json::Value::Null),
                    ]).collect::<Vec<_>>();
                    let next_cursor = edges.last().map(|edge| edge.id.as_u64()).unwrap_or(after_id);
                    Json(json!({
                        "nodes": nodes.into_values().collect::<Vec<_>>(),
                        "edges": edge_values,
                        "columns": ["a", "r", "b"],
                        "records": records,
                        "page": {"after_id": after_id, "next_cursor": next_cursor, "limit": limit}
                    })).into_response()
                }
                Err(error) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": error.to_string()}))).into_response(),
            };
        }

        // A disk-first graph must never fall through to an unbounded RAM query
        // by accident. Aggregations can be added as explicit fast paths later.
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({
            "error": "Disk-first mode accepts bounded node pages, exact node IDs, and bounded relationship pages only"
        }))).into_response();
    }

    // Check if query is write or read
    let query_upper = payload.query.trim().to_uppercase();
    let is_write = query_upper.starts_with("CREATE") ||
                   query_upper.starts_with("SET") ||
                   query_upper.starts_with("DELETE") ||
                   query_upper.starts_with("MERGE") ||
                   (query_upper.starts_with("MATCH") &&
                    (query_upper.contains(" CREATE ") || query_upper.contains(" SET ") ||
                     query_upper.contains(" DELETE ") || query_upper.contains(" MERGE ") ||
                     query_upper.contains(" REMOVE ") ||
                     query_upper.ends_with(" CREATE") || query_upper.ends_with(" SET") ||
                     query_upper.ends_with(" DELETE") || query_upper.ends_with(" MERGE")));

    let result = if is_write {
        let mut store_guard = state.store.write().await;
        state.engine.execute_mut(&payload.query, &mut *store_guard, &payload.graph)
    } else {
        let store_guard = state.store.read().await;
        state.engine.execute(&payload.query, &*store_guard)
    };

    match result {
        Ok(batch) => {
            let mut nodes = HashMap::new();
            let mut edges = HashMap::new();
            let mut records = Vec::new();

            for record in &batch.records {
                let mut row = Vec::new();
                for col in &batch.columns {
                    let val = record.get(col).unwrap_or(&Value::Null);
                    
                    // Extract graph elements for visualization
                    match val {
                        Value::Node(id, node) => {
                            let mut properties = serde_json::Map::new();
                            for (k, v) in &node.properties {
                                properties.insert(k.clone(), v.to_json());
                            }
                            let node_json = json!({
                                "id": id.as_u64().to_string(),
                                "labels": node.labels.iter().map(|l| l.as_str()).collect::<Vec<_>>(),
                                "properties": properties,
                            });
                            nodes.insert(id.as_u64().to_string(), node_json.clone());
                            row.push(node_json);
                        }
                        Value::NodeRef(id) => {
                            // Lazy ref — minimal JSON (no properties available without store)
                            let node_json = json!({
                                "id": id.as_u64().to_string(),
                                "labels": [],
                                "properties": {},
                            });
                            nodes.insert(id.as_u64().to_string(), node_json.clone());
                            row.push(node_json);
                        }
                        Value::Edge(id, edge) => {
                            let mut properties = serde_json::Map::new();
                            for (k, v) in &edge.properties {
                                properties.insert(k.clone(), v.to_json());
                            }
                            let edge_json = json!({
                                "id": id.as_u64().to_string(),
                                "source": edge.source.as_u64().to_string(),
                                "target": edge.target.as_u64().to_string(),
                                "type": edge.edge_type.as_str(),
                                "properties": properties,
                            });
                            edges.insert(id.as_u64().to_string(), edge_json.clone());
                            row.push(edge_json);
                        }
                        Value::EdgeRef(id, src, tgt, et) => {
                            let edge_json = json!({
                                "id": id.as_u64().to_string(),
                                "source": src.as_u64().to_string(),
                                "target": tgt.as_u64().to_string(),
                                "type": et.as_str(),
                                "properties": {},
                            });
                            edges.insert(id.as_u64().to_string(), edge_json.clone());
                            row.push(edge_json);
                        }
                        Value::Property(p) => {
                            row.push(p.to_json());
                        }
                        Value::Path { nodes: path_nodes, edges: path_edges } => {
                            let path_json = json!({
                                "nodes": path_nodes.iter().map(|n| n.as_u64().to_string()).collect::<Vec<_>>(),
                                "edges": path_edges.iter().map(|e| e.as_u64().to_string()).collect::<Vec<_>>(),
                                "length": path_edges.len(),
                            });
                            row.push(path_json);
                        }
                        Value::Null => {
                            row.push(serde_json::Value::Null);
                        }
                    }
                }
                records.push(row);
            }

            Json(json!({
                "nodes": nodes.values().collect::<Vec<_>>(),
                "edges": edges.values().collect::<Vec<_>>(),
                "columns": batch.columns,
                "records": records,
            })).into_response()
        }
        Err(e) => {
            (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response()
        }
    }
}

/// Report label-index state without scanning any node records.
pub async fn label_index_status_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let Some(persistence) = &state.persistence else {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({
            "error": "Label indices require disk-first persistence"
        }))).into_response();
    };
    let complete = match persistence.label_index_complete() {
        Ok(value) => value,
        Err(error) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": error.to_string()
        }))).into_response(),
    };
    let error = state.label_index_error.lock().ok().and_then(|value| value.clone());
    Json(json!({
        "complete": complete,
        "building": state.label_index_building.load(Ordering::Relaxed),
        "nodes_scanned": state.label_index_scanned.load(Ordering::Relaxed),
        "total_nodes": state.durable_node_count.load(Ordering::Relaxed),
        "error": error,
    })).into_response()
}

/// Start one resumable label-index migration in a blocking worker thread.
/// RocksDB writes are batched by storage.rs; this HTTP request returns before
/// the 119M-node scan begins and repeated POSTs cannot start duplicate jobs.
pub async fn label_index_build_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let Some(persistence) = &state.persistence else {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({
            "error": "Label indices require disk-first persistence"
        }))).into_response();
    };
    match persistence.label_index_complete() {
        Ok(true) => return Json(json!({
            "status": "already_complete"
        })).into_response(),
        Ok(false) => {}
        Err(error) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": error.to_string()
        }))).into_response(),
    }

    // compare_exchange changes false to true atomically. Only the request that
    // wins this operation is allowed to create a worker.
    if state.label_index_building.compare_exchange(
        false, true, Ordering::SeqCst, Ordering::SeqCst
    ).is_err() {
        return (axum::http::StatusCode::CONFLICT, Json(json!({
            "status": "already_building",
            "nodes_scanned": state.label_index_scanned.load(Ordering::Relaxed),
        }))).into_response();
    }

    state.label_index_scanned.store(0, Ordering::Relaxed);
    if let Ok(mut error) = state.label_index_error.lock() { *error = None; }
    let persistence = persistence.clone();
    let building = state.label_index_building.clone();
    let scanned = state.label_index_scanned.clone();
    let error_slot = state.label_index_error.clone();

    tokio::task::spawn_blocking(move || {
        let result = persistence.build_label_index(DURABLE_TENANT, |count| {
            scanned.store(count, Ordering::Relaxed);
        });
        if let Err(error) = result {
            if let Ok(mut slot) = error_slot.lock() { *slot = Some(error.to_string()); }
        }
        building.store(false, Ordering::SeqCst);
    });

    (axum::http::StatusCode::ACCEPTED, Json(json!({
        "status": "started",
        "message": "The disk-backed label index is building in the background"
    }))).into_response()
}

/// Handler for system status
pub async fn status_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let store_guard = state.store.read().await;
    let stats = state.engine.cache_stats();
    let (nodes, edges) = if state.persistence.is_some() {
        (
            state.durable_node_count.load(Ordering::Relaxed),
            state.durable_edge_count.load(Ordering::Relaxed),
        )
    } else {
        (store_guard.node_count() as u64, store_guard.edge_count() as u64)
    };
    Json(json!({
        "status": "healthy",
        "version": crate::VERSION,
        "storage": {
            "nodes": nodes,
            "edges": edges,
        },
        "cache": {
            "hits": stats.hits(),
            "misses": stats.misses(),
            "size": state.engine.cache_len(),
        }
    }))
}

/// Handler for graph schema introspection
pub async fn schema_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let store_guard = state.store.read().await;

    let total_nodes = store_guard.node_count();
    let total_edges = store_guard.edge_count();

    // Build node types: use label_index for counts, sample 1 node per label for property types
    let mut node_types = Vec::new();
    for label in store_guard.all_labels() {
        let count = store_guard.label_node_count(label);
        let mut properties = BTreeMap::new();

        // Sample a single node to discover property names and types (O(1))
        if let Some(&sample_id) = store_guard
            .label_index_ids(label)
            .and_then(|ids| ids.iter().next())
        {
            if let Some(node) = store_guard.get_node(sample_id) {
                for (key, val) in &node.properties {
                    let prop_type = match val {
                        PropertyValue::String(_) => "String",
                        PropertyValue::Integer(_) => "Integer",
                        PropertyValue::Float(_) => "Float",
                        PropertyValue::Boolean(_) => "Boolean",
                        PropertyValue::Vector(_) => "Vector",
                        _ => "Unknown",
                    };
                    properties.insert(key.clone(), prop_type.to_string());
                }
            }
        }

        node_types.push(json!({
            "label": label.as_str(),
            "count": count,
            "properties": properties,
        }));
    }

    // Build edge types: use catalog triple stats for source/target labels (O(1))
    let catalog = store_guard.catalog();
    let triple_stats = catalog.all_triple_stats();

    let mut edge_source_targets: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)> =
        BTreeMap::new();
    for (pattern, _stats) in triple_stats {
        let entry = edge_source_targets
            .entry(pattern.edge_type.as_str().to_string())
            .or_insert_with(|| (BTreeSet::new(), BTreeSet::new()));
        entry.0.insert(pattern.source_label.as_str().to_string());
        entry.1.insert(pattern.target_label.as_str().to_string());
    }

    let mut edge_types = Vec::new();
    for edge_type in store_guard.all_edge_types() {
        let count = store_guard.edge_type_count(edge_type);
        let (source_labels, target_labels) = edge_source_targets
            .get(edge_type.as_str())
            .cloned()
            .unwrap_or_default();

        edge_types.push(json!({
            "type": edge_type.as_str(),
            "count": count,
            "source_labels": source_labels.into_iter().collect::<Vec<_>>(),
            "target_labels": target_labels.into_iter().collect::<Vec<_>>(),
        }));
    }

    let index_list = store_guard.property_index.list_indexes();
    let indexes: Vec<_> = index_list.iter().map(|(l, p)| {
        json!({ "label": l.as_str(), "property": p, "type": "BTREE" })
    }).collect();

    let constraint_list = store_guard.property_index.list_constraints();
    let constraints: Vec<_> = constraint_list.iter().map(|(l, p)| {
        json!({ "label": l.as_str(), "property": p, "type": "UNIQUE" })
    }).collect();

    let avg_out_degree = if total_nodes > 0 {
        total_edges as f64 / total_nodes as f64
    } else {
        0.0
    };

    Json(json!({
        "node_types": node_types,
        "edge_types": edge_types,
        "indexes": indexes,
        "constraints": constraints,
        "statistics": {
            "total_nodes": total_nodes,
            "total_edges": total_edges,
            "avg_out_degree": avg_out_degree,
        }
    }))
}

/// Request for sampling a subgraph for visualization
#[derive(Deserialize)]
pub struct SampleRequest {
    /// Maximum number of nodes to return (default: 200)
    #[serde(default = "default_max_nodes")]
    pub max_nodes: usize,
    /// Optional: only include these labels (empty = all)
    #[serde(default)]
    pub labels: Vec<String>,
    /// Tenant/graph name
    #[serde(default = "default_graph")]
    pub graph: String,
}

fn default_max_nodes() -> usize { 200 }

/// Handler for subgraph sampling — returns a representative subset for visualization
pub async fn sample_handler(
    State(state): State<AppState>,
    Json(payload): Json<SampleRequest>,
) -> impl IntoResponse {
    let store_guard = state.store.read().await;
    let max_nodes = payload.max_nodes.min(1000); // Cap at 1000

    // Determine which labels to sample
    let all_labels = store_guard.all_labels();
    let target_labels: Vec<&crate::graph::Label> = if payload.labels.is_empty() {
        all_labels
    } else {
        let label_set: std::collections::HashSet<&str> = payload.labels.iter().map(|s| s.as_str()).collect();
        all_labels.into_iter().filter(|l| label_set.contains(l.as_str())).collect()
    };

    // Calculate total nodes across target labels
    let total: usize = target_labels.iter().map(|l| store_guard.label_node_count(l)).sum();
    if total == 0 {
        return Json(json!({ "nodes": [], "edges": [], "total_nodes": 0, "total_edges": 0 }));
    }

    // Proportionally sample nodes per label
    let mut sampled_ids: std::collections::HashSet<crate::graph::NodeId> = std::collections::HashSet::new();
    let mut node_list = Vec::new();

    for label in &target_labels {
        let count = store_guard.label_node_count(label);
        let sample_size = ((max_nodes as f64 * count as f64 / total as f64).ceil() as usize).max(1).min(count);
        let nodes = store_guard.get_nodes_by_label(label);

        // Sample evenly across the label's nodes using stride
        let stride = if nodes.len() <= sample_size { 1 } else { nodes.len() / sample_size };
        let mut taken = 0;
        for (i, node) in nodes.iter().enumerate() {
            if taken >= sample_size { break; }
            if i % stride == 0 {
                sampled_ids.insert(node.id);

                // Build node JSON with all properties
                let mut props = serde_json::Map::new();
                for (k, v) in &node.properties {
                    props.insert(k.clone(), match v {
                        PropertyValue::String(s) => json!(s),
                        PropertyValue::Integer(i) => json!(i),
                        PropertyValue::Float(f) => json!(f),
                        PropertyValue::Boolean(b) => json!(b),
                        PropertyValue::Null => json!(null),
                        _ => json!(v.to_string()),
                    });
                }

                // Determine node name (first string property, or id)
                let name = node.properties.iter()
                    .find(|(k, _)| k.as_str() == "name" || k.as_str() == "title" || k.as_str() == "label")
                    .and_then(|(_, v)| match v {
                        PropertyValue::String(s) => Some(s.clone()),
                        _ => None,
                    })
                    .unwrap_or_else(|| format!("{}", node.id.as_u64()));

                node_list.push(json!({
                    "id": node.id.as_u64(),
                    "label": label.as_str(),
                    "name": name,
                    "properties": props,
                }));
                taken += 1;
            }
        }
    }

    // Find edges between sampled nodes
    let mut edge_list = Vec::new();
    for edge_type in store_guard.all_edge_types() {
        for edge in store_guard.get_edges_by_type(edge_type) {
            if sampled_ids.contains(&edge.source) && sampled_ids.contains(&edge.target) {
                let mut props = serde_json::Map::new();
                for (k, v) in &edge.properties {
                    props.insert(k.clone(), match v {
                        PropertyValue::String(s) => json!(s),
                        PropertyValue::Integer(i) => json!(i),
                        PropertyValue::Float(f) => json!(f),
                        PropertyValue::Boolean(b) => json!(b),
                        _ => json!(v.to_string()),
                    });
                }
                edge_list.push(json!({
                    "id": edge.id.as_u64(),
                    "source": edge.source.as_u64(),
                    "target": edge.target.as_u64(),
                    "type": edge_type.as_str(),
                    "properties": props,
                }));
            }
        }
    }

    Json(json!({
        "nodes": node_list,
        "edges": edge_list,
        "total_nodes": total,
        "total_edges": store_guard.edge_count(),
        "sampled_nodes": node_list.len(),
        "sampled_edges": edge_list.len(),
    }))
}

/// Handler for CSV file upload and import
pub async fn import_csv_handler(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut csv_data: Option<String> = None;
    let mut label = String::new();
    let mut id_column: Option<String> = None;
    let mut delimiter = b',';
    let mut graph = "default".to_string();

    loop {
        let field_result: Result<Option<axum::extract::multipart::Field<'_>>, _> = multipart.next_field().await;
        match field_result {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_string();
                match name.as_str() {
                    "file" => {
                        match field.text().await {
                            Ok(text) => csv_data = Some(text),
                            Err(e) => return (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": format!("Failed to read file: {}", e) }))).into_response(),
                        }
                    }
                    "label" => {
                        if let Ok(text) = field.text().await {
                            label = text;
                        }
                    }
                    "id_column" => {
                        if let Ok(text) = field.text().await {
                            id_column = Some(text);
                        }
                    }
                    "delimiter" => {
                        if let Ok(text) = field.text().await {
                            if let Some(&ch) = text.as_bytes().first() {
                                delimiter = ch;
                            }
                        }
                    }
                    "graph" => {
                        if let Ok(text) = field.text().await {
                            graph = text;
                        }
                    }
                    _ => {}
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    let csv_text = match csv_data {
        Some(data) => data,
        None => return (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": "No file field in multipart request" }))).into_response(),
    };

    if label.is_empty() {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": "Missing 'label' field" }))).into_response();
    }

    let mut lines = csv_text.lines();
    let header_line = match lines.next() {
        Some(h) => h,
        None => return (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": "Empty CSV file" }))).into_response(),
    };

    let headers: Vec<&str> = header_line.split(delimiter as char).collect();
    let id_col_idx = id_column.as_ref().and_then(|id_col| headers.iter().position(|h| h.trim() == id_col.as_str()));

    let mut store_guard = state.store.write().await;
    let mut count = 0usize;
    let mut id_map: HashMap<String, crate::graph::NodeId> = HashMap::new();

    for line in lines {
        if line.trim().is_empty() { continue; }
        let fields: Vec<&str> = line.split(delimiter as char).collect();

        let node_id = store_guard.create_node(label.as_str());

        if let Some(idx) = id_col_idx {
            if let Some(val) = fields.get(idx) {
                id_map.insert(val.trim().to_string(), node_id);
            }
        }

        if let Some(node) = store_guard.get_node_mut(node_id) {
            for (i, header) in headers.iter().enumerate() {
                if let Some(value) = fields.get(i) {
                    let trimmed = value.trim();
                    if trimmed.is_empty() { continue; }

                    let prop_val = if let Ok(int_val) = trimmed.parse::<i64>() {
                        PropertyValue::Integer(int_val)
                    } else if let Ok(float_val) = trimmed.parse::<f64>() {
                        PropertyValue::Float(float_val)
                    } else if trimmed.eq_ignore_ascii_case("true") {
                        PropertyValue::Boolean(true)
                    } else if trimmed.eq_ignore_ascii_case("false") {
                        PropertyValue::Boolean(false)
                    } else {
                        PropertyValue::String(trimmed.to_string())
                    };

                    node.set_property(header.trim(), prop_val);
                }
            }
        }
        count += 1;
    }

    Json(json!({
        "status": "ok",
        "nodes_created": count,
        "label": label,
        "graph": graph,
        "columns": headers.iter().map(|h| h.trim()).collect::<Vec<_>>(),
    })).into_response()
}

/// Request for JSON import
#[derive(Deserialize)]
pub struct JsonImportRequest {
    pub label: String,
    pub nodes: Vec<serde_json::Value>,
    #[serde(default = "default_graph")]
    pub graph: String,
}

/// Handler for JSON node import
pub async fn import_json_handler(
    State(state): State<AppState>,
    Json(payload): Json<JsonImportRequest>,
) -> impl IntoResponse {
    if payload.label.is_empty() {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": "Missing 'label' field" }))).into_response();
    }

    // In disk-first mode, construct complete nodes and persist them directly.
    // Nothing is copied into GraphStore, so a 100M-node import does not become
    // a 100M-object RAM allocation.
    if let Some(persistence) = &state.persistence {
        let mut count = 0u64;
        for node_json in &payload.nodes {
            let Some(obj) = node_json.as_object() else { continue };
            let properties: PropertyMap = obj.iter()
                .filter_map(|(key, value)| json_property(value).map(|value| (key.clone(), value)))
                .collect();
            let id = state.next_durable_node_id.fetch_add(1, Ordering::Relaxed);
            let node = Node::new_with_properties(
                NodeId::new(id),
                vec![Label::new(payload.label.as_str())],
                properties,
            );
            if let Err(error) = persistence.persist_create_node(DURABLE_TENANT, &node) {
                return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                    "error": error.to_string(),
                    "nodes_created_before_error": count,
                }))).into_response();
            }
            state.durable_node_count.fetch_add(1, Ordering::Relaxed);
            count += 1;
        }
        let node_count = state.durable_node_count.load(Ordering::Relaxed);
        let edge_count = state.durable_edge_count.load(Ordering::Relaxed);
        let max_node = state.next_durable_node_id.load(Ordering::Relaxed).saturating_sub(1);
        let max_edge = state.next_durable_edge_id.load(Ordering::Relaxed).saturating_sub(1);
        if let Err(error) = persistence.save_durable_stats(node_count, edge_count, max_node, max_edge) {
            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                "error": format!("nodes were written, but counter metadata failed: {}", error),
                "nodes_created": count,
            }))).into_response();
        }
        return Json(json!({
            "status": "ok",
            "nodes_created": count,
            "label": payload.label,
            "storage": "rocksdb",
        })).into_response();
    }

    let mut store_guard = state.store.write().await;
    let mut count = 0usize;

    for node_json in &payload.nodes {
        let node_id = store_guard.create_node(payload.label.as_str());

        if let (Some(node), Some(obj)) = (store_guard.get_node_mut(node_id), node_json.as_object()) {
            for (key, val) in obj {
                let prop_val = match val {
                    serde_json::Value::String(s) => PropertyValue::String(s.clone()),
                    serde_json::Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            PropertyValue::Integer(i)
                        } else if let Some(f) = n.as_f64() {
                            PropertyValue::Float(f)
                        } else {
                            continue;
                        }
                    }
                    serde_json::Value::Bool(b) => PropertyValue::Boolean(*b),
                    _ => continue,
                };
                node.set_property(key, prop_val);
            }
        }
        count += 1;
    }

    Json(json!({
        "status": "ok",
        "nodes_created": count,
        "label": payload.label,
    })).into_response()
}

// One edge in the native bulk relationship request. External string identities
// keep clients independent from Samyama's internal numeric NodeId allocation.
#[derive(Deserialize)]
pub struct JsonEdgeImportRow {
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub target_id: String,
    /// Numeric IDs are the fast, unambiguous choice for disk-first imports.
    #[serde(default)]
    pub source_node_id: Option<u64>,
    #[serde(default)]
    pub target_node_id: Option<u64>,
    pub relationship_type: String,
    #[serde(default)]
    pub properties: serde_json::Map<String, serde_json::Value>,
}

// The endpoint is generic: callers choose the endpoint labels and identity
// property, so the same API can later connect Artists, Recordings, Releases,
// Works, Labels, and other music entities.
#[derive(Deserialize)]
pub struct JsonEdgeImportRequest {
    pub source_label: String,
    pub target_label: String,
    #[serde(default = "default_identity_property")]
    pub source_id_property: String,
    #[serde(default = "default_identity_property")]
    pub target_id_property: String,
    pub edges: Vec<JsonEdgeImportRow>,
    #[serde(default = "default_graph")]
    pub graph: String,
}

fn default_identity_property() -> String {
    "mbid".to_string()
}

// Convert JSON scalars to Samyama properties. Arrays/objects/null are skipped,
// matching the behavior of the existing native JSON node importer.
fn json_property(value: &serde_json::Value) -> Option<PropertyValue> {
    match value {
        serde_json::Value::String(value) => Some(PropertyValue::String(value.clone())),
        serde_json::Value::Number(value) => value
            .as_i64()
            .map(PropertyValue::Integer)
            .or_else(|| value.as_f64().map(PropertyValue::Float)),
        serde_json::Value::Bool(value) => Some(PropertyValue::Boolean(*value)),
        _ => None,
    }
}

// Build an identity map in one O(number-of-nodes-with-label) scan. Both maps
// are built once per HTTP batch, not once per edge; edge creation is then O(1)
// average lookup plus adjacency deduplication.
fn identity_map(
    store: &crate::graph::GraphStore,
    label: &str,
    property: &str,
) -> HashMap<String, NodeId> {
    store
        .get_nodes_by_label(&Label::new(label))
        .into_iter()
        .filter_map(|node| {
            node.get_property(property)
                .and_then(PropertyValue::as_string)
                .map(|identity| (identity.to_string(), node.id))
        })
        .collect()
}

fn cached_identity_map(
    store: &crate::graph::GraphStore,
    label: &str,
    property: &str,
) -> std::sync::Arc<HashMap<String, NodeId>> {
    let cache = IDENTITY_CACHE.get_or_init(|| StdRwLock::new(HashMap::new()));
    let key = (label.to_string(), property.to_string());
    if let Some(existing) = cache.read().unwrap().get(&key) {
        return existing.clone();
    }

    let built = std::sync::Arc::new(identity_map(store, label, property));
    cache.write().unwrap().insert(key, built.clone());
    built
}

/// Native bulk edge ingestion. This bypasses Cypher operators and calls the
/// mutable GraphStore API directly, which avoids the MATCH...CREATE/MERGE HTTP
/// runtime bug and amortizes JSON parsing plus lock acquisition over a batch.
pub async fn import_json_edges_handler(
    State(state): State<AppState>,
    Json(payload): Json<JsonEdgeImportRequest>,
) -> impl IntoResponse {
    if payload.source_label.is_empty() || payload.target_label.is_empty() {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({
            "error": "source_label and target_label are required"
        }))).into_response();
    }
    if payload.edges.len() > 20_000 {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({
            "error": "A native edge batch cannot exceed 20000 rows"
        }))).into_response();
    }


    if let Some(persistence) = &state.persistence {
        let mut created = 0u64;
        let mut invalid = Vec::new();
        for (index, row) in payload.edges.iter().enumerate() {
            let (Some(source), Some(target)) = (row.source_node_id, row.target_node_id) else {
                invalid.push(index);
                continue;
            };
            if row.relationship_type.is_empty()
                || !row.relationship_type.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            {
                invalid.push(index);
                continue;
            }
            let properties: PropertyMap = row.properties.iter()
                .filter_map(|(key, value)| json_property(value).map(|value| (key.clone(), value)))
                .collect();
            let id = state.next_durable_edge_id.fetch_add(1, Ordering::Relaxed);
            let edge = Edge::new_with_properties(
                EdgeId::new(id),
                NodeId::new(source),
                NodeId::new(target),
                EdgeType::new(row.relationship_type.as_str()),
                properties,
            );
            if let Err(error) = persistence.persist_create_edge(DURABLE_TENANT, &edge) {
                return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                    "error": error.to_string(),
                    "edges_created_before_error": created,
                }))).into_response();
            }
            state.durable_edge_count.fetch_add(1, Ordering::Relaxed);
            created += 1;
        }
        let node_count = state.durable_node_count.load(Ordering::Relaxed);
        let edge_count = state.durable_edge_count.load(Ordering::Relaxed);
        let max_node = state.next_durable_node_id.load(Ordering::Relaxed).saturating_sub(1);
        let max_edge = state.next_durable_edge_id.load(Ordering::Relaxed).saturating_sub(1);
        if let Err(error) = persistence.save_durable_stats(node_count, edge_count, max_node, max_edge) {
            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
                "error": format!("edges were written, but counter metadata failed: {}", error),
                "edges_created": created,
            }))).into_response();
        }
        return Json(json!({
            "status": "ok",
            "graph": payload.graph,
            "received": payload.edges.len(),
            "edges_created": created,
            "invalid_edge_indices": invalid,
            "storage": "rocksdb",
        })).into_response();
    }

    let mut store = state.store.write().await;
    let source_ids = cached_identity_map(&store, &payload.source_label, &payload.source_id_property);
    let target_ids = if payload.source_label == payload.target_label
        && payload.source_id_property == payload.target_id_property
    {
        source_ids.clone()
    } else {
        cached_identity_map(&store, &payload.target_label, &payload.target_id_property)
    };

    let mut created = 0usize;
    let mut existing = 0usize;
    let mut missing = Vec::new();
    let mut invalid = Vec::new();

    for (index, row) in payload.edges.iter().enumerate() {
        let Some(&source) = source_ids.get(&row.source_id) else {
            missing.push(index);
            continue;
        };
        let Some(&target) = target_ids.get(&row.target_id) else {
            missing.push(index);
            continue;
        };
        if row.relationship_type.is_empty()
            || !row.relationship_type.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            invalid.push(index);
            continue;
        }

        let edge_type = EdgeType::new(row.relationship_type.as_str());
        // MusicBrainz staging already collapses exact duplicates. Treating the
        // source/target/type triple as the database identity makes retries safe.
        if store.edge_between(source, target, Some(&edge_type)).is_some() {
            existing += 1;
            continue;
        }

        let properties: PropertyMap = row.properties.iter()
            .filter_map(|(key, value)| json_property(value).map(|value| (key.clone(), value)))
            .collect();
        match store.create_edge_with_properties(source, target, edge_type, properties) {
            Ok(_) => created += 1,
            Err(_) => invalid.push(index),
        }
    }

    Json(json!({
        "status": "ok",
        "graph": payload.graph,
        "received": payload.edges.len(),
        "edges_created": created,
        "edges_existing": existing,
        "missing_endpoint_indices": missing,
        "invalid_edge_indices": invalid,
    })).into_response()
}

// ==================== Snapshot Handlers ====================

/// POST /api/snapshot/export — export a .sgsnap snapshot
pub async fn export_snapshot_handler(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let store_guard = state.store.read().await;

    let mut buf = Vec::new();
    match crate::snapshot::export_tenant(&store_guard, &mut buf) {
        Ok(_stats) => (
            axum::http::StatusCode::OK,
            [
                (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
                (axum::http::header::CONTENT_DISPOSITION, "attachment; filename=\"snapshot.sgsnap\""),
            ],
            buf,
        )
            .into_response(),
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Query parameters for snapshot import
#[derive(Deserialize, Default)]
pub struct SnapshotImportParams {
    /// Comma-separated property keys for cross-KG entity deduplication.
    /// e.g. ?dedup_key=name,go_id
    #[serde(default)]
    pub dedup_key: Option<String>,
}

/// POST /api/snapshot/import — import a .sgsnap snapshot
/// Optional query param: ?dedup_key=name,go_id (comma-separated)
pub async fn restore_snapshot_handler(
    State(state): State<AppState>,
    Query(params): Query<SnapshotImportParams>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    // Read the snapshot file from multipart
    let mut snapshot_data: Option<Vec<u8>> = None;

    loop {
        let field_result: Result<Option<axum::extract::multipart::Field<'_>>, _> =
            multipart.next_field().await;
        match field_result {
            Ok(Some(field)) => {
                let name = field.name().unwrap_or("").to_string();
                if name == "file" {
                    match field.bytes().await {
                        Ok(bytes) => snapshot_data = Some(bytes.to_vec()),
                        Err(e) => {
                            return (
                                axum::http::StatusCode::BAD_REQUEST,
                                Json(json!({ "error": format!("Failed to read file: {}", e) })),
                            )
                                .into_response()
                        }
                    }
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    let data = match snapshot_data {
        Some(d) => d,
        None => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "error": "No file field in multipart request" })),
            )
                .into_response()
        }
    };

    let mut store_guard = state.store.write().await;
    let cursor = std::io::Cursor::new(&data);
    let dedup_keys: Vec<String> = params
        .dedup_key
        .map(|s| s.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect())
        .unwrap_or_default();
    let dedup_key_refs: Vec<&str> = dedup_keys.iter().map(|s| s.as_str()).collect();

    match crate::snapshot::import_tenant_with_dedup(&mut store_guard, cursor, &dedup_key_refs) {
        Ok(stats) => {
            // HA-08: Persist snapshot to disk so it survives server restart
            if let Some(ref data_path) = state.data_path {
                let snap_dir = format!("{}/snapshots", data_path);
                if let Err(e) = std::fs::create_dir_all(&snap_dir) {
                    eprintln!("[snapshot-persist] Failed to create dir {}: {}", snap_dir, e);
                } else {
                    let snap_path = format!("{}/default.sgsnap", snap_dir);
                    match std::fs::write(&snap_path, &data) {
                        Ok(_) => eprintln!("[snapshot-persist] Saved {} ({} bytes)", snap_path, data.len()),
                        Err(e) => eprintln!("[snapshot-persist] Failed to write {}: {}", snap_path, e),
                    }
                }
            }

            Json(json!({
                "status": "ok",
                "nodes_imported": stats.node_count,
                "nodes_merged": stats.merged_count,
                "edges_imported": stats.edge_count,
                "labels": stats.labels,
                "edge_types": stats.edge_types,
            }))
            .into_response()
        }
        Err(e) => (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::GraphStore;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        routing::{get, post},
        Router,
    };
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tokio::sync::RwLock;
    use tower::util::ServiceExt;

    /// Build a test router with fresh state and return (router, state).
    fn test_app() -> (Router, AppState) {
        let state = AppState::in_memory(Arc::new(RwLock::new(GraphStore::new())));
        let app = Router::new()
            .route("/api/query", post(query_handler))
            .route("/api/status", get(status_handler))
            .with_state(state.clone());
        (app, state)
    }

    #[test]
    fn test_durable_label_page_query_parser() {
        assert_eq!(
            durable_node_query("MATCH (n:Artist) RETURN n ORDER BY id(n) LIMIT 200"),
            Some((Some("Artist".to_string()), 0, 200)),
        );
        assert_eq!(
            durable_node_query("MATCH (n:Genre) WHERE id(n) > 119338537 RETURN n ORDER BY id(n) LIMIT 50"),
            Some((Some("Genre".to_string()), 119_338_537, 50)),
        );
    }

    #[test]
    fn test_durable_query_limit_is_capped() {
        assert_eq!(
            durable_node_query("MATCH (n:Recording) RETURN n LIMIT 50000"),
            Some((Some("Recording".to_string()), 0, 1_000)),
        );
    }

    /// Helper: send a POST /api/query with the given body and return (status, json).
    async fn post_query(app: Router, body: &str) -> (StatusCode, serde_json::Value) {
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/query")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (status, json)
    }

    /// Helper: send a GET /api/status and return (status, json).
    async fn get_status(app: Router) -> (StatusCode, serde_json::Value) {
        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (status, json)
    }

    // ==================== status_handler tests ====================

    #[tokio::test]
    async fn test_status_handler_empty_store() {
        let (app, _state) = test_app();
        let (status, json) = get_status(app).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["status"], "healthy");
        assert_eq!(json["version"], crate::VERSION);
        assert_eq!(json["storage"]["nodes"], 0);
        assert_eq!(json["storage"]["edges"], 0);
        assert_eq!(json["cache"]["hits"], 0);
        assert_eq!(json["cache"]["misses"], 0);
        assert_eq!(json["cache"]["size"], 0);
    }

    #[tokio::test]
    async fn test_status_handler_after_data_and_queries() {
        let (app, state) = test_app();

        // Seed data into the store
        {
            let mut store = state.store.write().await;
            let alice = store.create_node("Person");
            store.get_node_mut(alice).unwrap().set_property("name", "Alice");
            let bob = store.create_node("Person");
            store.get_node_mut(bob).unwrap().set_property("name", "Bob");
            store.create_edge(alice, bob, "KNOWS").unwrap();
        }

        // Run a query through the engine to populate cache stats
        {
            let store_guard = state.store.read().await;
            let _ = state.engine.execute("MATCH (n:Person) RETURN n", &*store_guard);
        }

        let (status, json) = get_status(app).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["status"], "healthy");
        assert_eq!(json["storage"]["nodes"], 2);
        assert_eq!(json["storage"]["edges"], 1);
        assert_eq!(json["cache"]["misses"], 1);
        assert_eq!(json["cache"]["size"], 1);
    }

    // ==================== query_handler read tests ====================

    #[tokio::test]
    async fn test_query_handler_match_empty_store() {
        let (app, _state) = test_app();

        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH (n:Person) RETURN n"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
        assert!(json["nodes"].as_array().unwrap().is_empty());
        assert!(json["edges"].as_array().unwrap().is_empty());
        assert_eq!(json["columns"], json!(["n"]));
        assert!(json["records"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_query_handler_match_returns_nodes() {
        let (app, state) = test_app();

        // Seed data
        {
            let mut store = state.store.write().await;
            let alice = store.create_node("Person");
            store.get_node_mut(alice).unwrap().set_property("name", "Alice");
            store.get_node_mut(alice).unwrap().set_property("age", 30i64);
        }

        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH (n:Person) RETURN n"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
        // Should return exactly 1 node
        let nodes = json["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 1);

        let node = &nodes[0];
        assert!(node["id"].is_string());
        assert!(node["labels"].as_array().unwrap().contains(&json!("Person")));
        assert_eq!(node["properties"]["name"], "Alice");
        assert_eq!(node["properties"]["age"], 30);

        // Records should also contain 1 row
        let records = json["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);
    }

    #[tokio::test]
    async fn test_query_handler_match_property_projection() {
        let (app, state) = test_app();

        // Seed data
        {
            let mut store = state.store.write().await;
            let n = store.create_node("Person");
            store.get_node_mut(n).unwrap().set_property("name", "Bob");
        }

        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH (n:Person) RETURN n.name"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["columns"], json!(["n.name"]));

        // Property values go through Value::Property branch
        let records = json["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0][0], "Bob");
    }

    #[tokio::test]
    async fn test_query_handler_match_edge_traversal() {
        let (app, state) = test_app();

        // Seed data: Alice -[:KNOWS]-> Bob
        {
            let mut store = state.store.write().await;
            let alice = store.create_node("Person");
            store.get_node_mut(alice).unwrap().set_property("name", "Alice");
            let bob = store.create_node("Person");
            store.get_node_mut(bob).unwrap().set_property("name", "Bob");
            store.create_edge(alice, bob, "KNOWS").unwrap();
        }

        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, r, b"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);

        let records = json["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);

        // Should have edges populated
        let edges = json["edges"].as_array().unwrap();
        assert_eq!(edges.len(), 1);
        let edge = &edges[0];
        assert!(edge["id"].is_string());
        assert!(edge["source"].is_string());
        assert!(edge["target"].is_string());
        assert_eq!(edge["type"], "KNOWS");

        // Should have 2 nodes (Alice and Bob)
        let nodes = json["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 2);
    }

    // ==================== query_handler write tests ====================

    #[tokio::test]
    async fn test_query_handler_create_node() {
        let (app, state) = test_app();

        let (status, _json) = post_query(
            app,
            r#"{"query": "CREATE (n:Movie {title: \"Inception\", year: 2010})"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);

        // Verify the node was actually created in the store
        let store = state.store.read().await;
        assert_eq!(store.node_count(), 1);
    }

    #[tokio::test]
    async fn test_query_handler_create_with_edge() {
        let (app, state) = test_app();

        let (status, _json) = post_query(
            app,
            r#"{"query": "CREATE (a:Person {name: 'Alice'})"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);

        // Verify node was created
        let store = state.store.read().await;
        assert_eq!(store.node_count(), 1);
    }

    #[tokio::test]
    async fn test_query_handler_return_integer_property() {
        let (app, state) = test_app();

        // Seed data with integer property
        {
            let mut store = state.store.write().await;
            let n = store.create_node("Person");
            store.get_node_mut(n).unwrap().set_property("age", 30i64);
        }

        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH (n:Person) RETURN n.age"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
        let records = json["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0][0], 30);
    }

    // ==================== query_handler error tests ====================

    #[tokio::test]
    async fn test_query_handler_parse_error() {
        let (app, _state) = test_app();

        let (status, json) = post_query(
            app,
            r#"{"query": "THIS IS NOT VALID CYPHER!!!"}"#,
        ).await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["error"].is_string());
        assert!(!json["error"].as_str().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_query_handler_malformed_json_returns_error() {
        let (app, _state) = test_app();

        // Sending malformed JSON — axum's Json extractor returns 422
        let req: Request<Body> = Request::builder()
            .method("POST")
            .uri("/api/query")
            .header("content-type", "application/json")
            .body(Body::from("not json"))
            .unwrap();
        let response = app.oneshot(req).await.unwrap();

        // Axum returns 400 Bad Request for deserialization failures
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_query_handler_missing_content_type() {
        let (app, _state) = test_app();

        // Missing content-type header — axum's Json extractor rejects
        let req: Request<Body> = Request::builder()
            .method("POST")
            .uri("/api/query")
            .body(Body::from(r#"{"query": "MATCH (n) RETURN n"}"#))
            .unwrap();
        let response = app.oneshot(req).await.unwrap();

        // Axum returns 415 Unsupported Media Type when content-type is missing
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    // ==================== Value branch coverage tests ====================

    #[tokio::test]
    async fn test_query_handler_null_value() {
        let (app, state) = test_app();

        // Seed a node without 'age' property
        {
            let mut store = state.store.write().await;
            let n = store.create_node("Person");
            store.get_node_mut(n).unwrap().set_property("name", "Alice");
        }

        // Accessing a missing property returns null
        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH (n:Person) RETURN n.age"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
        let records = json["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);
        assert!(records[0][0].is_null(), "Missing property should be null");
    }

    #[tokio::test]
    async fn test_query_handler_named_path() {
        let (app, state) = test_app();

        // Seed data with a path
        {
            let mut store = state.store.write().await;
            let a = store.create_node("Person");
            store.get_node_mut(a).unwrap().set_property("name", "Alice");
            let b = store.create_node("Person");
            store.get_node_mut(b).unwrap().set_property("name", "Bob");
            store.create_edge(a, b, "KNOWS").unwrap();
        }

        // Named path query: p = (a)-[]->(b) RETURN p
        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH p = (a:Person)-[:KNOWS]->(b:Person) RETURN p"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
        let records = json["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);

        // Path JSON should have nodes, edges, and length
        let path = &records[0][0];
        assert!(path["nodes"].is_array());
        assert!(path["edges"].is_array());
        assert!(path["length"].is_number());
        assert_eq!(path["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(path["edges"].as_array().unwrap().len(), 1);
        assert_eq!(path["length"], 1);
    }

    #[tokio::test]
    async fn test_query_handler_multiple_columns() {
        let (app, state) = test_app();

        {
            let mut store = state.store.write().await;
            let n = store.create_node("Person");
            store.get_node_mut(n).unwrap().set_property("name", "Alice");
            store.get_node_mut(n).unwrap().set_property("age", 30i64);
        }

        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH (n:Person) RETURN n.name, n.age, n"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["columns"].as_array().unwrap().len(), 3);

        // Each record row should have 3 values
        let records = json["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].as_array().unwrap().len(), 3);
        // First value: property string
        assert_eq!(records[0][0], "Alice");
        // Second value: property integer
        assert_eq!(records[0][1], 30);
        // Third value: node object
        assert!(records[0][2]["id"].is_string());
    }

    #[tokio::test]
    async fn test_query_handler_node_deduplication() {
        let (app, state) = test_app();

        // Create 2 nodes with edges between them
        {
            let mut store = state.store.write().await;
            let a = store.create_node("Person");
            store.get_node_mut(a).unwrap().set_property("name", "Alice");
            let b = store.create_node("Person");
            store.get_node_mut(b).unwrap().set_property("name", "Bob");
            store.create_edge(a, b, "KNOWS").unwrap();
        }

        // Query returns both nodes
        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a, b"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);

        // The nodes map should deduplicate — 2 unique nodes
        let nodes = json["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 2);
    }

    #[tokio::test]
    async fn test_query_handler_profile_no_panic() {
        let (app, state) = test_app();

        // Seed data
        {
            let mut store = state.store.write().await;
            let n = store.create_node("Person");
            store.get_node_mut(n).unwrap().set_property("name", "Alice");
        }

        // PROFILE should not panic — returns plan-format RecordBatch
        let (status, json) = post_query(
            app,
            r#"{"query": "PROFILE MATCH (n:Person) RETURN n"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
        // Should have plan column in records
        let records = json["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);
    }

    #[tokio::test]
    async fn test_query_handler_count_star() {
        let (app, state) = test_app();

        {
            let mut store = state.store.write().await;
            store.create_node("Person");
            store.create_node("Person");
        }

        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH (n:Person) RETURN count(*) AS total"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
        let records = json["records"].as_array().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0][0], 2);
    }

    #[tokio::test]
    async fn test_query_handler_edge_with_properties() {
        let (app, state) = test_app();

        // Create an edge with properties
        {
            let mut store = state.store.write().await;
            let a = store.create_node("Person");
            store.get_node_mut(a).unwrap().set_property("name", "Alice");
            let b = store.create_node("Person");
            store.get_node_mut(b).unwrap().set_property("name", "Bob");
            let eid = store.create_edge(a, b, "FRIENDS").unwrap();
            store.set_edge_property_sparse(eid, "since", PropertyValue::Integer(2020));
        }

        let (status, json) = post_query(
            app,
            r#"{"query": "MATCH (a:Person)-[r:FRIENDS]->(b:Person) RETURN r"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);

        let edges = json["edges"].as_array().unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0]["type"], "FRIENDS");
        assert_eq!(edges[0]["properties"]["since"], 2020);
    }

    // ==================== query_handler graph param tests ====================

    #[tokio::test]
    async fn test_query_handler_default_graph_param() {
        // When no graph field is sent, should default to "default"
        let (app, _state) = test_app();

        let (status, _json) = post_query(
            app,
            r#"{"query": "MATCH (n) RETURN n"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn test_query_handler_explicit_graph_param() {
        // When graph field is sent, should use that graph
        let (app, _state) = test_app();

        let (status, _json) = post_query(
            app,
            r#"{"query": "MATCH (n) RETURN n", "graph": "test_graph"}"#,
        ).await;

        assert_eq!(status, StatusCode::OK);
    }

}
