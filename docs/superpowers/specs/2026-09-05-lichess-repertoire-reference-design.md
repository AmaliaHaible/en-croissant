# Lichess as a repertoire-builder reference database

**Date:** 2026-09-05
**Status:** Design approved, ready for implementation planning
**Scope:** Repertoire builder ("Build" tab of the Practice panel) only

## Problem

The repertoire builder checks opponent moves and computes coverage against a
single local `.db3` database, chosen via `referenceDbAtom` (a bare file path).
There is no way to use the Lichess opening explorer as the reference, even
though the normal analysis panel (`DatabasePanel.tsx`) can already query
`explorer.lichess.org` for the "Lichess" and "Lichess Masters" databases.

Two obstacles:

1. **No Lichess path in the repertoire code.** `RepertoireInfo.tsx` and
   `utils/repertoire.ts` call `searchPosition` / `searchPositionsBatch`
   (Rust `search_position` / `search_positions_batch`) with a file path and
   nothing else.
2. **Volume.** `computeTreeCoverage` resolves *every unique position* in the
   sub-repertoire in a single batch. Against Lichess that is potentially
   hundreds of HTTP requests per recompute, and a recompute fires (debounced)
   whenever the tree changes. A persistent cache and request rate-limiting are
   mandatory, not optional.

Both the coverage batch and the single-position "opponent moves" lookup consume
the same shape: `PositionStats[]` — `{ move, white, draw, black }` per move,
plus a `move: "*"` summary row giving games that terminate at the exact
position. Any Lichess-backed provider must produce that shape.

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| Where is Lichess selectable as a reference? | Repertoire builder only. Game-report novelty detection keeps requiring a real local DB. |
| How does it appear in the Databases tab? | It does not. The source is chosen inside the repertoire Build panel. |
| Query parameters | Fixed sensible defaults. Lichess-all: `variant=standard`, all ratings, all speeds, no date filter. Masters: no date filter. One cache entry per position. |
| Cache freshness | Permanent. Manual "Clear cache" only, no TTL. |

## Approach

A Rust batch command plus a SQLite cache, mirroring `search_positions_batch`.
Rate-limiting, in-flight de-duplication, HTTP, `*`-row synthesis and
persistence all live in one new backend module. The frontend gains a small
reference union and a source selector; no other consumer of `referenceDbAtom`
changes.

Rejected alternatives:

- **TypeScript-driven cache** (Rust only stores rows): JS-side throttling and
  de-dup across a long coverage scan is fragile, every miss is two IPC
  round-trips, and it shares no code with the analysis-panel explorer path
  anyway (different response mapping).
- **Generalize `referenceDbAtom` into a typed provider used everywhere**
  (report novelty, DatabasePanel, `App.tsx` preload, Rust `positions_in_db`):
  cleanest long-term but a large blast radius for a feature scoped to the
  repertoire builder. YAGNI.

## Section 1 — Reference model & data flow

### New atom

`repertoireReferenceSourceAtom`: `atomWithStorage<"reference" | "lichess" | "masters">`
in `localStorage`, default `"reference"`. Lives in `src/state/atoms.ts` next to
`referenceDbAtom`. It is deliberately separate from `referenceDbAtom` so that
game reports, the DatabasePanel local tab, and `App.tsx`'s `preloadReferenceDb`
keep seeing `referenceDbAtom` unchanged.

### Resolved reference

```ts
export type RepertoireReference =
  | { kind: "local"; path: string }
  | { kind: "lichess" }
  | { kind: "masters" };
```

Resolution in `RepertoireInfo.tsx`:

- `source === "reference"` → `referenceDb` set ? `{ kind: "local", path: referenceDb }` : `null`
- `source === "lichess"` → `{ kind: "lichess" }`
- `source === "masters"` → `{ kind: "masters" }`

`null` only happens for `source === "reference"` with no DB set; that path keeps
the existing "no reference database" alert (reworded).

### Data flow (coverage)

`RepertoireInfo` effect
→ `computeTreeCoverage(root, color, reference, minGames, startPath, signal)`
→ collect unique FENs
→ `reference.kind === "local"` ? `searchPositionsBatch(path, fens)` : `getExplorerMoves(reference.kind, fens)`
→ `PositionStats[][]` (index-aligned)
→ identical downstream coverage math.

### Data flow (opponent-move list)

The first `useEffect` in `RepertoireInfo` currently calls `searchPosition` for
the current node's FEN. It becomes:

```ts
reference.kind === "local"
  ? searchPosition({ path, type: "exact", fen, color: "white", player: null, result: "any" }, "build-tab")
      .then(([openings]) => openings)
  : getExplorerMoves(reference.kind, [fen]).then((r) => r[0] ?? []);
```

then the same `.filter((op) => op.move !== "*")`.

### FEN normalization

Cache keys and explorer query FENs use the FEN truncated to its first four
space-separated fields (piece placement, side to move, castling, en passant),
dropping the halfmove clock and fullmove number. Transpositions reached with
different move counts then share one cache entry. Applied on the Rust side in
`get_explorer_moves` before both the cache lookup and the HTTP request.

