use std::path::Path;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sql_query;
use diesel::sql_types::{BigInt, Text};
use log::warn;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;

use crate::db::PositionStats;
use crate::error::Error;
use crate::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ExplorerSource {
    Lichess,
    Masters,
}

impl ExplorerSource {
    fn as_str(self) -> &'static str {
        match self {
            ExplorerSource::Lichess => "lichess",
            ExplorerSource::Masters => "masters",
        }
    }
}

/// Lichess/Masters both use different move counts for the same position when it
/// is reached via a different move order. Key the cache on the first four FEN
/// fields (placement, side, castling, en passant) so transpositions share an
/// entry.
pub fn normalize_fen(fen: &str) -> String {
    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Deserialize)]
struct ExplorerMove {
    san: String,
    white: i64,
    draws: i64,
    black: i64,
}

#[derive(Debug, Deserialize)]
struct ExplorerResponse {
    white: i64,
    draws: i64,
    black: i64,
    #[serde(default)]
    moves: Vec<ExplorerMove>,
}

fn clamp_i32(n: i64) -> i32 {
    n.clamp(0, i32::MAX as i64) as i32
}

/// Map an explorer payload to the same shape a local database search returns:
/// one `PositionStats` per continuation move, plus a `*` summary row for games
/// that terminate at this exact position (top-level totals minus the per-move
/// sums), so `computeTreeCoverage`'s `gamesEndingHere + gamesContinuing`
/// reconstructs the real position total.
fn map_response(data: &ExplorerResponse) -> Vec<PositionStats> {
    let mut out: Vec<PositionStats> = data
        .moves
        .iter()
        .map(|m| PositionStats {
            move_: m.san.clone(),
            white: clamp_i32(m.white),
            draw: clamp_i32(m.draws),
            black: clamp_i32(m.black),
        })
        .collect();

    let sum_w: i64 = data.moves.iter().map(|m| m.white).sum();
    let sum_d: i64 = data.moves.iter().map(|m| m.draws).sum();
    let sum_b: i64 = data.moves.iter().map(|m| m.black).sum();

    out.push(PositionStats {
        move_: "*".to_string(),
        white: clamp_i32(data.white - sum_w),
        draw: clamp_i32(data.draws - sum_d),
        black: clamp_i32(data.black - sum_b),
    });

    out
}

type SqlitePool = Pool<ConnectionManager<SqliteConnection>>;

#[derive(Debug, Serialize, Type)]
pub struct ExplorerCacheStats {
    pub entries: i64,
    pub bytes: i64,
}

#[derive(Default)]
pub struct ExplorerCache {
    pool: StdMutex<Option<SqlitePool>>,
    pub fetch_lock: tokio::sync::Mutex<()>,
    pub last_request: tokio::sync::Mutex<Option<Instant>>,
}

#[derive(QueryableByName)]
struct ResponseRow {
    #[diesel(sql_type = Text)]
    response: String,
}

#[derive(QueryableByName)]
struct CountRow {
    #[diesel(sql_type = BigInt)]
    count: i64,
}

impl ExplorerCache {
    /// Build the connection pool and ensure the schema. Idempotent — a second
    /// call with the pool already present is a no-op.
    pub fn init(&self, cache_path: &Path) -> Result<(), Error> {
        let mut guard = self.pool.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
        let pool = Pool::builder()
            .max_size(4)
            .build(ConnectionManager::<SqliteConnection>::new(
                cache_path.to_str().expect("cache path is valid UTF-8"),
            ))?;
        {
            let mut conn = pool.get()?;
            conn.batch_execute(
                "PRAGMA busy_timeout = 5000;
                 CREATE TABLE IF NOT EXISTS position_cache (
                     source     TEXT NOT NULL,
                     fen        TEXT NOT NULL,
                     response   TEXT NOT NULL,
                     fetched_at INTEGER NOT NULL,
                     PRIMARY KEY (source, fen)
                 );",
            )?;
        }
        *guard = Some(pool);
        Ok(())
    }

    fn pool(&self) -> Result<SqlitePool, Error> {
        self.pool
            .lock()
            .unwrap()
            .clone()
            .ok_or(Error::ExplorerCacheUninitialized)
    }

    pub fn clear(&self) -> Result<(), Error> {
        let pool = self.pool()?;
        let mut conn = pool.get()?;
        conn.batch_execute("DELETE FROM position_cache; VACUUM;")?;
        Ok(())
    }

    pub fn stats(&self, cache_path: &Path) -> Result<ExplorerCacheStats, Error> {
        let pool = self.pool()?;
        let mut conn = pool.get()?;
        let rows: Vec<CountRow> =
            sql_query("SELECT COUNT(*) AS count FROM position_cache").load(&mut conn)?;
        let entries = rows.first().map(|r| r.count).unwrap_or(0);
        let bytes = std::fs::metadata(cache_path).map(|m| m.len() as i64).unwrap_or(0);
        Ok(ExplorerCacheStats { entries, bytes })
    }
}

