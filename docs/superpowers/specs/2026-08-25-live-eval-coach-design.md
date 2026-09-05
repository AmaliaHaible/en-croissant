# Live Evaluation & Coach — Design

## Summary

Add an optional, toggleable live evaluation bar and chess.com-style coaching
to live play (`BoardGame.tsx`): move-quality feedback (Brilliant/Good/
Inaccuracy/Mistake/Blunder, etc.) for either side's moves, and a two-stage
hint (piece, then move). Applies to any live game — vs the built-in engine
or local human-vs-human — since play happens locally either way.

## Scope

In scope:

- Live eval bar during play, reusing the existing `EvalBar` component.
- Incremental move classification during play, reusing the existing
  `getAnnotation`/`ANNOTATION_INFO`/`AnnotationHint` system already used by
  the offline "Generate report" feature.
- A two-stage, unlimited, untracked hint button (piece → move).
- Toggle controls placed in `BoardGame`'s toolbar.

Out of scope (v1):

- Online/remote human-vs-human play (not supported by the app today).
- Configurable engine strength/depth for live coaching (fixed short
  movetime; separate from the analysis panel's configurable go-mode).
- Hint usage tracking/limits.
- Retroactive re-annotation of moves played before a feedback toggle was
  turned on (the existing full "Generate report" flow already covers
  reviewing a whole game after the fact).

## Background: what already exists

- `EvalBar.tsx` is a generic, presentational component living inside the
  shared `Board.tsx` (used by both `BoardGame` and `BoardAnalysis`). It
  only needs `TreeNode.score` populated — nothing analysis-specific.
- `EvalListener.tsx` is the component that currently drives engine calls
  and populates `TreeNode.score`, but it is mounted only in
  `BoardAnalysis.tsx`. It carries multi-engine and "threat mode"
  complexity that doesn't apply to play.
- `get_best_moves` (Rust, `src-tauri/src/chess.rs`) is the underlying
  engine-agnostic command: given a FEN/move list, engine id, and
  `GoMode`, it starts/reuses a persistent engine process keyed by
  `(tab, engineId)` and streams results via the `best-moves-payload`
  Tauri event. This is reusable as-is for play mode; no backend changes
  are needed.
- `getAnnotation()` (`src/utils/score.ts`) already implements the full
  win-chance-based move classification (Brilliant/Good/Interesting/
  Dubious/Mistake/Blunder) and is currently invoked only by the batch
  `analyze_game` → `addAnalysis()` path used by the post-game report.
- `AnnotationHint.tsx` renders classification icons on the board from
  `TreeNode.annotation` and is already part of the shared `Board.tsx` —
  so once a play-mode tree node has an annotation set, it renders for
  free.
- `Puzzles.tsx` already implements a progressive hint reveal (circle →
  arrow) via `store.getState().setShapes(...)`, against a pre-known
  puzzle solution rather than a live engine query. The same
  shape-drawing mechanism is reusable for the new hint feature.
- `BoardGame.tsx` (play mode) does not currently mount any engine
  listener; `BoardAnalysis.tsx` (analysis mode) does. The two modes
  share `Board.tsx` but are otherwise separate components under
  `BoardsPage.tsx`'s `TabSwitch`.

## Approach

Build a new, dedicated hook mounted only in `BoardGame.tsx`, rather than
reusing or refactoring `EvalListener.tsx`. `EvalListener` carries
multi-engine/threat-mode complexity irrelevant to play, and refactoring it
into a shared abstraction is a larger, riskier change than this feature
needs. The new hook reuses existing low-level primitives (`getBestMoves`,
the `bestMovesPayload` event, `getAnnotation`, `EvalBar`,
`AnnotationHint`, and the Puzzle arrow-drawing pattern) without touching
analysis-mode code at all — fully additive.

## Architecture & data flow

### Engine session

- Reuses whichever engine is configured as the default analysis engine.
- Runs with a short, fixed movetime (e.g. 300ms) rather than the deeper,
  user-configurable go-mode used by the analysis panel — not exposed as a
  setting in v1.
- Runs under its own distinct engine-process key (e.g.
  `"{tabId}:live-coach"`) so it can never collide with an opponent
  engine's process key (`"{tabId}:{engineId}"`) in engine-vs-human games,
  and can't be affected by that engine being killed/restarted or vice
  versa.

### `src/hooks/useLiveCoach.ts` (new)

Mounted inside `BoardGame.tsx`. Active whenever the live-eval toggle or
either color's feedback toggle is on. On every position change:

1. Calls `getBestMoves` for the current position (drives both the eval
   bar and, if requested, the hint).
2. After a move is played, checks whether a score already exists for the
   position _before_ that move (it will, from the previous run of step 1,
   unless coaching was just turned on mid-game) — if missing, fires one
   quick catch-up eval for that position only.
3. Once both before/after scores exist, calls `getAnnotation()` (same
   function the batch report uses) and writes the resulting annotation
   onto that move's tree node, exactly as `addAnalysis()` does today for
   a whole game, but one move at a time. `AnnotationHint.tsx` then
   renders it automatically since it reads from the tree node.

### `src/hooks/useHint.ts` (new)

On-demand, independent of the live-coach loop's toggles.

- Click 1: gets the current position's best move (reusing an in-flight
  live-coach result if available, or firing a one-off query otherwise)
  and draws a circle on the source square via `setShapes`.