## Section 2 — Rust backend

New module `src-tauri/src/explorer.rs`, declared in `main.rs`.

### Cache store

SQLite file `explorer_cache.db3` in the Tauri app-data directory
(`app.path().app_data_dir()`). Schema created on first open:

```sql
CREATE TABLE IF NOT EXISTS position_cache (
  source     TEXT NOT NULL,   -- 'lichess' | 'masters'
  fen        TEXT NOT NULL,   -- normalized, 4-field
  response   TEXT NOT NULL,   -- JSON array of PositionStats, including the synthesized '*' row
  fetched_at INTEGER NOT NULL, -- unix seconds, for future use / debugging
  PRIMARY KEY (source, fen)
);
```

No TTL. Backed by an r2d2 `Pool<ConnectionManager<SqliteConnection>>` (same
manager type already used in `AppState.connection_pool`), stored in a new
`AppState` field:

```rust
explorer_cache: OnceCell<ExplorerCache>, // or Mutex<Option<...>>, lazily initialized
```

`ExplorerCache` holds: the connection pool, a shared `governor` rate limiter,
and a `DashMap<(ExplorerSource, String), Arc<tokio::sync::Mutex<()>>>` for
in-flight de-duplication.

### Types

```rust
#[derive(Serialize, Deserialize, Type, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ExplorerSource { Lichess, Masters }

#[derive(Serialize, Type)]
pub struct ExplorerCacheStats { pub entries: i64, pub bytes: i64 }
```

`PositionStats` is reused from `db::search`.

### Commands (registered in `collect_commands!` in `main.rs`)

#### `get_explorer_moves(source: ExplorerSource, fens: Vec<String>) -> Result<Vec<Vec<PositionStats>>, Error>`

1. Return `Ok(vec![])` if `fens` is empty.
2. Normalize every FEN to 4 fields. De-duplicate for the lookup; remember the
   mapping so the return vec stays index-aligned with the *input*.
3. One `SELECT source, fen, response FROM position_cache WHERE source = ? AND fen IN (…)`;
   deserialize hits.
4. For misses, sequentially (bounded concurrency 1 keeps it simplest and is
   well within Lichess limits):
   - Acquire the per-`(source, fen)` in-flight mutex. Re-check the cache after
     acquiring (another batch may have filled it).
   - `rate_limiter.until_ready().await`.
   - `GET` from the explorer (see Endpoints). Reuse `AppState.http_client`.
   - On HTTP 429: exponential backoff (e.g. 1s, 2s, 4s), max 3 retries. On
     final failure or any other error: log, treat this FEN's result as an empty
     `Vec<PositionStats>` (coverage already handles "no data" — same as a local
     miss), and do **not** write a cache row.
   - On success: map JSON → `Vec<PositionStats>` (below), `INSERT OR REPLACE`
     the row, release the mutex.
5. Assemble and return `Vec<Vec<PositionStats>>` aligned with `fens`.

#### JSON → `PositionStats` mapping and `*`-row synthesis

Explorer response (both `/lichess` and `/masters`) has top-level `white`,
`draws`, `black` (totals for the position, including games that terminate here)
and a `moves[]` array, each with `white`, `draws`, `black`.

- One `PositionStats { move_: m.san, white: m.white, draw: m.draws, black: m.black }`
  per entry in `moves[]`.
- One synthesized summary row:
  `PositionStats {
     move_: "*",
     white: top.white - Σ moves.white,
     draw:  top.draws - Σ moves.draws,
     black: top.black - Σ moves.black,
   }`
  clamped at 0 per field (guard against any off-by-one in explorer data).

This makes `computeTreeCoverage`'s `gamesEndingHere + gamesContinuing`
reconstruct the true position total.

#### `clear_explorer_cache() -> Result<(), Error>`

`DELETE FROM position_cache;` then `VACUUM;`. Safe to call when the cache file
does not exist yet (initialize first, then clear).

#### `explorer_cache_stats() -> Result<ExplorerCacheStats, Error>`

`SELECT COUNT(*) FROM position_cache` for `entries`; `std::fs::metadata` on the
cache file for `bytes` (0 if absent).

### Endpoints

- Lichess: `https://explorer.lichess.org/lichess?variant=standard&fen=<normalized>`
- Masters: `https://explorer.lichess.org/masters?fen=<normalized>`

No auth token. The explorer endpoints do not require one; the app's existing
`missingExplorerToken` gate on the analysis panel is unrelated and untouched.

Rate limiter constant: 1 request / second (shared across all
`get_explorer_moves` calls). Tunable in one place.

## Section 3 — Frontend wiring

### `src/utils/db.ts`

```ts
export async function getExplorerMoves(source: "lichess" | "masters", fens: string[]) {
  return unwrap(await commands.getExplorerMoves(source, fens));
}
```

### `src/utils/repertoire.ts`

`computeTreeCoverage`'s `dbPath: string` parameter becomes
`reference: RepertoireReference`. After `fenList` is built:

```ts
const batch =
  reference.kind === "local"
    ? await searchPositionsBatch(reference.path, fenList)
    : await getExplorerMoves(reference.kind, fenList);
```