fn cache_get(
    conn: &mut SqliteConnection,
    source: ExplorerSource,
    fen: &str,
) -> Result<Option<Vec<PositionStats>>, Error> {
    let rows: Vec<ResponseRow> = sql_query(
        "SELECT response FROM position_cache WHERE source = ? AND fen = ? LIMIT 1",
    )
    .bind::<Text, _>(source.as_str())
    .bind::<Text, _>(fen)
    .load(conn)?;

    match rows.into_iter().next() {
        Some(row) => Ok(Some(serde_json::from_str(&row.response)?)),
        None => Ok(None),
    }
}

fn cache_put(
    conn: &mut SqliteConnection,
    source: ExplorerSource,
    fen: &str,
    stats: &[PositionStats],
) -> Result<(), Error> {
    let json = serde_json::to_string(stats)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    sql_query(
        "INSERT OR REPLACE INTO position_cache (source, fen, response, fetched_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind::<Text, _>(source.as_str())
    .bind::<Text, _>(fen)
    .bind::<Text, _>(json)
    .bind::<BigInt, _>(now)
    .execute(conn)?;
    Ok(())
}

const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(1100);
const MAX_RETRIES: u32 = 3;

fn explorer_url(source: ExplorerSource) -> &'static str {
    match source {
        ExplorerSource::Lichess => "https://explorer.lichess.org/lichess",
        ExplorerSource::Masters => "https://explorer.lichess.org/masters",
    }
}

async fn throttle(cache: &ExplorerCache) {
    let mut last = cache.last_request.lock().await;
    if let Some(prev) = *last {
        let elapsed = prev.elapsed();
        if elapsed < MIN_REQUEST_INTERVAL {
            tokio::time::sleep(MIN_REQUEST_INTERVAL - elapsed).await;
        }
    }
    *last = Some(Instant::now());
}

/// One explorer request with 429 backoff. `fen` is already normalized.
async fn fetch_one(
    client: &reqwest::Client,
    source: ExplorerSource,
    fen: &str,
) -> Result<Vec<PositionStats>, Error> {
    let mut attempt = 0;
    loop {
        let mut req = client.get(explorer_url(source)).query(&[("fen", fen)]);
        if matches!(source, ExplorerSource::Lichess) {
            req = req.query(&[("variant", "standard")]);
        }
        let resp = req.send().await?;

        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt < MAX_RETRIES {
            let backoff = Duration::from_secs(1u64 << attempt);
            warn!("explorer 429, backing off {backoff:?}");
            tokio::time::sleep(backoff).await;
            attempt += 1;
            continue;
        }

        let resp = resp.error_for_status()?;
        let data: ExplorerResponse = resp.json().await?;
        return Ok(map_response(&data));
    }
}

/// Resolve every FEN (already normalized) against the cache, fetching misses
/// one at a time under the fetch lock with throttling. A fetch failure yields
/// an empty `Vec` for that position — `computeTreeCoverage` treats it the same
/// as a local database miss.
async fn resolve_cached(
    cache: &ExplorerCache,
    client: &reqwest::Client,
    source: ExplorerSource,
    fens: &[String],
) -> Vec<Vec<PositionStats>> {
    let mut results: Vec<Option<Vec<PositionStats>>> = vec![None; fens.len()];

    // Pass 1: cache reads.
    if let Ok(pool) = cache.pool() {
        if let Ok(mut conn) = pool.get() {
            for (i, fen) in fens.iter().enumerate() {
                results[i] = cache_get(&mut conn, source, fen).ok().flatten();
            }
        }
    }

    let any_missing = results.iter().any(|r| r.is_none());
    if any_missing {
        let _guard = cache.fetch_lock.lock().await;
        // Unique still-missing FENs, first-occurrence order.
        let mut seen = std::collections::HashSet::new();
        let missing: Vec<String> = fens
            .iter()
            .enumerate()
            .filter(|(i, _)| results[*i].is_none())
            .map(|(_, f)| f.clone())
            .filter(|f| seen.insert(f.clone()))
            .collect();

        for fen in missing {
            // Re-check: a concurrent call may have filled it.
            let hit = cache
                .pool()
                .ok()
                .and_then(|p| p.get().ok())
                .and_then(|mut c| cache_get(&mut c, source, &fen).ok().flatten());
            let stats = match hit {
                Some(s) => s,
                None => {
                    throttle(cache).await;
                    match fetch_one(client, source, &fen).await {
                        Ok(s) => {
                            if let Ok(pool) = cache.pool() {
                                if let Ok(mut conn) = pool.get() {
                                    let _ = cache_put(&mut conn, source, &fen, &s);
                                }
                            }
                            s
                        }
                        Err(e) => {
                            warn!("explorer fetch failed for {fen}: {e}");
                            Vec::new()
                        }
                    }
                }
            };
            for (i, f) in fens.iter().enumerate() {
                if *f == fen {
                    results[i] = Some(stats.clone());
                }
            }
        }
    }

    results.into_iter().map(Option::unwrap_or_default).collect()
}

fn cache_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, Error> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("explorer_cache.db3"))
}

