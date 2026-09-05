# Database Game Analysis Marker — Design

## Summary

Auto-generated reports regenerate every time a database-origin game
(downloaded from lichess/chess.com, or any local database) is reopened,
because there is currently no way to persist "this game already has a
report" for database games. Add a small side table,
`GameAnalysis(GameID, Label)`, plus a read and a write hook, so the
existing auto-report guard (`headers.other?.Analysis`) works for
database-origin games the same way it already works for file-origin
games.

## Scope

In scope:

- New `GameAnalysis` table in the per-account/per-collection `.db3`
  SQLite files, created lazily and idempotently so it backfills onto
  already-existing database files with no explicit migration step.
- Two new Tauri commands: `get_game_analysis_label` and
  `set_game_analysis_label`.
- Wiring `createTab()` (read) and `saveToFile()` (write) in
  `src/utils/tabs.ts` so every existing "open a database game" call
  site is fixed through one shared choke point.
- A Rust unit test for the two new commands.

Out of scope:

- Any change to the `Games` table, `schema.rs`, `models.rs`,
  `NormalizedGame`, or `get_games`. This is a separate table with no
  foreign-key enforcement; existing queries are untouched.
- Reconciling/deleting orphaned `GameAnalysis` rows when a game is
  deleted (`delete_db_game`, `delete_empty_games`,
  `delete_duplicated_games`). An orphaned row is dead weight, never
  looked up again once its `GameID` no longer resolves to a game — not
  worth the extra join/cleanup logic for a one-row-per-game label.
- The file-origin path (`headers.other.Analysis` via PGN header tags).
  It already works correctly; not touched.

## Background: what already exists

- `BoardAnalysis.tsx`'s auto-generate-report effect skips regeneration
  when `headers.other?.Analysis` is already set
  (`src/components/boards/BoardAnalysis.tsx:109`). This flag is set by
  `addAnalysis()` in the tree store (`src/state/store/tree.ts:802-804`)
  once a report finishes, and for file-origin games it round-trips
  correctly: `getPGN()` serializes `headers.other` as arbitrary
  `[Tag "value"]` lines (`src/utils/chess.ts:211-213`), and reopening a
  file re-parses them back via a generic tag lexer
  (`src/utils/chess.ts:496-524`) — there's no fixed allow-list, so
  custom tags survive.
- Database-origin games have no equivalent path. `createTab()`
  (`src/utils/tabs.ts`) does `tree.headers = headers` whenever a
  caller passes explicit `headers` — and all 5 "open a database game"
  call sites (`RecentOnlineGames.tsx`, `GamesTable.tsx`,
  `GameCard.tsx`, `GameTable.tsx`, `TournamentCard.tsx`) pass the raw
  `NormalizedGame` row as `headers`, which has no `other` field at all.
  Even if that overwrite were fixed, there's nowhere for the marker to
  come from: the `Games` table (`src-tauri/src/db/create.sql`) has no
  column for arbitrary headers, and `write_db_game`
  (`src-tauri/src/db/mod.rs:1832`) re-parses the incoming PGN text and
  writes only the fixed, known columns — a custom tag would be
  discarded even if it were present in the PGN sent to it.
- `.db3` files have no migration mechanism today.
  `CREATE_TABLES_SQL` (`create.sql`) only ever runs once, inside
  `convert_pgn`, gated by `!db_exists` — i.e. only for a database that
  doesn't exist yet on disk. Anything added there would never reach
  the `.db3` files already sitting on users' machines from earlier
  downloads.
- `get_db_or_create` (`src-tauri/src/db/mod.rs:191-214`) is the shared
  connection-pool accessor nearly every DB command goes through. It
  caches one `r2d2::Pool` per `db_path` in `state.connection_pool`, so
  the `None => { ... }` branch (building a fresh pool) runs exactly
  once per database file per app run — regardless of whether the file
  is brand new or years old.
- Raw, outside-the-Diesel-schema queries already have a precedent:
  `check_index_exists` (`src-tauri/src/db/mod.rs:761-765`) uses
  `sql_query(...)` with a small `#[derive(QueryableByName)]` struct.

## Approach

Give every `.db3` file a small, independent `GameAnalysis` table and
two commands to read/write a single row in it, then hook those into
the one place (`src/utils/tabs.ts`) all database-game opens and saves
already flow through.

Two alternatives considered and rejected in the prior discussion:

- Adding an `Analysis` column to `Games` itself: requires an
  `ALTER TABLE` migration path (checking column existence via
  `PRAGMA table_info`) plus `schema.rs`/`models.rs`/`get_games`/
  `write_db_game` changes — much larger blast radius for the same
  outcome.
- Disabling auto-report for database-origin games entirely: avoids all
  backend work, but removes the feature for downloaded games rather
  than fixing it.

## Architecture & data model

