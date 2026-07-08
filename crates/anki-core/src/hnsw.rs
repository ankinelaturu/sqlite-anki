//! Compact, dependency-free HNSW approximate nearest-neighbor index.
//!
//! A pure-Rust, single-threaded HNSW (Hierarchical Navigable Small World) graph
//! built for `wasm32-unknown-emscripten`. The `hnsw_rs` crate was evaluated but
//! pulls `rayon`/`num_cpus`/`mmap-rs`, which don't fit a single-threaded,
//! no-pthread WASM build (see `docs/design-choices.md` §7 and `docs/DESIGN.md` §9).
//!
//! Vectors are assumed L2-normalized (the embedder normalizes), so cosine
//! similarity is the dot product and distance is `1 - dot`. One index is built
//! per `TEXT VECTOR` column; the `anki` vtab rebuilds it from its in-memory
//! cache when the data changes, so only build + search are needed here.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::collections::HashMap;
use std::collections::HashSet;

/// Max neighbors per node above layer 0 (DESIGN: `M = 16`).
const M: usize = 16;
/// Max neighbors per node on layer 0.
const M0: usize = 2 * M;
/// Candidate list size during construction.
const EF_CONSTRUCTION: usize = 100;
/// Version tag of the serialized-graph blob ([`Hnsw::serialize`]). Independent
/// of the shadow-table `storage_format`: the persisted graph is an optional
/// cache, so a version mismatch just falls back to a rebuild rather than
/// refusing to open the table. Bump on any layout change.
const GRAPH_FORMAT: u32 = 1;

