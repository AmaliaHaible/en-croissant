# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

En Croissant 2.0 — a cross-platform desktop chess GUI, analysis workbench, and
game database. Tauri 2 shell, Rust backend (`src-tauri/`), React 19 + TypeScript
frontend (`src/`). Package manager is **pnpm**. Node 20+, latest stable Rust.

## Commands

| Task                                | Command                                                          |
| ----------------------------------- | ---------------------------------------------------------------- |
| Run app (frontend + Tauri)          | `pnpm tauri dev` (or `pnpm dev:desktop`)                         |
| Run frontend only (Vite, port 1420) | `pnpm dev`                                                       |
| Typecheck + lint                    | `pnpm lint` (`tsc --noEmit && oxlint`)                           |
| Autofix lint                        | `pnpm lint:fix`                                                  |
| Format                              | `pnpm format` (oxfmt)                                            |
| CI gate                             | `pnpm lint:ci` (tsc + oxfmt --check + oxlint)                    |
| Frontend tests (all)                | `pnpm test` (vitest run)                                         |
| Single test file                    | `pnpm vitest run src/utils/tests/score.test.ts`                  |
| Watch one test                      | `pnpm vitest src/utils/tests/score.test.ts`                      |
| Rust tests                          | `cargo test` in `src-tauri/`                                     |
| Build (no bundle)                   | `pnpm build` → `src-tauri/target/release/`                       |
| Extract i18n keys                   | `pnpm i18n:extract` (run after adding/changing translation keys) |

Tooling note: linting/formatting is the **oxc** toolchain (`oxlint`, `oxfmt`),
config in `.oxlintrc.json` — not ESLint/Prettier/Biome. TypeScript is v7 (native
compiler). The React Compiler (Babel plugin) is enabled in `vite.config.ts`.

## Frontend↔backend bridge

- Rust exposes `#[tauri::command]` functions; **tauri-specta** generates
  `src/bindings/generated.ts` automatically on every **debug** `tauri dev` run
  (see `src-tauri/src/main.rs`). Never edit `generated.ts` by hand — change the
  Rust command and rerun `tauri dev`.
- Call commands via `import { commands } from "@/bindings"` (returns `Result`
  objects; `@/utils/unwrap` unwraps them). `src/bindings/index.ts` layers a few
  hand-written type refinements over the generated file.
- Backend→frontend push uses typed events (`collect_events!` in `main.rs`):
  `BestMovesPayload`, `ProgressEvent`, `GameMoveEvent`, `ClockUpdateEvent`,
  `GameOverEvent`, plus raw `convert_progress`.
- All commands are registered in one `collect_commands!` block in `main.rs`;
  shared backend state lives in `AppState` there (SQLite connection pool, search
  index mmap cache, running engine processes, game manager, OAuth state).

## Frontend architecture

- **Routing**: TanStack Router, file-based in `src/routes/` with generated
  `src/routeTree.gen.ts` (do not edit). Pages: home/`index`, `accounts`,
  `databases`, `engines`, `files`, `settings`.
- **Everything is a tab.** `BoardsPage.tsx` renders the tab strip; each tab has a
  `type` (`new` | `play` | `analysis` | `puzzles`) and its layout is a
  `react-mosaic` 3-pane grid (`left`, `topRight`, `bottomRight`).
- **Two state systems, on purpose:**
  - **Jotai** (`src/state/atoms.ts`) — global/app state: tabs, settings, engine
    list, database selection, accounts. Persisted atoms use `atomWithStorage`
    with Zod-validated storage wrappers (`src/state/utils.ts`); tab/session data
    goes to `sessionStorage`, durable settings to `localStorage`.
  - **Zustand** (`src/state/store/tree.ts`) — the per-tab game/move tree
    (`TreeState`), provided through `TreeStateContext` (one store instance per
    board tab). All move navigation, variations, annotations, PGN in/out live
    here. `src/utils/treeReducer.ts` defines the tree node types.
- **UI kit**: Mantine 8 (`@mantine/core`, `mantine-datatable`,
  `mantine-contextmenu`), Tabler icons. Board rendering via Lichess
  **chessground** (`src/chessground/`); chess rules/logic via **chessops**
  (helpers in `src/utils/chessops.ts`).
- **i18n**: `react-i18next`, catalogs in `src/translation/*.json`
  (`en-US.json` is the source of truth). Use the `t()` function; keys are
  extracted by `i18next-cli`.
- External APIs: `src/utils/lichess/`, `src/utils/chess.com/`,
  `src/utils/chessdb/` (cloud eval).

## Rust backend layout (`src-tauri/src/`)

- `chess.rs`, `engine/` — UCI engine process management, multi-PV analysis,
  full-game analysis.
- `db/` — SQLite game database (Diesel + r2d2 pool). `search.rs` /
  `search_index.rs` / `encoding.rs` — position search over an mmap'd binary
  index; `schema.rs` is the Diesel schema.
- `pgn.rs`, `lexer.rs`, `game.rs` — PGN parsing/indexing and live-game state.
- `opening.rs` — lookups against the compiled zstd binary opening book.
- `puzzle.rs`, `oauth.rs` (Lichess/Chess.com auth), `fs.rs`, `sound.rs`,
  `progress.rs`.
- Rust unit tests are `#[cfg(test)]` modules colocated in `db/*`, `chess.rs`,
  `opening.rs`.

## Tests

Frontend tests are colocated in `src/**/tests/*.test.ts` (vitest, jsdom env).
Heavier logic (tree hashing, PGN import, score conversion, engine variants,
collections) has dedicated coverage there — mirror that when touching those
areas.

## Design docs

Feature specs and implementation plans live in `docs/superpowers/specs/` and
`docs/superpowers/plans/` — check there for context on recent/in-progress
features before large changes.

## Before opening a PR

Run `pnpm format` then `pnpm lint:fix`; run `pnpm i18n:extract` if you touched
translation keys; base branch is `master`.
