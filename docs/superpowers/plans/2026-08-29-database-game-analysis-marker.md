# Database Game Analysis Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the auto-report feature from regenerating a report every time a database-origin game (downloaded from lichess/chess.com, or any local database) is reopened, by giving those games a persisted "already analyzed" marker equivalent to the one file-origin games already have.

**Architecture:** A new `GameAnalysis(GameID, Label)` table, created lazily (`CREATE TABLE IF NOT EXISTS`, no migration step) the first time each `.db3` file's connection pool opens. Two new Tauri commands read/write one row in it. `createTab()` and `saveToFile()` (`src/utils/tabs.ts`) — the single choke point every "open/save a database game" call site already goes through — read the label on open and write it on save.

**Tech Stack:** Rust (Diesel raw `sql_query`, SQLite), Tauri commands + specta bindings, TypeScript/React, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-database-game-analysis-marker-design.md`

## Global Constraints

- No changes to the `Games` table, `schema.rs`, `models.rs`, `NormalizedGame`, or `get_games` (spec: Scope).
- The new table must apply to already-existing `.db3` files with no explicit migration step — creation must not be gated behind the existing `!db_exists` check used for brand-new databases (spec: Background, Architecture & data model).
- A label lookup failure on open must silently fall back to "not yet analyzed" — never surface an error notification for this best-effort lookup (spec: Data flow — read path).
- This environment cannot launch the Tauri GUI. Rust changes are verified with `cargo check` / `cargo test` from `src-tauri/`; the user must run `pnpm tauri dev` once afterward to let the real bindings exporter confirm the hand-written TypeScript declarations (spec: Bindings).

---

### Task 1: `GameAnalysis` table + query functions + Rust unit tests

**Files:**
- Modify: `src-tauri/src/db/mod.rs`

**Interfaces:**
- Produces: `fn ensure_game_analysis_table(db: &mut SqliteConnection) -> Result<(), Error>`, `fn get_game_analysis_label_query(db: &mut SqliteConnection, game_id: i32) -> Result<Option<String>, Error>`, `fn set_game_analysis_label_query(db: &mut SqliteConnection, game_id: i32, label: Option<&str>) -> Result<(), Error>` — Task 2 calls all three from the new `#[tauri::command]` wrappers.

This task adds the table and its plain (non-Tauri-command) query functions, following the existing pattern in this file where testable logic is a plain function taking `&mut SqliteConnection`, and commands are thin wrappers around it (see `delete_orphaned_data` / `check_index_exists`).

- [ ] **Step 1: Add the `Integer` sql type import**

Find this import block near the top of `src-tauri/src/db/mod.rs`:

```rust
use diesel::{
    prelude::*,
    r2d2::{ConnectionManager, Pool},
    sql_query,
    sql_types::Text,
};
```

Change `sql_types::Text` to `sql_types::{Integer, Text}`:

```rust
use diesel::{
    prelude::*,
    r2d2::{ConnectionManager, Pool},
    sql_query,
    sql_types::{Integer, Text},
};
```

- [ ] **Step 2: Write the failing tests**

Find the `#[cfg(test)] mod tests { ... }` block at the bottom of `src-tauri/src/db/mod.rs` (it already has a `setup_test_db()` helper and a `delete_orphaned_data_removes_unreferenced_players_events_sites` test). Add these two tests anywhere inside that `mod tests` block, after the existing tests:

```rust
    #[test]
    fn ensure_game_analysis_table_is_idempotent() {
        let db = &mut setup_test_db();
        ensure_game_analysis_table(db).unwrap();
        ensure_game_analysis_table(db).unwrap();
    }

    #[test]
    fn game_analysis_label_roundtrip() {
        let db = &mut setup_test_db();
        ensure_game_analysis_table(db).unwrap();

        assert_eq!(get_game_analysis_label_query(db, 1).unwrap(), None);

        set_game_analysis_label_query(db, 1, Some("Stockfish 16, depth 20 — 2026-08-29")).unwrap();
        assert_eq!(
            get_game_analysis_label_query(db, 1).unwrap(),
            Some("Stockfish 16, depth 20 — 2026-08-29".to_string())
        );

        set_game_analysis_label_query(db, 1, Some("Stockfish 17, depth 24 — 2026-08-30")).unwrap();
        assert_eq!(
            get_game_analysis_label_query(db, 1).unwrap(),
            Some("Stockfish 17, depth 24 — 2026-08-30".to_string())
        );

        // A different game's row is untouched.
        assert_eq!(get_game_analysis_label_query(db, 2).unwrap(), None);

        set_game_analysis_label_query(db, 1, None).unwrap();
        assert_eq!(get_game_analysis_label_query(db, 1).unwrap(), None);
    }
```

