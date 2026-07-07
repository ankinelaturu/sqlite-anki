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

/// Max neighbors per node above layer 0 (DESIGN: `M = 16`).
const M: usize = 16;
/// Max neighbors per node on layer 0.
const M0: usize = 2 * M;
/// Candidate list size during construction.
const EF_CONSTRUCTION: usize = 100;

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
