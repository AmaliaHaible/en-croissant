use std::{collections::VecDeque, fs::remove_file, path::PathBuf, sync::Mutex};

use diesel::{Connection, ExpressionMethods, OptionalExtension, QueryDsl, RunQueryDsl};
use once_cell::sync::Lazy;
use rand::Rng;
use serde::Serialize;
use specta::Type;

use crate::{
    db::{puzzle_themes, puzzles, themes, Puzzle},
    error::Error,
};

#[derive(Debug)]
struct PuzzleCache {
    cache: VecDeque<Puzzle>,
    counter: usize,
    min_rating: u16,
    max_rating: u16,
    theme: Option<String>,
    file: String,
}

impl PuzzleCache {
    fn new() -> Self {
        Self {
            cache: VecDeque::new(),
            counter: 0,
            min_rating: 0,
            max_rating: 0,
            theme: None,
            file: String::new(),
        }
    }

    fn get_puzzles(
        &mut self,
        file: &str,
        min_rating: u16,
        max_rating: u16,
        theme: &Option<String>,
    ) -> Result<(), Error> {
        if self.cache.is_empty()
            || self.min_rating != min_rating
            || self.max_rating != max_rating
            || self.theme != *theme
            || self.file != file
            || self.counter >= self.cache.len()
        {
            self.cache.clear();
            self.counter = 0;

            let mut db = diesel::SqliteConnection::establish(file).expect("open database");

            let min_id = puzzles::table
                .select(puzzles::id)
                .order(puzzles::id.asc())
                .first::<i32>(&mut db)
                .optional()?;
            let max_id = puzzles::table
                .select(puzzles::id)
                .order(puzzles::id.desc())
                .first::<i32>(&mut db)
                .optional()?;

            let Some((min_id, max_id)) = min_id.zip(max_id) else {
                self.cache.clear();
                return Ok(());
            };
            let pivot = rand::thread_rng().gen_range(min_id..=max_id);

            let new_puzzles: Vec<Puzzle> = if let Some(theme_name) = theme {
                let mut selected = puzzles::table
                    .inner_join(puzzle_themes::table.inner_join(themes::table))
                    .filter(themes::name.eq(theme_name))
                    .filter(puzzles::rating.le(max_rating as i32))
                    .filter(puzzles::rating.ge(min_rating as i32))
                    .filter(puzzles::id.ge(pivot))
                    .select(puzzles::all_columns)
                    .order(puzzles::id.asc())
                    .limit(20)
                    .load::<Puzzle>(&mut db)?;

                if selected.len() < 20 {
                    let remaining = (20 - selected.len()) as i64;
                    selected.extend(
                        puzzles::table
                            .inner_join(puzzle_themes::table.inner_join(themes::table))
                            .filter(themes::name.eq(theme_name))
                            .filter(puzzles::rating.le(max_rating as i32))
                            .filter(puzzles::rating.ge(min_rating as i32))
                            .filter(puzzles::id.lt(pivot))
                            .select(puzzles::all_columns)
                            .order(puzzles::id.asc())
                            .limit(remaining)
                            .load::<Puzzle>(&mut db)?,
                    );
                }
                selected
            } else {
                let mut selected = puzzles::table
                    .filter(puzzles::rating.le(max_rating as i32))
                    .filter(puzzles::rating.ge(min_rating as i32))
                    .filter(puzzles::id.ge(pivot))
                    .order(puzzles::id.asc())
                    .limit(20)
                    .load::<Puzzle>(&mut db)?;

                if selected.len() < 20 {
                    let remaining = (20 - selected.len()) as i64;
                    selected.extend(
                        puzzles::table
                            .filter(puzzles::rating.le(max_rating as i32))
                            .filter(puzzles::rating.ge(min_rating as i32))
                            .filter(puzzles::id.lt(pivot))
                            .order(puzzles::id.asc())
                            .limit(remaining)
                            .load::<Puzzle>(&mut db)?,
                    );
                }
                selected
            };

            self.cache = new_puzzles.into_iter().collect();
            self.min_rating = min_rating;
            self.max_rating = max_rating;
            self.theme = theme.clone();
            self.file = file.to_string();
        }

        Ok(())
    }

    fn get_next_puzzle(&mut self) -> Option<Puzzle> {
        if let Some(puzzle) = self.cache.get(self.counter) {
            self.counter += 1;
            Some(puzzle.clone())
        } else {
            None
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_puzzle(
    file: String,
    min_rating: u16,
    max_rating: u16,
    theme: Option<String>,
) -> Result<Puzzle, Error> {
    tauri::async_runtime::spawn_blocking(move || {
        static PUZZLE_CACHE: Lazy<Mutex<PuzzleCache>> =
            Lazy::new(|| Mutex::new(PuzzleCache::new()));

        let mut cache = PUZZLE_CACHE.lock().unwrap();
        cache.get_puzzles(&file, min_rating, max_rating, &theme)?;
        cache.get_next_puzzle().ok_or(Error::NoPuzzles)
    })
    .await
    .map_err(|error| std::io::Error::other(format!("puzzle task failed: {error}")))?
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleDatabaseInfo {
    title: String,
    description: String,
    puzzle_count: i32,
    storage_size: u64,
    path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn get_puzzle_db_info(file: PathBuf) -> Result<PuzzleDatabaseInfo, Error> {
    let path = file;

    let mut db =
        diesel::SqliteConnection::establish(&path.to_string_lossy()).expect("open database");

    let puzzle_count = puzzles::table.count().get_result::<i64>(&mut db)? as i32;

    let storage_size = path.metadata()?.len();
    let filename = path.file_name().expect("get filename").to_string_lossy();

    Ok(PuzzleDatabaseInfo {
        title: filename.to_string(),
        description: "".to_string(),
        puzzle_count,
        storage_size,
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn delete_puzzle_database(file: String) -> Result<(), Error> {
    remove_file(&file)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_puzzle_themes(file: String) -> Result<Vec<String>, Error> {
    let mut db = diesel::SqliteConnection::establish(&file).expect("open database");
    let result: Vec<String> = themes::table
        .select(themes::name)
        .order(themes::name.asc())
        .load(&mut db)?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn get_themes_for_puzzle(file: String, puzzle_id: i32) -> Result<Vec<String>, Error> {
    let mut db = diesel::SqliteConnection::establish(&file).expect("open database");
    let result: Vec<String> = themes::table
        .inner_join(puzzle_themes::table)
        .filter(puzzle_themes::puzzle_id.eq(puzzle_id))
        .select(themes::name)
        .order(themes::name.asc())
        .load(&mut db)?;
    Ok(result)
}