Nothing else in the function changes. `RepertoireReference` is exported from
this module.

### `src/components/panels/practice/RepertoireInfo.tsx`

- Read `repertoireReferenceSourceAtom` and `referenceDbAtom`; derive
  `reference: RepertoireReference | null`.
- **Source selector:** a `SegmentedControl` at the top of the Build panel with
  `Reference DB` / `Lichess` / `Lichess Masters`, bound to
  `repertoireReferenceSourceAtom`.
- Guard: `reference === null` (source `"reference"`, no DB) → existing
  `Board.Practice.Build.NoRefDb` alert (reworded to mention the selector).
- Opponent-move `useEffect`: branch between `searchPosition` and
  `getExplorerMoves` as in Section 1.
- Coverage `useEffect`: pass `reference`; replace the `referenceDb` dependency
  with a stable string key `` `${source}:${referenceDb ?? ""}` ``.
- Keep the 500 ms structure-hash debounce and the `practiceTab !== "build"`
  guard — both matter more now that recompute can mean network traffic.

### Bindings

`commands.getExplorerMoves`, `commands.clearExplorerCache`,
`commands.explorerCacheStats` and the `ExplorerSource` / `ExplorerCacheStats`
types are generated into `src/bindings/generated.ts` on the next debug
`tauri dev`. No hand edits.

## Section 4 — Cache management UI + i18n

### Settings

In `SettingsPage.tsx`, a new row near the existing repertoire/database
settings:

- SWR-fetched `explorer_cache_stats`, rendered as
  "Lichess cache: 1,234 positions · 2.1 MB".
- **Clear cache** button → confirm modal → `clear_explorer_cache()` →
  revalidate the stats.

### i18n

Add keys by hand to `src/translation/en-US.json` **only** (running
`pnpm i18n:extract` rewrites every catalog — see the repo memory note). Do not
run the full extract.

New keys (final names to be settled during implementation):

- `Board.Practice.Build.ReferenceSource`
- `Board.Practice.Build.SourceReferenceDb`
- `Board.Practice.Build.SourceLichess`
- `Board.Practice.Build.SourceLichessMasters`
- `Board.Practice.Build.NoRefDb` (reword existing)
- `Settings.ExplorerCache.Title`
- `Settings.ExplorerCache.Description`
- `Settings.ExplorerCache.Stats`
- `Settings.ExplorerCache.Clear`
- `Settings.ExplorerCache.ClearConfirm`

## Section 5 — Testing

### `src/utils/tests/repertoire.test.ts` (exists; mocks `searchPositionsBatch`)

- Update every `computeTreeCoverage(tree, color, "db.db3", …)` call to
  `{ kind: "local", path: "db.db3" }`.
- Add a case with `reference: { kind: "lichess" }` and `getExplorerMoves`
  mocked: assert it is called once with the unique FEN list, and that the
  resulting coverage/games/missing maps are identical to the local path given
  the same `PositionStats` inputs.

### Rust (`explorer.rs`, `#[cfg(test)]`)

- **`*`-row synthesis:** a mock explorer payload → assert per-move
  `PositionStats` are correct and the `*` row equals top-level totals minus the
  per-move sums, clamped at 0.
- **FEN normalization:** a 6-field FEN and its 4-field form map to the same
  cache key.
- **Cache round-trip:** `put` then `get` returns the stored response with no
  HTTP call (hit-count or a client that fails on use).

### Manual smoke

Open a large repertoire (e.g. the Najdorf preset), switch the source selector
to Lichess. Confirm the first coverage scan populates the cache with the rate
limiter visibly pacing requests, a second recompute is instant, and
Settings → Clear cache empties it (`explorer_cache_stats` returns 0).

## Files touched

**New**
- `src-tauri/src/explorer.rs`
- (maybe) `src/utils/repertoire/reference.ts` — or keep the type in `repertoire.ts`

**Modified**
- `src-tauri/src/main.rs` — module decl, `AppState` field, `collect_commands!`
- `src-tauri/Cargo.toml` — no new deps expected (`reqwest`, `governor`,
  `diesel`+`r2d2`, `serde_json` already present); confirm during implementation
- `src/state/atoms.ts` — `repertoireReferenceSourceAtom`
- `src/utils/db.ts` — `getExplorerMoves`
- `src/utils/repertoire.ts` — `computeTreeCoverage` signature + branch
- `src/components/panels/practice/RepertoireInfo.tsx` — selector, resolver,
  both lookups
- `src/components/settings/SettingsPage.tsx` — cache stats + clear
- `src/translation/en-US.json` — new keys (by hand)
- `src/utils/tests/repertoire.test.ts` — updated + new case
- `src/bindings/generated.ts` — regenerated (not hand-edited)

## Out of scope

- Any change to game-report novelty detection or `positions_in_db`.
- Any change to the analysis panel's explorer path or its token gate.
- Respecting the analysis panel's Lichess rating/speed/date filters in the
  repertoire reference (fixed defaults only).
- Per-entry TTL / automatic refresh.
- Showing Lichess as an entry in the Databases tab.
- Opening individual Lichess games from the repertoire builder.
