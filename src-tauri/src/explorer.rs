use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::PositionStats;

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
}