- [ ] **Step 3: Run the tests to verify they fail to compile**

Run (from the repo root):

```bash
cd src-tauri && cargo test db::tests::game_analysis_label_roundtrip
```

Expected: compile error — `ensure_game_analysis_table`, `get_game_analysis_label_query`, and `set_game_analysis_label_query` are not defined yet.

- [ ] **Step 4: Implement the table creation and query functions**

Add these three plain functions in `src-tauri/src/db/mod.rs`, near `check_index_exists` (they follow the same "raw `sql_query` + small `QueryableByName` struct" pattern):

```rust
fn ensure_game_analysis_table(db: &mut SqliteConnection) -> Result<(), Error> {
    db.batch_execute(
        "CREATE TABLE IF NOT EXISTS GameAnalysis (
            GameID INTEGER PRIMARY KEY,
            Label TEXT NOT NULL
        );",
    )?;
    Ok(())
}

#[derive(QueryableByName, Debug)]
struct GameAnalysisLabelRow {
    #[diesel(sql_type = Text, column_name = "Label")]
    label: String,
}

fn get_game_analysis_label_query(
    db: &mut SqliteConnection,
    game_id: i32,
) -> Result<Option<String>, Error> {
    let rows: Vec<GameAnalysisLabelRow> =
        sql_query("SELECT Label FROM GameAnalysis WHERE GameID = ?")
            .bind::<Integer, _>(game_id)
            .load(db)?;
    Ok(rows.into_iter().next().map(|r| r.label))
}

fn set_game_analysis_label_query(
    db: &mut SqliteConnection,
    game_id: i32,
    label: Option<&str>,
) -> Result<(), Error> {
    match label {
        Some(label) => {
            sql_query(
                "INSERT INTO GameAnalysis (GameID, Label) VALUES (?, ?)
                 ON CONFLICT(GameID) DO UPDATE SET Label = excluded.Label",
            )
            .bind::<Integer, _>(game_id)
            .bind::<Text, _>(label)
            .execute(db)?;
        }
        None => {
            sql_query("DELETE FROM GameAnalysis WHERE GameID = ?")
                .bind::<Integer, _>(game_id)
                .execute(db)?;
        }
    }
    Ok(())
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd src-tauri && cargo test db::tests::ensure_game_analysis_table_is_idempotent db::tests::game_analysis_label_roundtrip
```

Expected: both tests `PASS`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/mod.rs
git commit -m "feat(db): add GameAnalysis table and query functions"
```

---

### Task 2: Tauri commands, table creation on connect, registration, bindings

**Files:**
- Modify: `src-tauri/src/db/mod.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src/bindings/generated.ts`

**Interfaces:**
- Consumes: `ensure_game_analysis_table`, `get_game_analysis_label_query`, `set_game_analysis_label_query` (Task 1).
- Produces: Tauri commands `get_game_analysis_label(file, game_id) -> Result<Option<String>, Error>` and `set_game_analysis_label(file, game_id, label: Option<String>) -> Result<(), Error>`, plus their TypeScript bindings `commands.getGameAnalysisLabel(file: string, gameId: number): Promise<Result<string | null, string>>` and `commands.setGameAnalysisLabel(file: string, gameId: number, label: string | null): Promise<Result<null, string>>` — Task 3 calls these from the frontend.

- [ ] **Step 1: Hook table creation into `get_db_or_create`**

Find `get_db_or_create` in `src-tauri/src/db/mod.rs`:

```rust
fn get_db_or_create(
    state: &State<AppState>,
    db_path: &str,
    options: ConnectionOptions,
) -> Result<
    diesel::r2d2::PooledConnection<diesel::r2d2::ConnectionManager<diesel::SqliteConnection>>,
    Error,
