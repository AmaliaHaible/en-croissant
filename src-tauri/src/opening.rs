use log::info;
use serde::Serialize;
use shakmaty::{fen::Fen, Setup};
use std::collections::HashMap;

use lazy_static::lazy_static;
use specta::Type;
use strsim::{jaro_winkler, sorensen_dice};

use crate::error::Error;

#[derive(Debug, Clone)]
struct Opening {
    _eco: String,
    name: String,
    setup: Setup,
    pgn: Option<String>,
}

#[derive(Debug, Clone, Type, Serialize)]
pub struct OutOpening {
    name: String,
    fen: String,
}

const OPENINGS_BINARY_DATA: &[u8] = include_bytes!("../data/openings.bin.zst");

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
struct BinaryOpeningRecord {
    eco: String,
    name: String,
    fen: String,
    pgn: String,
}

/// Generates the Chess960 (FRC) back rank piece layout for a given index (0..959).
pub fn chess960_backrank(n: u16) -> [char; 8] {
    let mut rank = [' '; 8];

    // 1. Light-squared bishop (file 1, 3, 5, 7)
    let b1 = (n % 4) as usize;
    rank[2 * b1 + 1] = 'B';
    let n1 = n / 4;

    // 2. Dark-squared bishop (file 0, 2, 4, 6)
    let b2 = (n1 % 4) as usize;
    rank[2 * b2] = 'B';
    let n2 = n1 / 4;

    // 3. Queen placement on q-th remaining empty square (0..5)
    let q = (n2 % 6) as usize;
    let n3 = (n2 / 6) as usize;
    let mut empty_count = 0;
    for slot in rank.iter_mut() {
        if *slot == ' ' {
            if empty_count == q {
                *slot = 'Q';
                break;
            }
            empty_count += 1;
        }
    }

    // 4. Knight placements from the 10 combination pairs of 5 remaining squares
    const KNIGHT_PAIRS: [(usize, usize); 10] = [
        (0, 1),
        (0, 2),
        (0, 3),
        (0, 4),
        (1, 2),
        (1, 3),
        (1, 4),
        (2, 3),
        (2, 4),
        (3, 4),
    ];
    let (k1, k2) = KNIGHT_PAIRS[n3];
    let mut empty_indices = [0; 5];
    let mut idx = 0;
    for (i, &slot) in rank.iter().enumerate() {
        if slot == ' ' {
            empty_indices[idx] = i;
            idx += 1;
        }
    }
    rank[empty_indices[k1]] = 'N';
    rank[empty_indices[k2]] = 'N';

    // 5. Remaining 3 empty squares are strictly Rook, King, Rook
    let mut rkr = ['R', 'K', 'R'].into_iter();
    for slot in rank.iter_mut() {
        if *slot == ' ' {
            *slot = rkr.next().unwrap();
        }
    }

    rank
}

/// Formats the complete initial FEN string for a Chess960 position index (0..959).
pub fn chess960_fen(n: u16) -> String {
    let backrank = chess960_backrank(n);
    let white_pieces: String = backrank.iter().collect();
    let black_pieces: String = backrank.iter().map(|c| c.to_ascii_lowercase()).collect();
    format!("{black_pieces}/pppppppp/8/8/8/8/PPPPPPPP/{white_pieces} w KQkq - 0 1")
}

#[tauri::command]
#[specta::specta]
pub fn get_opening_from_fen(fen: &str) -> Result<String, Error> {
    let fen: Fen = fen.parse()?;
    get_opening_from_setup(fen.into_setup())
}

#[tauri::command]
#[specta::specta]
pub fn get_opening_from_name(name: &str) -> Result<String, Error> {
    OPENINGS
        .iter()
        .find(|o| o.name == name)
        .map(|o| o.pgn.clone().expect("opening without pgn"))
        .ok_or_else(|| Error::NoOpeningFound)
}

#[tauri::command]
#[specta::specta]
pub fn get_opening_from_fens(fens: Vec<String>) -> Result<String, Error> {
    for fen in fens.into_iter().rev() {
        if let Ok(opening) = get_opening_from_fen(&fen) {
            return Ok(opening);
        }
    }
    Err(Error::NoOpeningFound)
}

pub fn get_opening_from_setup(setup: Setup) -> Result<String, Error> {
    OPENINGS_BY_SETUP
        .get(&setup)
        .and_then(|index| OPENINGS.get(*index))
        .map(|opening| opening.name.clone())
        .ok_or_else(|| Error::NoOpeningFound)
}