New table, created via `CREATE TABLE IF NOT EXISTS` (not gated by
`!db_exists`, so it applies uniformly to old and new `.db3` files):

```sql
CREATE TABLE IF NOT EXISTS GameAnalysis (
    GameID INTEGER PRIMARY KEY,
    Label TEXT NOT NULL
);
```

No `FOREIGN KEY` constraint — see Scope for why orphaned rows are an
accepted, harmless outcome.

**Where it's created:** inside `get_db_or_create`'s pool-creation
branch, using a connection freshly pulled from the just-built pool,
before that pool is inserted into `state.connection_pool` and before
the function returns its own connection to the caller. This guarantees
the table exists before any query that follows, runs once per file per
app session (not once per query), and requires no explicit migration
step or version tracking.

**New commands** (`src-tauri/src/db/mod.rs`, registered in
`main.rs`'s `collect_commands!`):

```rust
#[derive(QueryableByName, Debug, Serialize)]
struct GameAnalysisLabelRow {
    #[diesel(sql_type = Text, column_name = "Label")]
    label: String,
}

#[tauri::command]
#[specta::specta]
pub async fn get_game_analysis_label(
    file: PathBuf,
    game_id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, Error>;

#[tauri::command]
#[specta::specta]
pub async fn set_game_analysis_label(
    file: PathBuf,
    game_id: i32,
    label: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error>;
```

`get_game_analysis_label` returns `Ok(None)` when no row exists (not
an error). `set_game_analysis_label` upserts
(`INSERT ... ON CONFLICT(GameID) DO UPDATE SET Label = excluded.Label`)
when `label` is `Some`, and deletes the row when `label` is `None` —
kept symmetric with how `headers.other.Analysis` can in principle be
absent, even though nothing in the UI currently clears it once set.

## Data flow

**Read** — `createTab()` (`src/utils/tabs.ts`): today, when `headers`
is passed, it unconditionally does `tree.headers = headers`. This
stays as-is (no change to the general overwrite behavior for other
callers). Immediately after, when `gameOrigin?.kind === "database"`,
fetch the label and merge it in:

```ts
if (gameOrigin?.kind === "database") {
  const label = await getGameAnalysisLabel(gameOrigin.database, gameOrigin.gameId);
  if (label) {
    tree.headers.other = { ...tree.headers.other, Analysis: label };
  }
}
```

`getGameAnalysisLabel` wraps the command call in a try/catch that
resolves to `null` on failure — a lookup failure should silently fall
back to "not yet analyzed" (worst case: one avoidable regeneration),
not surface an error notification for what's a best-effort enhancement
tied to a background admin table.

This fixes all 5 existing "open a database game" call sites through
the one shared function, rather than touching each individually.

**Write** — `saveToFile()` (`src/utils/tabs.ts`), existing
`databaseOrigin` branch:

```ts
if (databaseOrigin) {
  await commands.writeDbGame(databaseOrigin.database, databaseOrigin.gameId, pgn);
  const label = store.getState().headers.other?.Analysis ?? null;
  await commands.setGameAnalysisLabel(databaseOrigin.database, databaseOrigin.gameId, label);
  store.getState().save();
  return;
}
```

This branch already runs on every save of a database-origin tab,
including the existing autosave-on-`dirty` effect in
`BoardAnalysis.tsx` — so a report's completion (which sets
`headers.other.Analysis` and flips `dirty`) reaches this path with no
new triggering logic needed, exactly like the file-origin case.

## Testing

- Rust: a unit test in `src-tauri/src/db/mod.rs`'s existing test
  module (reusing `setup_test_db()`) covering: label absent returns
  `None`; set then get round-trips; set again overwrites; set `None`
  removes the row.
- Frontend: existing Vitest suite plus `tsc`/`oxlint`/production
  build, as with prior changes in this session. No React component
  test harness exists in this repo to exercise `createTab`/`saveToFile`
  end-to-end; verification here is by reading the code path plus the
  Rust unit test covering the actual persistence logic.
- Manual verification of the full loop (open a downloaded game,
  generate a report, close the tab, reopen the same game, confirm no
  regeneration) is out of reach in this environment — no Tauri GUI
  available here. Flagged for the user to confirm once they run it.

## Bindings

The two new commands need entries in `src/bindings/generated.ts`,
normally produced automatically by `specta_builder.export(...)`
(`src-tauri/src/main.rs`, runs at the top of `main()` before any window
opens, gated by `#[cfg(debug_assertions)]`). This environment can't
launch the Tauri GUI, so after implementing and confirming the Rust
side compiles (`cargo check`), the matching TypeScript declarations
will be hand-written into `generated.ts` in the same style as existing
entries. The user should run `pnpm tauri dev` once afterward so the
real exporter regenerates the file and confirms it matches what was
hand-written (a mismatch would only affect the two new commands, not
any existing ones).
