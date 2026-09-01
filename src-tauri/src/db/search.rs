use dashmap::DashMap;
use diesel::prelude::*;
use log::info;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, san::SanPlus, Bitboard, ByColor, CastlingMode, Chess, FromSetup, Position, Setup,
};
use specta::Type;
use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashMap},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};
use tauri::Emitter;

use crate::{
    db::{
        encoding::{decode_move, iter_mainline_move_bytes},
        get_db_or_create, get_material_count, get_pawn_home,
        models::*,
        normalize_games,
        schema::*,
        search_index::{get_index_path, GameResult, MmapSearchIndex, SearchGameEntryRef},
        ConnectionOptions, MaterialCount,
    },
    error::Error,
    AppState,
};

use super::GameQuery;

const MAX_LINE_CACHE_ENTRIES: usize = 256;
const MAX_SEARCH_SAMPLES: usize = 500;

/// Exact-position opening stats are small (a few dozen moves each), and a
/// repertoire under construction touches thousands of distinct positions across
/// successive coverage recomputes. Keep enough of them resident that an edit
/// only has to scan the reference database for the handful of *new* positions
/// instead of re-scanning the whole sub-repertoire every time.
const MAX_BATCH_POSITION_CACHE_ENTRIES: usize = 20_000;

pub type LineCacheKey = (GameQuery, PathBuf, std::time::SystemTime);
pub type BatchCacheKey = (PathBuf, std::time::SystemTime, String);

/// Bounded cache with approximate-LRU eviction.
///
/// The position-search caches previously dropped *every* entry the moment they
/// filled, so a repertoire coverage pass or a game report — each of which
/// touches hundreds of distinct positions — kept re-paying the full search cost
/// on every re-run. Now the single least-recently-used entry is evicted to make
/// room instead.
pub struct LruCache<K: Eq + std::hash::Hash + Clone, V: Clone> {
    map: DashMap<K, (V, AtomicU64)>,
    clock: AtomicU64,
    capacity: usize,
}

impl<K: Eq + std::hash::Hash + Clone, V: Clone> Default for LruCache<K, V> {
    fn default() -> Self {
        Self {
            map: DashMap::new(),
            clock: AtomicU64::new(0),
            capacity: MAX_LINE_CACHE_ENTRIES,
        }
    }
}

impl<K: Eq + std::hash::Hash + Clone, V: Clone> LruCache<K, V> {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            map: DashMap::new(),
            clock: AtomicU64::new(0),
            capacity,
        }
    }

    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed)
    }

    pub fn get(&self, key: &K) -> Option<V> {
        let entry = self.map.get(key)?;
        entry.1.store(self.tick(), Ordering::Relaxed);
        Some(entry.0.clone())
    }

    pub fn insert(&self, key: K, value: V) {
        while self.map.len() >= self.capacity && !self.map.contains_key(&key) {
            let victim = self
                .map
                .iter()
                .min_by_key(|e| e.value().1.load(Ordering::Relaxed))
                .map(|e| e.key().clone());
            match victim {
                Some(victim) => {
                    self.map.remove(&victim);
                }
                None => break,
            }
        }
        self.map.insert(key, (value, AtomicU64::new(self.tick())));
    }

    pub fn clear(&self) {
        self.map.clear();
    }
}

/// Result cache for [`search_position`], keyed by the full query.
pub type LineCache = LruCache<LineCacheKey, (Vec<PositionStats>, Vec<NormalizedGame>)>;

/// Opening-move stats for a single exact position, populated by
/// [`search_positions_batch`] so that re-running repertoire coverage (after an
/// orientation flip, a min-games change, an added move, ...) is served from
/// memory. Sized for a whole repertoire rather than the small line cache — see
/// [`MAX_BATCH_POSITION_CACHE_ENTRIES`].
pub struct BatchPositionCache(LruCache<BatchCacheKey, Vec<PositionStats>>);

impl Default for BatchPositionCache {
    fn default() -> Self {
        Self(LruCache::with_capacity(MAX_BATCH_POSITION_CACHE_ENTRIES))
    }
}