> {
    let pool = match state.connection_pool.get(db_path) {
        Some(pool) => pool.clone(),
        None => {
            let pool = Pool::builder()
                .max_size(16)
                .connection_customizer(Box::new(options))
                .build(ConnectionManager::<SqliteConnection>::new(db_path))?;
            state
                .connection_pool
                .insert(db_path.to_string(), pool.clone());
            pool
        }
    };

    Ok(pool.get()?)
}
```

Replace it with (this ensures the table exists exactly once per database file per app run, for both brand-new and pre-existing `.db3` files — see Global Constraints):

```rust
fn get_db_or_create(
    state: &State<AppState>,
    db_path: &str,
    options: ConnectionOptions,
) -> Result<
    diesel::r2d2::PooledConnection<diesel::r2d2::ConnectionManager<diesel::SqliteConnection>>,
    Error,
> {
    let pool = match state.connection_pool.get(db_path) {
        Some(pool) => pool.clone(),
        None => {
            let pool = Pool::builder()
                .max_size(16)
                .connection_customizer(Box::new(options))
                .build(ConnectionManager::<SqliteConnection>::new(db_path))?;
            {
                let mut conn = pool.get()?;
                ensure_game_analysis_table(&mut conn)?;
            }
            state
                .connection_pool
                .insert(db_path.to_string(), pool.clone());
            pool
        }
    };

    Ok(pool.get()?)
}
```

- [ ] **Step 2: Add the two Tauri command wrappers**

Add these next to `write_db_game` in `src-tauri/src/db/mod.rs`:

```rust
#[tauri::command]
#[specta::specta]
pub async fn get_game_analysis_label(
    file: PathBuf,
    game_id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    get_game_analysis_label_query(db, game_id)
}

#[tauri::command]
#[specta::specta]
pub async fn set_game_analysis_label(
    file: PathBuf,
    game_id: i32,
    label: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    let db = &mut get_db_or_create(&state, file.to_str().unwrap(), ConnectionOptions::default())?;
    set_game_analysis_label_query(db, game_id, label.as_deref())
}
```

- [ ] **Step 3: Register the commands**

In `src-tauri/src/main.rs`, find this line inside the `tauri_specta::collect_commands!` list:

```rust
            delete_db_game,
            write_db_game,
```

Change it to:

```rust
            delete_db_game,
            write_db_game,
            get_game_analysis_label,
            set_game_analysis_label,
```

- [ ] **Step 4: Compile-check the Rust side**

```bash
cd src-tauri && cargo check
```

Expected: compiles with no errors (warnings about unused code are not expected here since both commands are registered).

- [ ] **Step 5: Run the full Rust test suite**

```bash
cd src-tauri && cargo test
```

Expected: all tests `PASS`, including the two from Task 1.

- [ ] **Step 6: Hand-write the matching TypeScript bindings**

This environment can't launch the Tauri GUI to let `specta_builder.export(...)` regenerate `src/bindings/generated.ts` automatically (see Global Constraints), so add the two entries by hand, in the same file, in the same style as the neighboring `deleteDbGame`/`writeDbGame` entries (find them and insert right after `writeDbGame`'s closing `},`):

```typescript
async getGameAnalysisLabel(file: string, gameId: number) : Promise<Result<string | null, string>> {
    try {
    return { status: "ok", data: await TAURI_INVOKE("get_game_analysis_label", { file, gameId }) };
} catch (e) {
    if(e instanceof Error) throw e;
    else return { status: "error", error: e  as any };
}
},
async setGameAnalysisLabel(file: string, gameId: number, label: string | null) : Promise<Result<null, string>> {
    try {
    return { status: "ok", data: await TAURI_INVOKE("set_game_analysis_label", { file, gameId, label }) };
} catch (e) {
    if(e instanceof Error) throw e;
    else return { status: "error", error: e  as any };
}
},
```

- [ ] **Step 7: Typecheck the frontend**

```bash
npx tsc --noEmit
```

Expected: no errors (this confirms the hand-written bindings' shape is internally consistent; it does not confirm they match what Rust will actually export at runtime — that's the `pnpm tauri dev` step called out in Global Constraints).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/mod.rs src-tauri/src/main.rs src/bindings/generated.ts
git commit -m "feat(db): add get/set game analysis label Tauri commands"
```