#[tauri::command]
#[specta::specta]
pub async fn get_explorer_moves(
    source: ExplorerSource,
    fens: Vec<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Vec<PositionStats>>, Error> {
    if fens.is_empty() {
        return Ok(vec![]);
    }
    state.explorer_cache.init(&cache_path(&app)?)?;
    let normalized: Vec<String> = fens.iter().map(|f| normalize_fen(f)).collect();
    Ok(resolve_cached(&state.explorer_cache, &state.http_client, source, &normalized).await)
}

#[tauri::command]
#[specta::specta]
pub async fn clear_explorer_cache(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state.explorer_cache.init(&cache_path(&app)?)?;
    state.explorer_cache.clear()
}

#[tauri::command]
#[specta::specta]
pub async fn explorer_cache_stats(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<ExplorerCacheStats, Error> {
    let path = cache_path(&app)?;
    state.explorer_cache.init(&path)?;
    state.explorer_cache.stats(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_fen_drops_clocks() {
        let full = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
        let short = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3";
        assert_eq!(normalize_fen(full), short);
        assert_eq!(normalize_fen(short), short);
    }

    #[test]
    fn map_response_builds_moves_plus_star_row() {
        let data = ExplorerResponse {
            white: 100,
            draws: 40,
            black: 60, // 200 games total through the position
            moves: vec![
                ExplorerMove { san: "e4".into(), white: 50, draws: 20, black: 25 },
                ExplorerMove { san: "d4".into(), white: 40, draws: 15, black: 30 },
            ],
        };
        let stats = map_response(&data);

        assert_eq!(stats.len(), 3);
        assert_eq!(stats[0].move_, "e4");
        assert_eq!((stats[0].white, stats[0].draw, stats[0].black), (50, 20, 25));

        let star = stats.iter().find(|s| s.move_ == "*").unwrap();
        // 100-90=10 white, 40-35=5 draw, 60-55=5 black terminated here
        assert_eq!((star.white, star.draw, star.black), (10, 5, 5));
    }

    #[test]
    fn map_response_clamps_negative_star_row_to_zero() {
        let data = ExplorerResponse {
            white: 10,
            draws: 10,
            black: 10,
            moves: vec![ExplorerMove { san: "e4".into(), white: 99, draws: 0, black: 0 }],
        };
        let star = map_response(&data).into_iter().find(|s| s.move_ == "*").unwrap();
        assert_eq!((star.white, star.draw, star.black), (0, 10, 10));
    }

    #[test]
    fn cache_round_trips_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("explorer_cache.db3");

        let cache = ExplorerCache::default();
        cache.init(&path).unwrap();

        let pool = cache.pool().unwrap();
        let mut conn = pool.get().unwrap();

        let fen = normalize_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        assert!(cache_get(&mut conn, ExplorerSource::Lichess, &fen).unwrap().is_none());

        let stats = vec![
            PositionStats { move_: "e4".into(), white: 5, draw: 1, black: 2 },
            PositionStats { move_: "*".into(), white: 0, draw: 0, black: 0 },
        ];
        cache_put(&mut conn, ExplorerSource::Lichess, &fen, &stats).unwrap();

        let got = cache_get(&mut conn, ExplorerSource::Lichess, &fen).unwrap().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].move_, "e4");
        assert_eq!(got[0].white, 5);

        // different source is a different key
        assert!(cache_get(&mut conn, ExplorerSource::Masters, &fen).unwrap().is_none());
    }

    #[test]
    fn clear_empties_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("explorer_cache.db3");
        let cache = ExplorerCache::default();
        cache.init(&path).unwrap();
        {
            let pool = cache.pool().unwrap();
            let mut conn = pool.get().unwrap();
            cache_put(&mut conn, ExplorerSource::Lichess, "fen a b c", &[]).unwrap();
        }
        assert_eq!(cache.stats(&path).unwrap().entries, 1);
        cache.clear().unwrap();
        assert_eq!(cache.stats(&path).unwrap().entries, 0);
    }

    #[tokio::test]
    async fn resolve_returns_cache_hits_without_fetching() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("explorer_cache.db3");
        let cache = ExplorerCache::default();
        cache.init(&path).unwrap();

        let fen_a = normalize_fen("k7/8/8/8/8/8/8/K7 w - - 0 1");
        let fen_b = normalize_fen("k7/8/8/8/8/8/8/K7 b - - 0 1");
        {
            let pool = cache.pool().unwrap();
            let mut conn = pool.get().unwrap();
            cache_put(
                &mut conn,
                ExplorerSource::Masters,
                &fen_a,
                &[PositionStats { move_: "Kb1".into(), white: 3, draw: 0, black: 0 }],
            )
            .unwrap();
        }

        // A client with a 1ms timeout: if resolve_cached tries to fetch fen_b it
        // errors fast; we assert it does NOT panic and returns an empty vec for the
        // miss (same as a local DB miss).
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1))
            .build()
            .unwrap();

        let out = resolve_cached(
            &cache,
            &client,
            ExplorerSource::Masters,
            &[fen_a.clone(), fen_b.clone()],
        )
        .await;

        assert_eq!(out[0].len(), 1);
        assert_eq!(out[0][0].move_, "Kb1");
        // miss → empty vec, same as a local DB miss
        assert!(out[1].is_empty());
    }
}