impl std::ops::Deref for BatchPositionCache {
    type Target = LruCache<BatchCacheKey, Vec<PositionStats>>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// Load (or build, then load) the mmap search index for `file`, reusing the
/// process-wide cached index when it is still current. Shared by every
/// position-search entry point.
fn load_index(
    state: &tauri::State<'_, AppState>,
    file: &Path,
    start: Instant,
) -> Result<MmapSearchIndex, Error> {
    let mut cache = state.db_cache.lock().unwrap();
    let cache_is_current = cache
        .as_ref()
        .is_some_and(|(cached_file, _)| cached_file.as_path() == file)
        && MmapSearchIndex::is_up_to_date(file);
    if !cache_is_current {
        let index_path = get_index_path(file);

        if !MmapSearchIndex::is_up_to_date(file) {
            info!("Search index not found, generating automatically...");
            *cache = None;
            drop(cache);
            if let Err(e) = super::generate_search_index(file, state) {
                return Err(Error::from(std::io::Error::other(format!(
                    "Failed to generate search index: {}",
                    e
                ))));
            }
            cache = state.db_cache.lock().unwrap();
        }

        info!("Loading games from mmap binary search index");
        match MmapSearchIndex::open(&index_path) {
            Ok(index) => {
                info!(
                    "Opened mmap index with {} games: {:?}",
                    index.len(),
                    start.elapsed()
                );
                *cache = Some((file.to_path_buf(), index));
            }
            Err(e) => {
                return Err(Error::from(e));
            }
        }
    }
    Ok(cache.as_ref().unwrap().1.clone())
}

#[derive(Default)]
struct SearchAccumulator {
    openings: HashMap<String, PositionStats>,
    top_games: BinaryHeap<Reverse<(i16, i32)>>,
}

impl SearchAccumulator {
    fn record_game(&mut self, elo: i16, id: i32) {
        if self.top_games.len() < MAX_SEARCH_SAMPLES {
            self.top_games.push(Reverse((elo, id)));
        } else if let Some(&Reverse((min_elo, _))) = self.top_games.peek() {
            if elo > min_elo {
                self.top_games.pop();
                self.top_games.push(Reverse((elo, id)));
            }
        }
    }

    fn merge(mut self, other: Self) -> Self {
        for Reverse((elo, id)) in other.top_games {
            self.record_game(elo, id);
        }
        for (move_, stats) in other.openings {
            self.openings
                .entry(move_)
                .and_modify(|current| {
                    current.white += stats.white;
                    current.draw += stats.draw;
                    current.black += stats.black;
                })
                .or_insert(stats);
        }
        self
    }
}

#[derive(Debug, Hash, PartialEq, Eq, Clone)]
pub struct ExactData {
    pawn_home: u16,
    material: MaterialCount,
    position: Chess,
}

#[derive(Debug, Hash, PartialEq, Eq, Clone)]
pub struct PartialData {
    // piece_counts: Vec<(Piece, u8)>,
    piece_positions: Setup,
    material: MaterialCount,
}

#[derive(Debug, Hash, PartialEq, Eq, Clone)]
pub enum PositionQuery {
    Exact(ExactData),
    Partial(PartialData),
}

impl PositionQuery {
    pub fn exact_from_fen(fen: &str) -> Result<PositionQuery, Error> {
        let fen = Fen::from_ascii(fen.as_bytes())?;
        let setup = fen.into_setup();
        let castling_mode = CastlingMode::detect(&setup);
        let position: Chess = setup.position(castling_mode)?;
        let pawn_home = get_pawn_home(position.board());
        let material = get_material_count(position.board());
        Ok(PositionQuery::Exact(ExactData {
            pawn_home,
            material,
            position,
        }))
    }