- Click 2: replaces the circle with a full from→to arrow.
- Any move played, or navigating away from the position, clears the
  shapes and resets the button to its initial state.
- No usage limit, no logging/marking of hint-assisted moves.

## Edge cases

- **No default analysis engine configured**: toggles and the hint button
  render disabled with an explanatory tooltip.
- **Toggling a feedback color on mid-game**: only affects moves played
  from that point forward; earlier moves are not retroactively
  annotated. Full-game retroactive review is already covered by the
  existing "Analyze"/"Generate report" flow.
- **Playing vs an engine opponent**: the live-coach engine process is
  fully separate from the opponent's; killing/restarting one cannot
  affect the other.
- **Fast/blitz games**: the fixed short movetime means shallow analysis;
  occasional misclassification (e.g. a real blunder read as a mistake)
  is expected and acceptable for v1 — this is a coaching aid, not a
  strength-matched adjudicator.
- **Hint requested when it isn't the local viewer's turn to want one**:
  in an engine game, the hint button is disabled on the engine's turn;
  in local human-vs-human play it's always enabled, since either side may
  want a hint on their own turn.

## UI

Placed in `BoardGame.tsx`'s toolbar, alongside the existing
Resign/Abort/Analyze controls:

- An eval-bar toggle icon — shows/hides `EvalBar` on the shared `Board`,
  identically to how it already behaves in analysis mode.
- Two small per-color toggle icons — "Feedback: White" / "Feedback:
  Black" — each independently enables/disables move-classification icons
  for that color's moves. Chosen over "mine/opponent" phrasing because it
  is unambiguous in both engine games and local human-vs-human games.
- A "Hint" button, two-stage as described above, disabled when it isn't a
  turn a hint makes sense for (see edge cases).

## State & persistence

All three toggles are booleans backed by `atomWithStorage`, following the
existing `SettingsSwitch` idiom used throughout the app's settings. They
persist as a user preference across app restarts and apply to any new
play-mode tab — they are not scored per-game and require no new
settings-page entries in v1.

## Internationalization

New `react-i18next` keys under the existing translation namespaces for
the three toggle labels/tooltips and the hint button's two states,
following the current per-locale JSON convention. English is required;
other locales may lag as with any new feature.

## Testing

- **Unit**: exercise `useLiveCoach`'s classification path directly
  against `getAnnotation` with canned before/after scores — this is
  already a pure, testable function.
- **Manual/integration**:
  - Local human-vs-human game with both feedback toggles on — icons
    appear on the board after each move for both colors.
  - Game vs the built-in engine with only the human's color's feedback
    on — the engine's moves get no icon.
  - Hint button mid-game — confirm the two-stage reveal and reset on the
    next move.
  - Toggle live eval on/off mid-game — confirm the eval bar
    attaches/detaches without disrupting the game clock or move flow.
- No backend Rust changes, so no new backend tests are needed.
