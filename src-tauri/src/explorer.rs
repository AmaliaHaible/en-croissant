use std::path::Path;
use std::sync::Mutex as StdMutex;
use std::time::Instant;

use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::sql_query;
use diesel::sql_types::{BigInt, Text};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::PositionStats;
use crate::error::Error;

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
                "CREATE TABLE IF NOT EXISTS position_cache (
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
}