    pub fn partial_from_fen(fen: &str) -> Result<PositionQuery, Error> {
        let fen = Fen::from_ascii(fen.as_bytes())?;
        let setup = fen.into_setup();
        let material = get_material_count(&setup.board);
        Ok(PositionQuery::Partial(PartialData {
            piece_positions: setup,
            material,
        }))
    }
}

#[derive(Debug, Clone, Deserialize, Type, PartialEq, Eq, Hash)]
pub struct PositionQueryJs {
    pub fen: String,
    pub type_: String,
}

fn convert_position_query(query: PositionQueryJs) -> Result<PositionQuery, Error> {
    match query.type_.as_str() {
        "exact" => PositionQuery::exact_from_fen(&query.fen),
        "partial" => PositionQuery::partial_from_fen(&query.fen),
        _ => unreachable!(),
    }
}

impl PositionQuery {
    fn matches(&self, position: &Chess) -> bool {
        match self {
            PositionQuery::Exact(ref data) => {
                data.position.turn() == position.turn() && data.position.board() == position.board()
            }
            PositionQuery::Partial(ref data) => {
                let query_board = &data.piece_positions.board;
                let tested_board = position.board();

                is_contained(tested_board.white(), query_board.white())
                    && is_contained(tested_board.black(), query_board.black())
                    && is_contained(tested_board.pawns(), query_board.pawns())
                    && is_contained(tested_board.knights(), query_board.knights())
                    && is_contained(tested_board.bishops(), query_board.bishops())
                    && is_contained(tested_board.rooks(), query_board.rooks())
                    && is_contained(tested_board.queens(), query_board.queens())
                    && is_contained(tested_board.kings(), query_board.kings())
            }
        }
    }

    fn is_reachable_by(&self, material: &MaterialCount, pawn_home: u16) -> bool {
        match self {
            PositionQuery::Exact(ref data) => {
                is_end_reachable(data.pawn_home, pawn_home)
                    && is_material_reachable(&data.material, material)
            }
            PositionQuery::Partial(ref data) => is_material_reachable(&data.material, material),
        }
    }

    fn can_reach(&self, material: &MaterialCount, pawn_home: u16) -> bool {
        match self {
            PositionQuery::Exact(ref data) => {
                is_end_reachable(pawn_home, data.pawn_home)
                    && is_material_reachable(material, &data.material)
            }
            PositionQuery::Partial(_) => true,
        }
    }
}

/// Returns true if the end pawn structure is reachable
fn is_end_reachable(end: u16, pos: u16) -> bool {
    end & !pos == 0
}

/// Returns true if the end material is reachable
fn is_material_reachable(end: &MaterialCount, pos: &MaterialCount) -> bool {
    end.white <= pos.white && end.black <= pos.black
}

/// Returns true if the subset is contained in the container
fn is_contained(container: Bitboard, subset: Bitboard) -> bool {
    container & subset == subset
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PositionStats {
    #[serde(rename = "move")]
    pub move_: String,
    pub white: i32,
    pub draw: i32,
    pub black: i32,
}

fn get_move_after_match(
    move_blob: &[u8],
    fen: &Option<&str>,
    query: &PositionQuery,
) -> Result<Option<String>, Error> {
    let mut chess = if let Some(fen) = fen {
        let fen = Fen::from_ascii(fen.as_bytes())?;
        let setup = fen.into_setup();
        let castling_mode = CastlingMode::detect(&setup);
        Chess::from_setup(setup, castling_mode)?
    } else {
        Chess::default()
    };

    if query.matches(&chess) {
        let mut mainline = iter_mainline_move_bytes(move_blob).peekable();
        if mainline.peek().is_none() {
            return Ok(Some("*".to_string()));
        }
        let Some(next_byte) = mainline.peek().copied() else {
            return Ok(Some("*".to_string()));
        };
        let Some(next_move) = decode_move(next_byte, &chess) else {
            return Ok(None);
        };
        let san = SanPlus::from_move(chess, &next_move);
        return Ok(Some(san.to_string()));
    }

    let mut mainline = iter_mainline_move_bytes(move_blob).peekable();

    while let Some(byte) = mainline.next() {
        let Some(m) = decode_move(byte, &chess) else {
            return Ok(None);
        };
        chess.play_unchecked(&m);

        let is_irreversible =
            m.is_capture() || m.role() == shakmaty::Role::Pawn || m.is_promotion();

        if is_irreversible {
            let board = chess.board();
            if !query.is_reachable_by(&get_material_count(board), get_pawn_home(board)) {
                return Ok(None);
            }
        }
        if query.matches(&chess) {
            if mainline.peek().is_none() {
                return Ok(Some("*".to_string()));
            }
            let Some(next_byte) = mainline.peek().copied() else {
                return Ok(Some("*".to_string()));
            };
            let Some(next_move) = decode_move(next_byte, &chess) else {
                return Ok(None);
            };
            let san = SanPlus::from_move(chess, &next_move);
            return Ok(Some(san.to_string()));
        }
    }
    Ok(None)
}

#[derive(Clone, serde::Serialize)]
pub struct ProgressPayload {
    pub progress: f64,
    pub id: String,
    pub finished: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn search_position(
    file: PathBuf,
    query: GameQuery,
    app: tauri::AppHandle,
    tab_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(Vec<PositionStats>, Vec<NormalizedGame>), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    let cache_key = (
        query.clone(),
        file.clone(),
        std::fs::metadata(&file)?.modified()?,
    );

    let collision_lock = {
        let entry = state
            .search_collisions
            .entry((query.clone(), file.clone()))
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())));
        entry.value().clone()
    };