/// Little-endian cursor over a byte slice for [`Hnsw::deserialize`]. Every read
/// is bounds-checked and returns `None` past the end, so a truncated or corrupt
/// blob can never panic (fatal under `panic = abort`) or over-read.
struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let end = self.pos.checked_add(n)?;
        let s = self.b.get(self.pos..end)?;
        self.pos = end;
        Some(s)
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
    fn i64(&mut self) -> Option<i64> {
        Some(i64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut s = 0.0f32;
    for i in 0..n {
        s += a[i] * b[i];
    }
    s
}

/// A `(distance, node)` heap entry ordered by distance (`node` breaks ties).
#[derive(Clone, Copy)]
struct Cand {
    dist: f32,
    node: u32,
}

impl PartialEq for Cand {
    fn eq(&self, other: &Self) -> bool {
        self.dist == other.dist && self.node == other.node
    }
}
impl Eq for Cand {}
impl Ord for Cand {
    fn cmp(&self, other: &Self) -> Ordering {
        self.dist
            .total_cmp(&other.dist)
            .then(self.node.cmp(&other.node))
    }
}
impl PartialOrd for Cand {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// An HNSW index over fixed-dimension, L2-normalized vectors.
pub struct Hnsw {
    /// Stored vectors, indexed by internal node id.
    vectors: Vec<Vec<f32>>,
    /// Internal node id -> user rowid.
    ids: Vec<i64>,
    /// `neighbors[node][level]` = neighbor node ids at that level.
    neighbors: Vec<Vec<Vec<u32>>>,
    /// Tombstones: `dead[node]` marks a removed node. Dead nodes stay wired into
    /// the graph as routing hops (so it stays connected) but are filtered out of
    /// `search` results. `rebuild`/`build` compacts them away.
    dead: Vec<bool>,
    /// Live rowid -> node id, for O(1) incremental `remove`. Holds only live
    /// nodes; a re-added rowid overwrites its previous (now-dead) node.
    id_to_node: HashMap<i64, u32>,
    entry: Option<u32>,
    max_level: usize,
    ml: f64,
    rng: u64,
}

impl Hnsw {
    fn new(seed: u64) -> Self {
        Self {
            vectors: Vec::new(),
            ids: Vec::new(),
            neighbors: Vec::new(),
            dead: Vec::new(),
            id_to_node: HashMap::new(),
            entry: None,
            max_level: 0,
            ml: 1.0 / (M as f64).ln(),
            rng: seed | 1,
        }
    }

    /// Builds an index from `(rowid, vector)` pairs. Returns `None` if empty.
    pub fn build(points: &[(i64, Vec<f32>)]) -> Option<Hnsw> {
        if points.is_empty() {
            return None;
        }
        let mut idx = Hnsw::new(0x9E3779B97F4A7C15);
        let mut visited = vec![false; points.len()];
        for (id, v) in points {
            idx.insert(*id, v.clone(), &mut visited);
        }
        Some(idx)
    }

    /// Incrementally inserts a single `(rowid, vector)` into the live graph
    /// (~O(log N)), so a write need not trigger a full [`Hnsw::build`]. If
    /// `id` is already present, its prior node is tombstoned first so the rowid
    /// resolves to exactly one live node. Manages its own `visited` scratch.
    pub fn add(&mut self, id: i64, vector: Vec<f32>) {
        self.remove(id);
        let mut visited = vec![false; self.vectors.len() + 1];
        self.insert(id, vector, &mut visited);
    }

    /// Tombstones the node for `id` (O(1) via `id_to_node`); a no-op if absent.
    /// The node stays wired in as a routing hop but is excluded from `search`
    /// results. Tombstones accumulate until the next full [`Hnsw::build`]
    /// (rebuild) compacts them out.
    pub fn remove(&mut self, id: i64) {
        if let Some(node) = self.id_to_node.remove(&id) {
            self.dead[node as usize] = true;
        }
    }

    /// Compacts tombstones for the on-disk and export forms: returns the live
    /// (non-dead) node indices, an `old -> new` dense remap (`u32::MAX` for dead),
    /// a re-picked entry (dense index of a surviving top-layer node — the old entry
    /// may itself be tombstoned), and the surviving max level. `None` if no live
    /// nodes remain. Shared by [`Hnsw::serialize`], [`Hnsw::to_json`], and
    /// [`Hnsw::to_dot`] so all three emit the same dense, gap-free node indices.
    fn compact(&self) -> Option<(Vec<u32>, Vec<u32>, u32, usize)> {
        let mut remap = vec![u32::MAX; self.ids.len()];
        let mut live: Vec<u32> = Vec::new();
        for n in 0..self.ids.len() as u32 {
            if !self.dead[n as usize] {
                remap[n as usize] = live.len() as u32;
                live.push(n);
            }
        }
        if live.is_empty() {
            return None;
        }
        let mut entry = 0u32;
        let mut max_level = 0usize;
        for (new_i, &old) in live.iter().enumerate() {
            let lvl = self.neighbors[old as usize].len().saturating_sub(1);
            if lvl >= max_level {
                max_level = lvl;
                entry = new_i as u32;
            }
        }
        Some((live, remap, entry, max_level))
    }

    /// Serializes the graph *topology* to a versioned little-endian blob so it
    /// can be persisted and reloaded instead of rebuilt on the next open (see
    /// docs/streaming-storage.md, roadmap #2 in docs/TODO.md). The stored
    /// vectors are **not** written — they already live in the shadow table's
    /// `anki_emb_<col>` blobs and are rehydrated by [`Hnsw::deserialize`].
    ///
    /// Tombstoned nodes are compacted out here (dead nodes are dropped, live
    /// node indices are remapped, and a live top-level node becomes the entry),
    /// since a deleted rowid's vector is gone from the shadow and can't be
    /// rehydrated. Returns `None` if no live nodes remain.
    ///
    /// # Blob layout
    ///
    /// All integers little-endian. A fixed 24-byte header, then one
    /// variable-length record per node (and, within it, per level):
    ///
    /// | Section                  | Field        | Type           | Notes                                  |
    /// |--------------------------|--------------|----------------|----------------------------------------|
    /// | Header                   | `version`    | `u32`          | `GRAPH_FORMAT`                         |
    /// |                          | `node_count` | `u32`          | number of live nodes                   |
    /// |                          | `max_level`  | `u32`          | top layer index                        |
    /// |                          | `entry`      | `u32`          | entry node index, or `u32::MAX` = none |
    /// |                          | `rng`        | `u64`          | SplitMix64 state                       |
    /// | Per node (×`node_count`) | `id`         | `i64`          | rowid                                  |
    /// |                          | `levels`     | `u32`          | number of layers this node is on       |
    /// | Per level (×`levels`)    | `degree`     | `u32`          | neighbor count at this layer           |
    /// |                          | `neighbors`  | `u32`×`degree` | neighbor **node indices** (not rowids) |
    pub fn serialize(&self) -> Option<Vec<u8>> {
        let (live, remap, entry, max_level) = self.compact()?;
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&GRAPH_FORMAT.to_le_bytes());
        buf.extend_from_slice(&(live.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(max_level as u32).to_le_bytes());
        buf.extend_from_slice(&entry.to_le_bytes());
        buf.extend_from_slice(&self.rng.to_le_bytes());
        for &old in &live {
            buf.extend_from_slice(&self.ids[old as usize].to_le_bytes());
            let levels = &self.neighbors[old as usize];
            buf.extend_from_slice(&(levels.len() as u32).to_le_bytes());
            for lvl in levels {
                // Drop neighbors that were tombstoned; remap the survivors.
                let kept: Vec<u32> = lvl
                    .iter()
                    .filter_map(|&nb| match remap.get(nb as usize) {
                        Some(&r) if r != u32::MAX => Some(r),
                        _ => None,
                    })
                    .collect();
                buf.extend_from_slice(&(kept.len() as u32).to_le_bytes());
                for &nb in &kept {
                    buf.extend_from_slice(&nb.to_le_bytes());
                }
            }
        }
        Some(buf)
    }

    /// Rebuilds an index from a [`Hnsw::serialize`] blob, rehydrating each node's
    /// vector via `vec_for_id` (which reads the shadow table's `anki_emb_<col>`
    /// blob for a rowid). Returns `None` on any version mismatch, truncation, or
    /// out-of-range index, or if a referenced rowid's vector is missing — the
    /// caller then falls back to a full rebuild. Parsing is fully bounds-checked
    /// and allocation is bounded by the actual buffer length: a corrupt blob can
    /// only yield `None`, never a panic (which under `panic = abort` would kill
    /// the whole wasm instance) or a runaway allocation.
    pub fn deserialize(
        bytes: &[u8],
        mut vec_for_id: impl FnMut(i64) -> Option<Vec<f32>>,
    ) -> Option<Hnsw> {
        let mut r = Reader { b: bytes, pos: 0 };
        if r.u32()? != GRAPH_FORMAT {
            return None;
        }
        let n = r.u32()? as usize;
        let max_level = r.u32()? as usize;
        let entry_raw = r.u32()?;
        let rng = r.u64()?;
        if n == 0 {
            return None;
        }

        let mut idx = Hnsw::new(rng);
        idx.max_level = max_level;
        idx.entry = if entry_raw == u32::MAX { None } else { Some(entry_raw) };
        for node in 0..n {
            let id = r.i64()?;
            let vector = vec_for_id(id)?;
            let nlevels = r.u32()? as usize;
            let mut levels: Vec<Vec<u32>> = Vec::new();
            for _ in 0..nlevels {
                let deg = r.u32()? as usize;
                let mut nbrs: Vec<u32> = Vec::new();
                for _ in 0..deg {
                    let nb = r.u32()?;
                    if nb as usize >= n {
                        return None; // neighbor index out of range → corrupt
                    }
                    nbrs.push(nb);
                }
                levels.push(nbrs);
            }
            idx.vectors.push(vector);
            idx.ids.push(id);
            idx.neighbors.push(levels);
            idx.dead.push(false);
            idx.id_to_node.insert(id, node as u32);
        }
        // Structural sanity: the entry (if any) and max_level must be in range.
        match idx.entry {
            Some(e) if e as usize >= n => return None,
            _ => {}
        }
        if max_level >= n && n > 0 {
            // max_level is a layer index; it can't exceed the node count.
            return None;
        }
        Some(idx)
    }

    /// Like [`Hnsw::deserialize`] but for callers that only need the *topology*
    /// (visualization / debugging via [`Hnsw::to_json`] / [`Hnsw::to_dot`]) and
    /// have no vectors to rehydrate. Node vectors are left empty, so the result
    /// must not be used for `search` — only for reading `ids`/`neighbors`/entry.
    pub fn deserialize_topology(bytes: &[u8]) -> Option<Hnsw> {
        Hnsw::deserialize(bytes, |_| Some(Vec::new()))
    }

    /// Exports the graph topology as JSON for visualization/debugging:
    /// `{"entry":<node|null>,"max_level":M,"nodes":[{"node","rowid","level"},…],
    /// "edges":[{"a","b","layer"},…]}`. `node` is the compact internal index;
    /// `rowid` joins back to the table for a label. Tombstoned nodes and their
    /// edges are omitted; edges are undirected and de-duplicated per layer
    /// (`a < b`). Output is deterministic. Vectors are not needed, so this works
    /// on a graph loaded via [`Hnsw::deserialize_topology`].
    pub fn to_json(&self) -> String {
        let Some((live, remap, entry, max_level)) = self.compact() else {
            return String::from("{\"entry\":null,\"max_level\":0,\"nodes\":[],\"edges\":[]}");
        };
        let mut s = format!("{{\"entry\":{entry},\"max_level\":{max_level},\"nodes\":[");
        for (new_i, &old) in live.iter().enumerate() {
            if new_i > 0 {
                s.push(',');
            }
            let level = self.neighbors[old as usize].len().saturating_sub(1);
            s.push_str(&format!(
                "{{\"node\":{},\"rowid\":{},\"level\":{}}}",
                new_i, self.ids[old as usize], level
            ));
        }
        s.push_str("],\"edges\":[");
        let mut first = true;
        let mut seen: HashSet<(u32, u32, usize)> = HashSet::new();
        for &old in &live {
            let a0 = remap[old as usize];
            for (layer, nbrs) in self.neighbors[old as usize].iter().enumerate() {
                for &m in nbrs {
                    let b0 = match remap.get(m as usize) {
                        Some(&r) if r != u32::MAX => r,
                        _ => continue,
                    };
                    let (a, b) = (a0.min(b0), a0.max(b0));
                    if a == b || !seen.insert((a, b, layer)) {
                        continue;
                    }
                    if !first {
                        s.push(',');
                    }
                    first = false;
                    s.push_str(&format!("{{\"a\":{a},\"b\":{b},\"layer\":{layer}}}"));
                }
            }
        }
        s.push_str("]}");
        s
    }

    /// Exports the graph as Graphviz DOT (undirected) for a quick render. Node
    /// labels are rowids; the entry node is emphasized; each edge is colored by
    /// its highest layer so the sparse upper-layer "express lanes" stand out.
    /// Tombstoned nodes are omitted; output is deterministic (edges sorted).
    pub fn to_dot(&self) -> String {
        let mut s = String::from("graph hnsw {\n  node [shape=circle fontsize=10];\n");
        let Some((live, remap, entry, _)) = self.compact() else {
            s.push_str("}\n");
            return s;
        };
        for (new_i, &old) in live.iter().enumerate() {
            if new_i as u32 == entry {
                s.push_str(&format!(
                    "  {new_i} [label=\"{}\" color=\"#c0392b\" penwidth=2];\n",
                    self.ids[old as usize]
                ));
            } else {
                s.push_str(&format!("  {new_i} [label=\"{}\"];\n", self.ids[old as usize]));
            }
        }
        // Collapse multi-layer edges to one, keyed by the highest layer they span.
        let mut edge_layer: HashMap<(u32, u32), usize> = HashMap::new();
        for &old in &live {
            let a0 = remap[old as usize];
            for (layer, nbrs) in self.neighbors[old as usize].iter().enumerate() {
                for &m in nbrs {
                    let b0 = match remap.get(m as usize) {
                        Some(&r) if r != u32::MAX => r,
                        _ => continue,
                    };
                    let (a, b) = (a0.min(b0), a0.max(b0));
                    if a == b {
                        continue;
                    }
                    let e = edge_layer.entry((a, b)).or_insert(0);
                    *e = (*e).max(layer);
                }
            }
        }
        let mut edges: Vec<((u32, u32), usize)> = edge_layer.into_iter().collect();
        edges.sort_unstable();
        for ((a, b), layer) in edges {
            let (color, pw) = if layer == 0 { ("#cccccc", 1) } else { ("#2c7fb8", 2) };
            s.push_str(&format!("  {a} -- {b} [color=\"{color}\" penwidth={pw}];\n"));
        }
        s.push_str("}\n");
        s
    }

    /// Returns the `k` approximate nearest rowids to `query` as `(rowid, cosine
    /// similarity)`, best-first. `ef` is the search beam width (`>= k`).
    /// Tombstoned nodes are traversed for routing but never returned.
    pub fn search(&self, query: &[f32], k: usize, ef: usize) -> Vec<(i64, f32)> {
        let mut ep = match self.entry {
            Some(e) => e,
            None => return Vec::new(),
        };
        let mut visited = vec![false; self.vectors.len()];
        for lc in (1..=self.max_level).rev() {
            let w = self.search_layer(query, &[ep], 1, lc, &mut visited);
            if let Some(&(_, n)) = w.first() {
                ep = n;
            }
        }
        let w = self.search_layer(query, &[ep], ef.max(k), 0, &mut visited);
        w.into_iter()
            .filter(|(_, n)| !self.dead[*n as usize])
            .take(k)
            .map(|(d, n)| (self.ids[n as usize], 1.0 - d))
            .collect()
    }

    fn next_level(&mut self) -> usize {
        // SplitMix64 step -> uniform in (0,1) -> exponential level.
        self.rng = self.rng.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.rng;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^= z >> 31;
        let u = ((z >> 11) as f64 / (1u64 << 53) as f64).max(1e-12);
        (-u.ln() * self.ml) as usize
    }

    fn dist(&self, q: &[f32], node: u32) -> f32 {
        1.0 - dot(q, &self.vectors[node as usize])
    }

    fn insert(&mut self, id: i64, vec: Vec<f32>, visited: &mut Vec<bool>) {
        let node = self.vectors.len() as u32;
        let level = self.next_level();
        self.vectors.push(vec);
        self.ids.push(id);
        self.neighbors.push((0..=level).map(|_| Vec::new()).collect());
        self.dead.push(false);
        self.id_to_node.insert(id, node);
        if visited.len() < self.vectors.len() {
            visited.resize(self.vectors.len(), false);
        }

        let entry = match self.entry {
            Some(e) => e,
            None => {
                self.entry = Some(node);
                self.max_level = level;
                return;
            }
        };

        let q = self.vectors[node as usize].clone();
        let mut ep = entry;

        // Greedy descent through layers above the new node's top level.
        let mut lc = self.max_level;
        while lc > level {
            let w = self.search_layer(&q, &[ep], 1, lc, visited);
            if let Some(&(_, n)) = w.first() {
                ep = n;
            }
            lc -= 1;
        }

        // Connect from the new node's top level down to 0.
        let start = self.max_level.min(level);
        for lc in (0..=start).rev() {
            let w = self.search_layer(&q, &[ep], EF_CONSTRUCTION, lc, visited);
            let mmax = if lc == 0 { M0 } else { M };
            let selected = self.select_neighbors(&w, mmax);
            for &nb in &selected {
                self.neighbors[node as usize][lc].push(nb);
                self.neighbors[nb as usize][lc].push(node);
                if self.neighbors[nb as usize][lc].len() > mmax {
                    self.prune(nb, lc, mmax);
                }
            }
            if let Some(&(_, n)) = w.first() {
                ep = n;
            }
        }

        if level > self.max_level {
            self.max_level = level;
            self.entry = Some(node);
        }
    }

    /// HNSW neighbor-selection heuristic (paper Algorithm 4). A candidate is
    /// kept only if it is closer to the base than to any already-selected
    /// neighbor, which spreads connections out and keeps the graph connected
    /// (naive "closest `m`" pruning can disconnect nodes). `candidates` must be
    /// sorted closest-first by distance to the base. Falls back to filling with
    /// the remaining closest to reach `m` (keepPrunedConnections).
    fn select_neighbors(&self, candidates: &[(f32, u32)], m: usize) -> Vec<u32> {
        let mut result: Vec<u32> = Vec::with_capacity(m);
        for &(d, e) in candidates {
            if result.len() >= m {
                break;
            }
            let e_vec = &self.vectors[e as usize];
            let diverse = result
                .iter()
                .all(|&r| 1.0 - dot(e_vec, &self.vectors[r as usize]) > d);
            if diverse {
                result.push(e);
            }
        }
        if result.len() < m {
            for &(_, e) in candidates {
                if result.len() >= m {
                    break;
                }
                if !result.contains(&e) {
                    result.push(e);
                }
            }
        }
        result
    }

    /// Re-selects `node`'s neighbors at `lc` down to `mmax` using the heuristic.
    fn prune(&mut self, node: u32, lc: usize, mmax: usize) {
        let base = self.vectors[node as usize].clone();
        let mut list: Vec<(f32, u32)> = self.neighbors[node as usize][lc]
            .iter()
            .map(|&nb| (1.0 - dot(&base, &self.vectors[nb as usize]), nb))
            .collect();
        list.sort_by(|a, b| a.0.total_cmp(&b.0));
        self.neighbors[node as usize][lc] = self.select_neighbors(&list, mmax);
    }

    /// Greedy best-first search at one layer. Returns up to `ef` results sorted
    /// closest-first. Uses and restores the shared `visited` buffer.
    fn search_layer(
        &self,
        q: &[f32],
        entry_points: &[u32],
        ef: usize,
        lc: usize,
        visited: &mut [bool],
    ) -> Vec<(f32, u32)> {
        let mut touched: Vec<u32> = Vec::new();
        // candidates: min-heap (closest first); result: max-heap (farthest first).
        let mut candidates: BinaryHeap<std::cmp::Reverse<Cand>> = BinaryHeap::new();
        let mut result: BinaryHeap<Cand> = BinaryHeap::new();

        for &ep in entry_points {
            let d = self.dist(q, ep);
            visited[ep as usize] = true;
            touched.push(ep);
            candidates.push(std::cmp::Reverse(Cand { dist: d, node: ep }));
            result.push(Cand { dist: d, node: ep });
        }

        while let Some(std::cmp::Reverse(c)) = candidates.pop() {
            let farthest = result.peek().map(|x| x.dist).unwrap_or(f32::INFINITY);
            if c.dist > farthest {
                break;
            }
            if let Some(nbrs) = self.neighbors[c.node as usize].get(lc) {
                for &e in nbrs {
                    if visited[e as usize] {
                        continue;
                    }
                    visited[e as usize] = true;
                    touched.push(e);
                    let d = self.dist(q, e);
                    let farthest = result.peek().map(|x| x.dist).unwrap_or(f32::INFINITY);
                    if d < farthest || result.len() < ef {
                        candidates.push(std::cmp::Reverse(Cand { dist: d, node: e }));
                        result.push(Cand { dist: d, node: e });
                        if result.len() > ef {
                            result.pop();
                        }
                    }
                }
            }
        }

        for t in touched {
            visited[t as usize] = false;
        }

        let mut out: Vec<(f32, u32)> = result.into_iter().map(|c| (c.dist, c.node)).collect();
        out.sort_by(|a, b| a.0.total_cmp(&b.0));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(mut v: Vec<f32>) -> Vec<f32> {
        let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if n > 0.0 {
            for x in &mut v {
                *x /= n;
            }
        }
        v
    }

    fn brute_top(points: &[(i64, Vec<f32>)], q: &[f32], k: usize) -> Vec<i64> {
        let mut s: Vec<(f32, i64)> = points
            .iter()
            .map(|(id, v)| (dot(q, v), *id))
            .collect();
        s.sort_by(|a, b| b.0.total_cmp(&a.0));
        s.into_iter().take(k).map(|(_, id)| id).collect()
    }

    #[test]
    fn recall_matches_brute_force() {
        let dim = 32;
        let n = 800;
        let mut rng = 0x1234_5678_9ABC_DEF0u64;
        let mut next = || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
        };

        let points: Vec<(i64, Vec<f32>)> = (0..n)
            .map(|i| (i as i64, norm((0..dim).map(|_| next()).collect())))
            .collect();
        let idx = Hnsw::build(&points).expect("index");

        let k = 10;
        let mut hits = 0usize;
        let mut total = 0usize;
        for _ in 0..50 {
            let q = norm((0..dim).map(|_| next()).collect());
            let exact: std::collections::HashSet<i64> =
                brute_top(&points, &q, k).into_iter().collect();
            let got = idx.search(&q, k, 64);
            assert_eq!(got.len(), k);
            // similarity must be sorted best-first
            for w in got.windows(2) {
                assert!(w[0].1 >= w[1].1 - 1e-6);
            }
            hits += got.iter().filter(|(id, _)| exact.contains(id)).count();
            total += k;
        }
        let recall = hits as f64 / total as f64;
        assert!(recall >= 0.85, "recall too low: {recall}");
    }

    #[test]
    fn exact_nearest_always_retrieved() {
        // Querying with a stored vector must return that row as the top match.
        // Regression guard: naive pruning disconnected nodes so exact matches
        // went missing at moderate n.
        let dim = 64;
        let n = 400;
        let mut rng = 0xDEAD_BEEF_CAFE_1234u64;
        let mut next = || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
        };
        let points: Vec<(i64, Vec<f32>)> = (0..n)
            .map(|i| (1000 + i as i64, norm((0..dim).map(|_| next()).collect())))
            .collect();
        let idx = Hnsw::build(&points).expect("index");

        for step in (0..n).step_by(7) {
            let (id, ref v) = points[step];
            let got = idx.search(v, 5, 64);
            assert_eq!(got[0].0, id, "exact match {id} not retrieved first");
            assert!((got[0].1 - 1.0).abs() < 1e-4, "self-similarity not ~1.0");
        }
    }

    #[test]
    fn empty_and_single() {
        assert!(Hnsw::build(&[]).is_none());
        let idx = Hnsw::build(&[(7, norm(vec![1.0, 0.0, 0.0]))]).unwrap();
        let got = idx.search(&[1.0, 0.0, 0.0], 5, 16);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, 7);
        assert!((got[0].1 - 1.0).abs() < 1e-5);
    }

    /// Deterministic pseudo-random vector generator for the incremental tests.
    fn gen_points(n: usize, dim: usize, seed: u64) -> Vec<(i64, Vec<f32>)> {
        let mut rng = seed;
        let mut next = move || {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((rng >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
        };
        (0..n)
            .map(|i| (i as i64, norm((0..dim).map(|_| next()).collect())))
            .collect()
    }

    #[test]
    fn incremental_add_matches_build() {
        // A graph grown one node at a time via `add` should retrieve exact
        // matches just like one built in bulk — `build` is `insert` looped, and
        // `add` is the same splice with its own scratch.
        let dim = 48;
        let points = gen_points(300, dim, 0xA11CE);
        // Seed with one point so the index exists, then splice the rest in.
        let mut idx = Hnsw::build(&points[..1]).expect("index");
        for (id, v) in &points[1..] {
            idx.add(*id, v.clone());
        }
        for step in (0..points.len()).step_by(11) {
            let (id, ref v) = points[step];
            let got = idx.search(v, 5, 64);
            assert_eq!(got[0].0, id, "exact match {id} not retrieved after incremental add");
            assert!((got[0].1 - 1.0).abs() < 1e-4);
        }
    }

    #[test]
    fn remove_excludes_row() {
        // A removed rowid must never appear in results, even when we query with
        // its own stored vector.
        let dim = 32;
        let points = gen_points(200, dim, 0xBEEF);
        let mut idx = Hnsw::build(&points).expect("index");
        let (victim_id, ref victim_v) = points[57];
        idx.remove(victim_id);
        let got = idx.search(victim_v, 10, 64);
        assert!(got.iter().all(|(id, _)| *id != victim_id), "removed row still returned");
        // A live neighbor should still be reachable.
        assert!(!got.is_empty(), "graph unreachable after a single removal");
    }

    #[test]
    fn add_after_remove_updates_row() {
        // Update semantics (remove + re-add with a new vector): the row is found
        // by its new vector, not by its old one.
        let dim = 32;
        let points = gen_points(200, dim, 0xF00D);
        let mut idx = Hnsw::build(&points).expect("index");
        let id = points[42].0;
        let old_v = points[42].1.clone();
        // A fresh, well-separated vector for the same rowid.
        let new_v = norm({
            let mut v = vec![0.0f32; dim];
            v[0] = 1.0;
            v
        });
        idx.remove(id);
        idx.add(id, new_v.clone());

        let by_new = idx.search(&new_v, 3, 64);
        assert_eq!(by_new[0].0, id, "row not retrieved by its new vector");
        assert!((by_new[0].1 - 1.0).abs() < 1e-4);

        let by_old = idx.search(&old_v, 5, 64);
        assert!(
            by_old.iter().all(|(rid, _)| *rid != id) || by_old[0].0 != id,
            "old vector should no longer resolve to the updated row as top match"
        );
    }

    #[test]
    fn remove_all_returns_empty() {
        let points = gen_points(50, 16, 0x1357);
        let mut idx = Hnsw::build(&points).expect("index");
        for (id, _) in &points {
            idx.remove(*id);
        }
        let got = idx.search(&points[0].1, 5, 64);
        assert!(got.is_empty(), "expected no results after removing every row");
    }

    /// Builds an `id -> vector` lookup mirroring what the shadow table's
    /// `anki_emb_<col>` blobs provide at load time.
    fn vec_lookup(points: &[(i64, Vec<f32>)]) -> HashMap<i64, Vec<f32>> {
        points.iter().cloned().collect()
    }

    #[test]
    fn serialize_roundtrip_preserves_search() {
        // A graph reloaded from its serialized topology (with vectors rehydrated
        // from the id->vector map) must return the same exact matches as the
        // original — proving persistence can replace a cold rebuild on open.
        let dim = 48;
        let points = gen_points(300, dim, 0x5EED);
        let idx = Hnsw::build(&points).expect("index");
        let blob = idx.serialize().expect("serialized");

        let map = vec_lookup(&points);
        let reloaded = Hnsw::deserialize(&blob, |id| map.get(&id).cloned()).expect("deserialized");

        for step in (0..points.len()).step_by(13) {
            let (id, ref v) = points[step];
            let a = idx.search(v, 5, 64);
            let b = reloaded.search(v, 5, 64);
            assert_eq!(b[0].0, id, "reloaded graph lost exact match {id}");
            assert_eq!(
                a.iter().map(|x| x.0).collect::<Vec<_>>(),
                b.iter().map(|x| x.0).collect::<Vec<_>>(),
                "reloaded ranking diverged from the original for query {id}",
            );
        }
    }

    #[test]
    fn serialize_compacts_tombstones() {
        // Removed rows must be compacted out of the serialized blob: their
        // vectors are gone from the shadow, so deserialize must never ask for
        // them (the lookup returns None for removed ids) yet still succeed.
        let dim = 32;
        let points = gen_points(200, dim, 0xC0FFEE);
        let mut idx = Hnsw::build(&points).expect("index");
        let removed: Vec<i64> = (0..200).step_by(3).map(|i| points[i].0).collect();
        for id in &removed {
            idx.remove(*id);
        }
        let blob = idx.serialize().expect("serialized");

        // Lookup only knows the surviving rows.
        let live: HashMap<i64, Vec<f32>> = points
            .iter()
            .filter(|(id, _)| !removed.contains(id))
            .cloned()
            .collect();
        let reloaded =
            Hnsw::deserialize(&blob, |id| live.get(&id).cloned()).expect("deserialized live-only");

        for id in &removed {
            let (_, ref v) = points[*id as usize];
            let got = reloaded.search(v, 10, 64);
            assert!(got.iter().all(|(rid, _)| rid != id), "removed {id} came back");
        }
        // A surviving row is still retrievable by its own vector.
        let survivor = points.iter().find(|(id, _)| !removed.contains(id)).unwrap();
        assert_eq!(reloaded.search(&survivor.1, 3, 64)[0].0, survivor.0);
    }

    #[test]
    fn deserialize_rejects_corrupt_input() {
        let points = gen_points(40, 16, 0xDEAD);
        let idx = Hnsw::build(&points).expect("index");
        let map = vec_lookup(&points);
        let good = idx.serialize().expect("serialized");

        // Truncated at every prefix length → None, never a panic.
        for cut in 0..good.len() {
            assert!(
                Hnsw::deserialize(&good[..cut], |id| map.get(&id).cloned()).is_none(),
                "truncated blob of len {cut} should be rejected",
            );
        }
        // Wrong version tag.
        let mut bad_ver = good.clone();
        bad_ver[0] ^= 0xFF;
        assert!(Hnsw::deserialize(&bad_ver, |id| map.get(&id).cloned()).is_none());
        // Empty buffer.
        assert!(Hnsw::deserialize(&[], |id| map.get(&id).cloned()).is_none());
        // A missing vector (lookup can't rehydrate a referenced rowid) → None.
        assert!(Hnsw::deserialize(&good, |_| None::<Vec<f32>>).is_none());
    }

    #[test]
    fn topology_export_json_and_dot() {
        let points = gen_points(30, 16, 0x7A11);
        let idx = Hnsw::build(&points).expect("index");

        let json = idx.to_json();
        assert!(json.starts_with('{') && json.ends_with('}'));
        assert!(json.contains("\"nodes\":[") && json.contains("\"edges\":["));
        assert_eq!(json.matches("\"node\":").count(), 30, "one entry per node");

        let dot = idx.to_dot();
        assert!(dot.starts_with("graph hnsw {"));
        assert!(dot.trim_end().ends_with('}'));
        assert_eq!(dot.matches("[label=").count(), 30, "one label per node");

        // Round-trips through the serialized blob → topology-only → same shape.
        let blob = idx.serialize().expect("blob");
        let topo = Hnsw::deserialize_topology(&blob).expect("topo");
        assert_eq!(topo.to_json().matches("\"node\":").count(), 30);
    }

    #[test]
    fn topology_export_omits_tombstones() {
        let points = gen_points(20, 16, 0x9E9E);
        let mut idx = Hnsw::build(&points).expect("index");
        idx.remove(points[3].0);
        idx.remove(points[7].0);

        let json = idx.to_json();
        assert_eq!(json.matches("\"node\":").count(), 18, "two nodes tombstoned out");
        assert!(!json.contains(&format!("\"rowid\":{},", points[3].0)));
        assert!(!json.contains(&format!("\"rowid\":{},", points[7].0)));
    }

    #[test]
    fn add_replaces_duplicate_id() {
        // Re-`add`ing an existing rowid tombstones the old node so the rowid
        // resolves to exactly one (the newest) node.
        let dim = 16;
        let mut idx = Hnsw::build(&gen_points(20, dim, 0x2468)).expect("index");
        let new_v = norm({
            let mut v = vec![0.0f32; dim];
            v[dim - 1] = 1.0;
            v
        });
        idx.add(5, new_v.clone());
        idx.add(5, new_v.clone()); // add again with same id
        let got = idx.search(&new_v, 10, 32);
        let count = got.iter().filter(|(id, _)| *id == 5).count();
        assert_eq!(count, 1, "duplicate rowid returned more than once");
        assert_eq!(got[0].0, 5);
    }
}