#[tauri::command]
#[specta::specta]
pub async fn search_opening_name(query: String) -> Result<Vec<OutOpening>, Error> {
    let lower_query = query.to_lowercase();
    let scores = OPENINGS
        .iter()
        .map(|opening| {
            let lower_name = opening.name.to_lowercase();
            let sorenson_score = sorensen_dice(&lower_query, &lower_name);
            let jaro_score = jaro_winkler(&lower_query, &lower_name);
            let score = sorenson_score.max(jaro_score);
            (opening.clone(), score)
        })
        .collect::<Vec<_>>();
    let mut best_matches = scores
        .into_iter()
        .filter(|(_, score)| *score > 0.8)
        .collect::<Vec<_>>();

    best_matches.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

    let best_matches_names = best_matches
        .iter()
        .map(|(o, _)| o.clone())
        .take(15)
        .map(|o| OutOpening {
            name: o.name,
            fen: Fen::from_setup(o.setup.clone()).to_string(),
        })
        .collect();
    Ok(best_matches_names)
}

lazy_static! {
    static ref OPENINGS: Vec<Opening> = {
        info!("Initializing openings table from compressed binary database...");

        let uncompressed = zstd::decode_all(OPENINGS_BINARY_DATA)
            .expect("Failed to decompress embedded openings database");
        let compiled: Vec<BinaryOpeningRecord> = serde_json::from_slice(&uncompressed)
            .expect("Failed to parse embedded openings database");

        let mut positions = Vec::with_capacity(compiled.len() + 962);
        positions.push(Opening {
            _eco: "Extra".to_string(),
            name: "Starting Position".to_string(),
            setup: Setup::default(),
            pgn: None,
        });
        positions.push(Opening {
            _eco: "Extra".to_string(),
            name: "Empty Board".to_string(),
            setup: Setup::empty(),
            pgn: None,
        });

        for record in compiled {
            let fen: Fen = record.fen.parse().expect("Failed to parse opening fen");
            positions.push(Opening {
                _eco: record.eco,
                name: record.name,
                setup: fen.into_setup(),
                pgn: Some(record.pgn),
            });
        }
        for i in 0..960 {
            let fen_str = chess960_fen(i);
            let fen: Fen = fen_str
                .parse()
                .expect("Failed to parse generated chess960 fen");
            positions.push(Opening {
                _eco: "FRC".to_string(),
                name: format!("Fischer Random {i}"),
                setup: fen.into_setup(),
                pgn: None,
            });
        }
        positions
    };
    static ref OPENINGS_BY_SETUP: HashMap<Setup, usize> = {
        let mut openings = HashMap::with_capacity(OPENINGS.len());
        for (index, opening) in OPENINGS.iter().enumerate() {
            openings.entry(opening.setup.clone()).or_insert(index);
        }
        openings
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_opening() {
        let opening =
            get_opening_from_fen("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPPKPPP/RNBQ1BNR b kq - 1 2")
                .unwrap();
        assert_eq!(opening, "Bongcloud Attack");
    }

    #[test]
    fn test_chess960_generation() {
        assert_eq!(
            chess960_fen(0),
            "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1"
        );
        assert_eq!(
            chess960_fen(518),
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        );
        // Verify all 960 positions generate valid FENs and King is between Rooks
        for i in 0..960 {
            let backrank = chess960_backrank(i);
            let mut r1 = None;
            let mut k = None;
            let mut r2 = None;
            for (idx, &p) in backrank.iter().enumerate() {
                if p == 'R' {
                    if r1.is_none() {
                        r1 = Some(idx);
                    } else {
                        r2 = Some(idx);
                    }
                } else if p == 'K' {
                    k = Some(idx);
                }
            }
            assert!(r1.is_some() && k.is_some() && r2.is_some());
            assert!(r1.unwrap() < k.unwrap() && k.unwrap() < r2.unwrap());
        }
    }

    #[test]
    #[ignore = "manual performance benchmark"]
    fn benchmark_opening_lookup() {
        use std::{hint::black_box, time::Instant};

        let setup = OPENINGS.last().unwrap().setup.clone();
        let iterations = 100_000;
        let start = Instant::now();
        for _ in 0..iterations {
            black_box(get_opening_from_setup(black_box(setup.clone())).unwrap());
        }
        println!(
            "opening_lookup iterations={iterations} elapsed_ns={}",
            start.elapsed().as_nanos()
        );
    }
}