    let _guard = collision_lock.lock().await;

    if let Some(result) = state.line_cache.get(&cache_key) {
        state
            .search_collisions
            .remove(&(query.clone(), file.clone()));
        return Ok(result);
    }

    let start = Instant::now();
    info!("start loading games");

    let permit = state.new_request.acquire().await.unwrap();

    let mmap_index = load_index(&state, &file, start)?;

    let game_count = mmap_index.len();

    info!(
        "Ready to search {} games: {:?}",
        game_count,
        start.elapsed()
    );

    let processed = AtomicUsize::new(0);

    let parsed_position_query: Option<PositionQuery> = if let Some(pq) = &query.position {
        Some(convert_position_query(pq.clone())?)
    } else {
        None
    };

    let wanted_result = query.wanted_result.as_ref().and_then(|r| match r.as_str() {
        "whitewon" => Some(GameResult::WhiteWin),
        "blackwon" => Some(GameResult::BlackWin),
        "draw" => Some(GameResult::Draw),
        _ => None,
    });

    info!("start search on {tab_id}");

    let process_entry = |acc: &mut SearchAccumulator, entry: SearchGameEntryRef<'_>| {
        let index = processed.fetch_add(1, Ordering::Relaxed) + 1;
        if index.is_multiple_of(50000) {
            let _ = app.emit(
                "search_progress",
                ProgressPayload {
                    progress: (index as f64 / game_count as f64) * 100.0,
                    id: tab_id.clone(),
                    finished: false,
                },
            );
        }

        if let Some(white) = query.player1 {
            if white != entry.white_id {
                return;
            }
        }

        if let Some(black) = query.player2 {
            if black != entry.black_id {
                return;
            }
        }

        if let Some(wanted) = wanted_result {
            if entry.result != wanted {
                return;
            }
        }

        if let Some(start_date) = &query.start_date {
            if let Some(date) = entry.date {
                if date < start_date.as_str() {
                    return;
                }
            }
        }

        if let Some(end_date) = &query.end_date {
            if let Some(date) = entry.date {
                if date > end_date.as_str() {
                    return;
                }
            }
        }