---

### Task 3: Frontend read/write wiring in `createTab()` / `saveToFile()`

**Files:**
- Modify: `src/utils/tabs.ts`
- Test: `src/utils/tests/tabs.test.ts` (new)

**Interfaces:**
- Consumes: `commands.getGameAnalysisLabel`, `commands.setGameAnalysisLabel` (Task 2); `GameHeaders` (already imported in `tabs.ts` from `./treeReducer`).
- Produces: `mergeAnalysisLabel(headers: GameHeaders, label: string | null): GameHeaders` and `resolveAnalysisLabel(headers: GameHeaders): string | null`, exported from `src/utils/tabs.ts`.

This task extracts the two small decisions (how a fetched label merges into headers, and how to read the label back out of headers to persist) into pure, directly-testable functions, then wires them into the existing async flows. This mirrors how `pickAutoEngine` was extracted and tested earlier in `src/components/boards/EnginesSelect.tsx` — this codebase has no component-test harness, so pure-function extraction plus Vitest is the established way to put a regression test on logic like this.

- [ ] **Step 1: Write the failing tests**

Create `src/utils/tests/tabs.test.ts`:

```typescript
import { expect, test } from "vitest";
import { mergeAnalysisLabel, resolveAnalysisLabel } from "../tabs";
import type { GameHeaders } from "../treeReducer";

const baseHeaders: GameHeaders = {
    id: 0,
    fen: "startpos",
    event: "?",
    site: "?",
    white: "?",
    black: "?",
    result: "*",
};

test("mergeAnalysisLabel adds the label into headers.other", () => {
    const merged = mergeAnalysisLabel(baseHeaders, "Stockfish 16, depth 20 — 2026-08-29");
    expect(merged.other?.Analysis).toBe("Stockfish 16, depth 20 — 2026-08-29");
});

test("mergeAnalysisLabel preserves existing other headers", () => {
    const headers: GameHeaders = { ...baseHeaders, other: { ECO: "B90" } };
    const merged = mergeAnalysisLabel(headers, "Stockfish 16, depth 20 — 2026-08-29");
    expect(merged.other).toEqual({ ECO: "B90", Analysis: "Stockfish 16, depth 20 — 2026-08-29" });
});

test("mergeAnalysisLabel returns the same headers unchanged when label is null", () => {
    const merged = mergeAnalysisLabel(baseHeaders, null);
    expect(merged).toBe(baseHeaders);
});

test("resolveAnalysisLabel reads the label back out", () => {
    const headers: GameHeaders = { ...baseHeaders, other: { Analysis: "Stockfish 16 — 2026-08-29" } };
    expect(resolveAnalysisLabel(headers)).toBe("Stockfish 16 — 2026-08-29");
});

test("resolveAnalysisLabel returns null when there is no analysis label", () => {
    expect(resolveAnalysisLabel(baseHeaders)).toBeNull();
    expect(resolveAnalysisLabel({ ...baseHeaders, other: { ECO: "B90" } })).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/utils/tests/tabs.test.ts
```

Expected: FAIL — `mergeAnalysisLabel` and `resolveAnalysisLabel` are not exported from `../tabs` yet.

- [ ] **Step 3: Implement the two pure functions**

In `src/utils/tabs.ts`, add these two exported functions (anywhere at module scope — e.g. right before `createTab`):

```typescript
export function mergeAnalysisLabel(headers: GameHeaders, label: string | null): GameHeaders {
    if (!label) return headers;
    return { ...headers, other: { ...headers.other, Analysis: label } };
}

export function resolveAnalysisLabel(headers: GameHeaders): string | null {
    return headers.other?.Analysis ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/utils/tests/tabs.test.ts
```