        if let Some(position_query) = &parsed_position_query {
            let end_material: MaterialCount = ByColor {
                white: entry.white_material,
                black: entry.black_material,
            };
            if position_query.can_reach(&end_material, entry.pawn_home) {
                if let Ok(Some(m)) = get_move_after_match(entry.moves, &entry.fen, position_query) {
                    let elo_key = entry.white_elo.max(entry.black_elo);
                    acc.record_game(elo_key, entry.id);

                    acc.openings
                        .entry(m)
                        .and_modify(|opening| match entry.result {
                            GameResult::WhiteWin => opening.white += 1,
                            GameResult::BlackWin => opening.black += 1,
                            GameResult::Draw => opening.draw += 1,
                            GameResult::Other | GameResult::None => opening.draw += 1,
                        })
                        .or_insert_with(|| PositionStats {
                            black: i32::from(entry.result == GameResult::BlackWin),
                            white: i32::from(entry.result == GameResult::WhiteWin),
                            draw: i32::from(
                                entry.result == GameResult::Draw
                                    || entry.result == GameResult::Other
                                    || entry.result == GameResult::None,
                            ),
                            move_: String::new(),
                        });
                }
            }
        }
    };

    let results = mmap_index
        .par_iter()
        .fold(SearchAccumulator::default, |mut acc, entry| {
            process_entry(&mut acc, entry);
            acc
        })
        .reduce(SearchAccumulator::default, SearchAccumulator::merge);

    let openings: Vec<PositionStats> = results
        .openings
        .into_iter()
        .map(|(k, mut v)| {
            v.move_ = k;
            v
        })
        .collect();
    let ids: Vec<i32> = results
        .top_games
        .into_iter()
        .map(|Reverse((_, id))| id)
        .collect();

    info!("finished search in {:?}", start.elapsed());

    let (white_players, black_players) = diesel::alias!(players as white, players as black);
    let games: Vec<(Game, Player, Player, Event, Site)> = games::table
        .inner_join(white_players.on(games::white_id.eq(white_players.field(players::id))))
        .inner_join(black_players.on(games::black_id.eq(black_players.field(players::id))))
        .inner_join(events::table.on(games::event_id.eq(events::id)))
        .inner_join(sites::table.on(games::site_id.eq(sites::id)))
        .filter(games::id.eq_any(ids))
        .order((games::white_elo.desc(), games::black_elo.desc()))
        .load(db)?;
    let normalized_games = normalize_games(games);
    let file_path = file.clone();

    state
        .line_cache
        .insert(cache_key, (openings.clone(), normalized_games.clone()));

    state.search_collisions.remove(&(query, file_path));

    drop(permit);

    Ok((openings, normalized_games))
}

fn tally_result(stats: &mut PositionStats, result: GameResult) {
    match result {
        GameResult::WhiteWin => stats.white += 1,
        GameResult::BlackWin => stats.black += 1,
        GameResult::Draw | GameResult::Other | GameResult::None => stats.draw += 1,
    }
}

/// Exact-match every FEN in `fens` against the reference database in a single
/// parallel pass over the search index, returning per-FEN opening-move stats
/// index-aligned with the input.
///
/// Repertoire coverage and game-report novelty detection both need the DB stats
/// for a whole set of positions at once. Doing that as one `search_position`
/// call per position means one full-index scan per position, run sequentially —
/// which pins every core for minutes on a large reference database. This walks
/// the index once and tests every position against each entry as it goes.
#[tauri::command]
#[specta::specta]
pub async fn search_positions_batch(
    file: PathBuf,
    fens: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Vec<PositionStats>>, Error> {
    if fens.is_empty() {
        return Ok(vec![]);
    }

    let modified = std::fs::metadata(&file)?.modified()?;

    // Positions resolved by an earlier batch are served from memory; only the
    // misses need a scan.
    let mut results: Vec<Vec<PositionStats>> = vec![Vec::new(); fens.len()];
    let mut pending: Vec<(usize, PositionQuery)> = Vec::new();
    for (i, fen) in fens.iter().enumerate() {
        if let Some(openings) =
            state
                .batch_position_cache
                .get(&(file.clone(), modified, fen.clone()))
        {
            results[i] = openings;
        } else if let Ok(parsed) = PositionQuery::exact_from_fen(fen) {
            pending.push((i, parsed));
        }
    }

    if pending.is_empty() {
        return Ok(results);
    }

    let permit = state.new_request.acquire().await.unwrap();
    let start = Instant::now();
    let mmap_index = load_index(&state, &file, start)?;
    let n = pending.len();

    let merged = mmap_index
        .par_iter()
        .fold(
            || vec![HashMap::<String, PositionStats>::new(); n],
            |mut accs, entry| {
                let end_material: MaterialCount = ByColor {
                    white: entry.white_material,
                    black: entry.black_material,
                };
                for (slot, (_, query)) in pending.iter().enumerate() {
                    if !query.can_reach(&end_material, entry.pawn_home) {
                        continue;
                    }
                    if let Ok(Some(m)) = get_move_after_match(entry.moves, &entry.fen, query) {
                        let stats = accs[slot].entry(m).or_insert_with(|| PositionStats {
                            white: 0,
                            draw: 0,
                            black: 0,
                            move_: String::new(),
                        });
                        tally_result(stats, entry.result);
                    }
                }
                accs
            },
        )
        .reduce(
            || vec![HashMap::<String, PositionStats>::new(); n],
            |mut a, b| {
                for (slot, map) in b.into_iter().enumerate() {
                    for (mv, s) in map {
                        a[slot]
                            .entry(mv)
                            .and_modify(|cur| {
                                cur.white += s.white;
                                cur.draw += s.draw;
                                cur.black += s.black;
                            })
                            .or_insert(s);
                    }
                }
                a
            },
        );

    info!(
        "batch position search ({n} positions) finished in {:?}",
        start.elapsed()
    );
    drop(permit);

    for (map, (orig_idx, _)) in merged.into_iter().zip(pending.iter()) {
        let openings: Vec<PositionStats> = map
            .into_iter()
            .map(|(mv, mut stats)| {
                stats.move_ = mv;
                stats
            })
            .collect();
        state.batch_position_cache.insert(
            (file.clone(), modified, fens[*orig_idx].clone()),
            openings.clone(),
        );
        results[*orig_idx] = openings;
    }

    Ok(results)
}

/// For each FEN, whether that exact position already appears in `file`, resolved
/// in a single parallel pass over the index. Used by game-report novelty
/// detection, which would otherwise scan the whole index once per move.
pub async fn positions_in_db(
    file: PathBuf,
    fens: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<bool>, Error> {
    if fens.is_empty() {
        return Ok(vec![]);
    }

    let queries: Vec<PositionQuery> = fens
        .iter()
        .map(|f| PositionQuery::exact_from_fen(f))
        .collect::<Result<_, _>>()?;
    let n = queries.len();

    let permit = state.new_request.acquire().await.unwrap();
    let start = Instant::now();
    let mmap_index = load_index(&state, &file, start)?;

    let found = mmap_index
        .par_iter()
        .fold(
            || vec![false; n],
            |mut acc, entry| {
                let end_material: MaterialCount = ByColor {
                    white: entry.white_material,
                    black: entry.black_material,
                };
                for (i, query) in queries.iter().enumerate() {
                    if acc[i] {
                        continue;
                    }
                    if query.can_reach(&end_material, entry.pawn_home)
                        && get_move_after_match(entry.moves, &entry.fen, query)
                            .unwrap_or(None)
                            .is_some()
                    {
                        acc[i] = true;
                    }
                }
                acc
            },
        )
        .reduce(
            || vec![false; n],
            |mut a, b| {
                for (i, hit) in b.into_iter().enumerate() {
                    a[i] |= hit;
                }
                a
            },
        );

    info!(
        "novelty batch ({n} positions) finished in {:?}",
        start.elapsed()
    );
    drop(permit);

    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_cache_with_capacity_retains_every_entry_below_capacity() {
        // A repertoire under construction touches far more than the default 256
        // distinct positions. Entries inserted early in a coverage pass must
        // still be cached on the next recompute, otherwise every edit re-scans
        // the whole reference database.
        let cache: LruCache<usize, ()> = LruCache::with_capacity(5000);
        for i in 0..5000 {
            cache.insert(i, ());
        }
        for i in 0..5000 {
            assert!(cache.get(&i).is_some(), "entry {i} evicted below capacity");
        }
    }

    #[test]
    fn lru_cache_evicts_only_down_to_capacity_on_overflow() {
        let cache: LruCache<usize, ()> = LruCache::with_capacity(100);
        for i in 0..150 {
            cache.insert(i, ());
        }
        let retained = (0..150).filter(|i| cache.get(i).is_some()).count();
        assert_eq!(retained, 100);
    }

    #[test]
    fn batch_position_cache_default_holds_a_large_repertoire() {
        let cache = BatchPositionCache::default();
        let modified = std::time::SystemTime::now();
        let key = |i: usize| (PathBuf::from("ref.db3"), modified, format!("fen-{i}"));
        for i in 0..5000 {
            cache.insert(key(i), vec![]);
        }
        assert!(cache.get(&key(0)).is_some());
        assert!(cache.get(&key(4999)).is_some());
    }

    fn assert_partial_match(fen1: &str, fen2: &str) {
        let query = PositionQuery::partial_from_fen(fen1).unwrap();
        let fen = Fen::from_ascii(fen2.as_bytes()).unwrap();
        let chess = Chess::from_setup(fen.into_setup(), shakmaty::CastlingMode::Chess960).unwrap();
        assert!(query.matches(&chess));
    }

    #[test]
    fn exact_matches() {
        let query = PositionQuery::exact_from_fen(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        )
        .unwrap();
        let chess = Chess::default();
        assert!(query.matches(&chess));
    }

    #[test]
    fn empty_matches_anything() {
        assert_partial_match(
            "8/8/8/8/8/8/8/8 w - - 0 1",
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        );
    }

    #[test]
    fn correct_partial_match() {
        assert_partial_match(
            "8/8/8/8/8/8/8/6N1 w - - 0 1",
            "3k4/8/8/8/8/4P3/3PKP2/6N1 w - - 0 1",
        );
    }

    #[test]
    #[should_panic]
    fn fail_partial_match() {
        assert_partial_match(
            "8/8/8/8/8/8/8/6N1 w - - 0 1",
            "3k4/8/8/8/8/4P3/3PKP2/7N w - - 0 1",
        );
        assert_partial_match(
            "8/8/8/8/8/8/8/6N1 w - - 0 1",
            "3k4/8/8/8/8/4P3/3PKP2/6n1 w - - 0 1",
        );
    }

    #[test]
    fn correct_exact_is_reachable() {
        let query =
            PositionQuery::exact_from_fen("rnbqkb1r/pppp1ppp/5n2/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR")
                .unwrap();
        let chess = Chess::default();
        assert!(query.is_reachable_by(
            &get_material_count(chess.board()),
            get_pawn_home(chess.board())
        ));
    }

    #[test]
    fn correct_partial_is_reachable() {
        let query = PositionQuery::partial_from_fen("8/8/8/8/8/8/8/8").unwrap();
        let chess = Chess::default();
        assert!(query.is_reachable_by(
            &get_material_count(chess.board()),
            get_pawn_home(chess.board())
        ));
    }

    #[test]
    fn correct_partial_can_reach() {
        let query = PositionQuery::partial_from_fen("8/8/8/8/8/8/8/8").unwrap();
        let chess = Chess::default();
        assert!(query.can_reach(
            &get_material_count(chess.board()),
            get_pawn_home(chess.board())
        ));
    }

    #[test]
    fn get_move_after_exact_match_test() {
        let game = vec![12, 12]; // 1. e4 e5

        let query =
            PositionQuery::exact_from_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR").unwrap();
        let result = get_move_after_match(&game, &None, &query).unwrap();
        assert_eq!(result, Some("e4".to_string()));

        let query =
            PositionQuery::exact_from_fen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR").unwrap();
        let result = get_move_after_match(&game, &None, &query).unwrap();
        assert_eq!(result, Some("e5".to_string()));

        let query =
            PositionQuery::exact_from_fen("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR")
                .unwrap();
        let result = get_move_after_match(&game, &None, &query).unwrap();
        assert_eq!(result, Some("*".to_string()));
    }

    #[test]
    fn get_move_after_partial_match_test() {
        let game = vec![12, 12]; // 1. e4 e5

        let query = PositionQuery::partial_from_fen("8/pppppppp/8/8/8/8/PPPPPPPP/8").unwrap();
        let result = get_move_after_match(&game, &None, &query).unwrap();
        assert_eq!(result, Some("e4".to_string()));
    }
}