Expected: all 5 tests `PASS`.

- [ ] **Step 5: Wire the read path into `createTab()`**

In `src/utils/tabs.ts`, find:

```typescript
    if (pgn !== undefined) {
        const tree = await parsePGN(pgn, headers?.fen);
        if (headers) {
            tree.headers = headers;
            if (position) {
                tree.position = position;
            }
        }
        sessionStorage.setItem(id, JSON.stringify({ version: 0, state: tree }));
    }
```

Replace it with:

```typescript
    if (pgn !== undefined) {
        const tree = await parsePGN(pgn, headers?.fen);
        if (headers) {
            tree.headers = headers;
            if (position) {
                tree.position = position;
            }
        }
        if (gameOrigin?.kind === "database") {
            let label: string | null = null;
            try {
                const result = await commands.getGameAnalysisLabel(
                    gameOrigin.database,
                    gameOrigin.gameId,
                );
                label = result.status === "ok" ? result.data : null;
            } catch {
                label = null;
            }
            tree.headers = mergeAnalysisLabel(tree.headers, label);
        }
        sessionStorage.setItem(id, JSON.stringify({ version: 0, state: tree }));
    }
```

- [ ] **Step 6: Wire the write path into `saveToFile()`**

In `src/utils/tabs.ts`, find:

```typescript
    if (databaseOrigin) {
        await commands.writeDbGame(databaseOrigin.database, databaseOrigin.gameId, pgn);
        store.getState().save();
        return;
    }
```

Replace it with:

```typescript
    if (databaseOrigin) {
        await commands.writeDbGame(databaseOrigin.database, databaseOrigin.gameId, pgn);
        await commands.setGameAnalysisLabel(
            databaseOrigin.database,
            databaseOrigin.gameId,
            resolveAnalysisLabel(store.getState().headers),
        );
        store.getState().save();
        return;
    }
```

- [ ] **Step 7: Typecheck, lint, and format**

```bash
npx tsc --noEmit
npx oxfmt src/utils/tabs.ts src/utils/tests/tabs.test.ts
npx oxlint src/utils/tabs.ts src/utils/tests/tabs.test.ts
```

Expected: `tsc` reports no errors; `oxlint` reports no new warnings (compare against `git stash`/`git diff` if anything looks suspicious, the same way prior work in this session double-checked pre-existing warnings).

- [ ] **Step 8: Commit**

```bash
git add src/utils/tabs.ts src/utils/tests/tabs.test.ts
git commit -m "fix(tabs): persist and restore the analysis-report marker for database-origin games"
```

---

### Task 4: Full verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1–3.

- [ ] **Step 1: Run the full Rust test suite again**

```bash
cd src-tauri && cargo test
```

Expected: all tests `PASS`.

- [ ] **Step 2: Run the full frontend test suite**

```bash
npx vitest run
```

Expected: all tests `PASS` (should be the prior count plus the 5 new tests from Task 3).

- [ ] **Step 3: Full frontend typecheck and lint**

```bash
npx tsc --noEmit
npx oxlint
```

Expected: no errors; no new warnings beyond any pre-existing ones already present before this plan.

- [ ] **Step 4: Production build sanity check**

```bash
npx vite build
```

Expected: build succeeds.

- [ ] **Step 5: Tell the user to confirm bindings**

This is a manual step, not a command: tell the user to run `pnpm tauri dev` once, then check `git diff src/bindings/generated.ts` — it should show no changes (confirming the hand-written `getGameAnalysisLabel`/`setGameAnalysisLabel` entries from Task 2 match what the real exporter produces). If it does show a diff, apply the exporter's version — it's authoritative.

- [ ] **Step 6: Tell the user to manually verify the actual fix**

This is also a manual step: open a database-origin game (e.g. from the Database panel or Recent Online Games), let a report auto-generate, close the tab, reopen the same game, and confirm the report does **not** regenerate. This environment has no way to launch the Tauri GUI to verify this directly.
