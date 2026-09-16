# Training mode — design

## Summary

Add a **Training** mode: a new top-level board tab, launched from the new-tab
home, where the user rehearses a self-chosen start position against a
probability-based opponent while an engine polices the quality of the user's
moves. The user does **not** have to find the best move — only a move that is
"good enough" by a configurable eval-loss threshold. A move that fails the
threshold is silently undone. A two-stage hint highlights the pieces that have a
good-enough move, then draws ranked arrows.

The opponent plays Lichess opening-explorer moves weighted by frequency. When the
position leaves the explorer data, the user is offered **New Game** or **Play on
vs {engine}** against a separately-configured (typically weaker) engine.

This is an ephemeral mode: nothing it produces is persisted, no PGN is saved, no
FSRS/logs. Only the engine choices and thresholds are remembered (as defaults for
the next session).

## Goals

- Let the user drill a specific opening/position under game-like conditions
  without a prepared repertoire tree.
- Bias the opponent toward lines the user will actually face (Lichess frequency
  weighting).
- Give a low-pressure correction loop: a move that throws away too much eval is
  undone, with no answer revealed — only a hint on demand.
- Judge "good enough" by how much eval the move _loses_, not by matching the top
  engine move, using a rule that behaves sensibly for near-equal openings
  (evals hovering around 0.00 / -0.05).
- Allow the drill to continue past the opening book against a weak engine when
  the user wants a full game.

## Non-goals

- No persistence: no saved PGN, no FSRS cards, no logs, no cross-session session
  stats. Session stats reset when the tab unmounts or the user hits Stop.
- No clocks / time control.
- No new backend (Rust) code. `get_best_moves` and the Lichess explorer cache
  (`get_explorer_moves` / `searchExplorerMoves`) already provide everything.
- The opponent is not eval-checked — it is pure probability (or, out of book,
  the chosen opponent engine's own play).
- No "review the game" step — just New Game. The board is left on the final
  position with the notation un-blurred.

## Background — what already exists

- **Tabs.** `src/utils/tabs.ts` `tabSchema` has
  `type: z.enum(["new", "play", "analysis", "puzzles"])`. `BoardsPage.tsx`
  `TabSwitch` renders one component per type into three hardcoded
  `react-mosaic` Portal hosts (`#left`, `#topRight`, `#bottomRight`); only one
  board tab mounts its UI at a time (repo memory: _board-tab-portal-ids_).
  `BoardTab.tsx` `TabIcon` maps type → icon. `NewTabHome.tsx` renders the
  launch cards; the Puzzle card currently sets `tab.type = "puzzles"`.
- **Repertoire Play** (`src/components/panels/practice/PracticePlay.tsx` +
  `src/utils/repertoirePlay.ts`) is the closest existing feature: a phase
  machine (`idle | opponentThinking | waiting | lineComplete | gap`), a
  frequency-weighted opponent (`pickOpponentMove`), silent undo of wrong moves,
  a two-stage hint riding the non-persisted `autoShapes` array, notation blur
  via `currentInvisibleAtom`, and `searchExplorerMoves(source, [fen], token)`
  for Lichess stats. It lives _inside_ `BoardAnalysis` because a repertoire is
  an analysis tab; Training is a standalone tab instead.
- **Engine eval hooks.** `src/hooks/useLiveCoachEngine.ts` is the template: a
  continuous `commands.getBestMoves(id, path, tab, goMode, { fen, moves,
extraOptions })` loop driven by `useThrottledEffect`, a `bestMovesPayload`
  event listener, a synchronous short-circuit consumption of the command's
  return value (`[progress, bestLines]`), `setScore` onto the tree node, and
  full process teardown (`killEngine`) on unmount. `withMultiPvFloor`
  (`src/utils/coach.ts`) merges a MultiPV floor into the configured options.
  `getDefaultVariant` / `LocalEngine` live in `src/utils/engines.ts`.
  Backend scores are always normalised to White's POV before reaching the
  frontend (`invert_score` in `chess.rs`); `useEvalPreview.ts` shows the
  `negateScore` helper for flipping to the mover's POV.
- **Opponent engine plumbing.** `BoardGame.tsx` configures an engine opponent
  through `OpponentForm` / `OpponentSettings` and the Rust live-game engine
  (`startGame` / `makeGameMove`). Training does **not** use that path — see
  Approach.
- **Tree store** (`src/state/store/tree.ts`, one Zustand instance per board tab
  via `TreeStateContext`): `goToMove(path)`, `appendMove({ payload })`,
  `makeMove(...)`, `deleteMove(path?)`, `setScore(score)`, `setFen(fen)`,
  `reset()`, `setShapes` / `setNodeShapes`, `currentNode()`, `position`,
  `root`, `headers`. `setPracticePath` pins forward/back navigation to a line.
  `findFen(fen, root)` (`treeReducer.ts`) finds an exact-FEN node.
- **Board.** `src/components/boards/Board.tsx` is shared by all board
  components. `makeMove` already has `if (practicing)` / `if (playing)`
  branches that intercept the user's move; `movableColor` returns `undefined`
  under a `*Lock`. It builds a local non-persisted `shapes: DrawShape[]` each
  render for `drawable.autoShapes`. Chessground `DrawShape` supports
  `{ orig, dest, brush, modifiers: { lineWidth } }`.
- **i18n.** `src/translation/en-US.json` is source of truth; `pnpm i18n:extract`
  rewrites every catalog, so single keys are added by hand (repo memory:
  _i18n-extract-rewrites-all-catalogs_).
- **Lichess token.** Explorer calls need a Lichess OAuth token
  (`sessions.find(s => s.lichess?.accessToken)`), otherwise the same auth alert
  repertoire Play/Build show (repo memory: _rust-http-client-no-user-agent_).

## Approach

### Tab structure — dedicated component

New `training` tab type with a dedicated `BoardTraining.tsx` that owns the three
Portals (mirrors `BoardGame` / `Puzzles`).

_Rejected:_ a panel inside `BoardAnalysis` (how repertoire Play works). Training
is launched fresh from the new-tab home and is not tied to a file, so there is no
analysis tab to attach to.

### Opponent — frontend-driven, ephemeral

The panel drives all opponent moves and appends them to the tree itself:

- **In book:** sample a move from `searchExplorerMoves(source, [fen], token)`,
  weighted by total game count.
- **Out of book** (total games `< minBookGames`, or zero moves returned): stop
  and offer New Game or, if an opponent engine is configured, **Play on vs
  {engine}** — from then on opponent moves come from `commands.getBestMoves`
  against that engine, choosing among its near-top moves.

_Rejected:_ the Rust live-game engine (`startGame` / `makeGameMove`). It owns its
own game state, tree and clocks; splicing it in only for the post-book phase is a
messy handoff, and Training needs neither clocks nor a saved game.

### Move-quality gate — navigate-and-evaluate

A continuous eval-engine hook (`useTrainingEngine`, modeled on
`useLiveCoachEngine`) evaluates whichever node the board currently sits on and
`setScore`s it. The orchestrator never computes a resulting FEN by hand or fires
a bespoke one-shot query:

- In `waiting` at node **P**, once `P.score` arrives it is captured as
  `priorScore` (converted to the user's POV).
- On the user's move, the child node **C** is appended and the board navigates
  to it; the phase becomes `checking`. When `C.score` arrives,
  `afterScore = negate(C.score)` (user POV). Threshold test decides
  keep/undo.

_Rejected:_ a one-shot `getBestMoves` on a locally-derived FEN without
navigating — duplicates the hook's listener/short-circuit/teardown plumbing for
no benefit.

## Design

### 1. New-tab home — `src/components/tabs/NewTabHome.tsx`

The `IconPuzzle` card becomes **Training**:

- `title` / `description` / primary label from new `Home.Card.Training.*` keys.
- Primary button **Train** → sets the current tab's `type = "training"` and
  `name = t("Home.TrainingMode")` (new key), same `setTabs` shape as the other
  cards.
- Secondary button **Puzzles** (`secondaryLabel` / `onSecondaryClick`, exactly
  the two-button pattern the Import card uses) → runs the _current_ Puzzle
  onClick verbatim: `tab.name = t("Home.PuzzleTraining"); tab.type = "puzzles"`.
- Keep `icon: <IconPuzzle size={60} />` (Training is puzzle-adjacent; no new
  icon needed here — but the tab icon is `IconTargetArrow`, see §2).

No change to the 5-column grid; the card count stays the same.

### 2. Tab wiring

- **`src/utils/tabs.ts`**: `type: z.enum(["new", "play", "analysis", "puzzles",
"training"])`.
- **`src/components/tabs/BoardsPage.tsx`** `TabSwitch`: add
  `.with("training", () => <BoardTraining id={tab.value} />)` alongside the
  existing `.with("puzzles", …)`, inside the same mounted-board Portal host
  wrapper. Import `BoardTraining` next to `Puzzles`.
- **`src/components/tabs/BoardTab.tsx`** `TabIcon`: `if (tabType === "training")
return <IconTargetArrow size="0.875rem" />;` (import from `@tabler/icons-react`).
- No `gameOrigin` involvement — Training tabs are always `{ kind: "none" }`.

### 3. State — `src/state/atoms.ts`

Tab-scoped families following `playStateFamily` (plain `atom`, **not**
persisted), plus persisted config atoms.

```ts
export type TrainingPhase =
  "setup" | "waiting" | "checking" | "opponentThinking" | "outOfBook" | "gameOver";

export type TrainingState = {
  phase: TrainingPhase;
  // Position the machine expects during waiting/checking/opponentThinking.
  // Wandering the move list neither starts a phantom opponent turn nor lets a
  // move from another line count (same guard idea as PlayState.fen).
  fen?: string;
  path?: number[];
  // Best eval of the position the user is about to move from, user POV, cp
  // (mate clamped). Set when the eval lands in `waiting`; read in `checking`.
  priorScore?: number;
  // The user has chosen to continue out-of-book against the opponent engine.
  engineOpponentActive: boolean;
  // Terminal result string for the gameOver panel.
  result?: string;
};
const trainingStateFamily = atomFamily((_tab: string) =>
  atom<TrainingState>({ phase: "setup", engineOpponentActive: false }),
);
export const trainingStateAtom = tabValue(trainingStateFamily);

export type TrainingHint = { stage: 0 | 1 | 2 };
const trainingHintFamily = atomFamily((_tab: string) => atom<TrainingHint>({ stage: 0 }));
export const trainingHintAtom = tabValue(trainingHintFamily);

export type TrainingSessionStats = { movesPlayed: number; mistakes: number };
const trainingSessionStatsFamily = atomFamily((_tab: string) =>
  atom<TrainingSessionStats>({ movesPlayed: 0, mistakes: 0 }),
);
export const trainingSessionStatsAtom = tabValue(trainingSessionStatsFamily);

// The user's chosen orientation for the session (which side they play).
const trainingColorFamily = atomFamily((_tab: string) => atom<"white" | "black">("white"));
export const trainingColorAtom = tabValue(trainingColorFamily);

// --- persisted config (atomWithStorage, remembered as next-session defaults) ---
export type TrainingEngineConfig = { engineId: string | null; variantId: string | null };
export const trainingEvalEngineConfigAtom = atomWithStorage<TrainingEngineConfig>(
  "training-eval-engine",
  { engineId: null, variantId: null },
);
export const trainingEvalMovetimeAtom = atomWithStorage<number>("training-eval-movetime-ms", 500);
export const trainingOpponentEngineConfigAtom = atomWithStorage<TrainingEngineConfig>(
  "training-opponent-engine",
  { engineId: null, variantId: null },
);
export const trainingOpponentSkillAtom = atomWithStorage<number | null>(
  "training-opponent-skill",
  null,
); // Stockfish "Skill Level" 0-20, null = full
export const trainingMaxLossPawnsAtom = atomWithStorage<number>("training-max-loss-pawns", 0.05);
export const trainingMaxLossPctAtom = atomWithStorage<number>("training-max-loss-pct", 40);
export const trainingBookSourceAtom = atomWithStorage<"lichess" | "masters">(
  "training-book-source",
  "lichess",
);
export const trainingMinBookGamesAtom = atomWithStorage<number>("training-min-book-games", 10);
```

`atomFamily` / `atomWithStorage` / `tabValue` are already used throughout
`atoms.ts`; follow the surrounding style (Zod storage wrappers for the persisted
ones, matching `repertoirePlaySourceAtom` etc.).

### 4. Pure module — `src/utils/training.ts`

No React, no Tauri. Colocated tests.

```ts
import type { BestMoves, Score } from "@/bindings";

/** Centipawns, user POV. Mate scores clamped to ±MATE_CP so a huge swing
 *  between two winning positions can't dominate the arithmetic. */
export const MATE_CP = 2000;
export function scoreToCp(score: Score, userIsWhite: boolean): number;

export type ThresholdConfig = { maxLossPawns: number; maxLossPct: number };

/** allowedDrop = max(maxLossPawns*100, (maxLossPct/100) * max(priorCp, 0)) */
export function allowedDrop(priorCp: number, cfg: ThresholdConfig): number;

/** true ⇔ the move is good enough (NOT undone):
 *  (priorCp - afterCp) <= allowedDrop(priorCp, cfg)  */
export function passesThreshold(priorCp: number, afterCp: number, cfg: ThresholdConfig): boolean;

export type ExplorerMoveStat = { move: string; white: number; draw: number; black: number };

/** Weighted sample (by white+draw+black) over `stats`, excluding "*".
 *  `rng` in [0,1), injected for tests. Returns the chosen SAN, or null when
 *  `stats` is empty. Caller decides the out-of-book cutoff via totalGames(). */
export function sampleBookMove(stats: ExplorerMoveStat[], rng?: () => number): string | null;

export function totalBookGames(stats: ExplorerMoveStat[]): number;

export type HintMove = {
  uci: string;
  from: string; // origin square (chessops makeSquare)
  to: string;
  cp: number; // afterScore, user POV
  rank: number; // 1-based, by cp descending
  brush: "green" | "blue" | "yellow";
  lineWidth: number; // chessground modifiers.lineWidth, thicker = better
};

/** From the eval engine's MultiPV lines for the position the user is on
 *  (`priorCp` = best line's cp, user POV), return every line whose resulting
 *  position passes the threshold, ranked and styled. `userIsWhite` selects the
 *  POV conversion. Lines without a first move are dropped. */
export function goodEnoughHints(
  lines: BestMoves[],
  priorCp: number,
  userIsWhite: boolean,
  cfg: ThresholdConfig,
): HintMove[];
```

Rank → style (fixed): rank 1 `green` / lineWidth 12; rank 2 `green` / 8; rank 3
`blue` / 6; rank ≥ 4 `yellow` / 4. (Tunable constants; no API change to adjust.)

`BestMoves` shape (from `useLiveCoachEngine` usage): `.score: Score`,
`.uciMoves: string[]`, `.sanMoves: string[]`. First move = `uciMoves[0]`.

### 5. Eval engine hook — `src/hooks/useTrainingEngine.ts`

A near-copy of `useLiveCoachEngine`'s lifecycle plumbing (the design doc for the
coach explicitly notes that shape survived a full review for real
concurrency/lifecycle bugs — duplicate it rather than abstract under time
pressure). Differences:

- Config from `trainingEvalEngineConfigAtom` / `trainingEvalMovetimeAtom`;
  `goMode = { t: "Time", c: movetimeMs }`.
- `extraOptions = withMultiPvFloor(variant?.settings ?? [], 6)` — need ≥ 6 lines
  for the hint. (If `withMultiPvFloor` takes no floor arg, add an optional one
  defaulting to its current value; otherwise wrap.)
- **Active only** when `trainingStateAtom.phase` is `waiting`, `checking`, or
  `opponentThinking` (never in `setup` / `outOfBook` / `gameOver`).
- On each result for the current `finalFen`: `setScore(bestLines[0].score)` and
  keep the raw `bestLines` in a ref exposed as `lines` (latest MultiPV for the
  current position, for the hint and the threshold read).
- No annotation/classification logic (drop the `classifyMove` half entirely).
- Full `killEngine` teardown on unmount, under its own engine-id suffix
  `"-training-eval"`.

Returns `{ engine: LocalEngine | null, lines: BestMoves[], resultFen: string }`
(`resultFen` = the fen `lines` belong to, so the orchestrator can tell a stale
list from a fresh one).

Opponent-engine moves (out of book) are fetched inline in `BoardTraining` with a
one-shot `commands.getBestMoves` under a `"-training-opponent"` suffix +
`{ name: "Skill Level", value: String(skill) }` (or `UCI_LimitStrength` /
`UCI_Elo`) merged into `extraOptions`, `goMode = { t: "Time", c: 300 }`,
`MultiPV` 3 so a near-top move can be chosen with light randomisation. Killed on
unmount and whenever `engineOpponentActive` goes false.

### 6. Orchestration — `src/components/boards/BoardTraining.tsx`

Portal layout mirrors `BoardGame`. Reads the tree store via `TreeStateContext`,
the training atoms, `sessionsAtom` (Lichess token), `enginesAtom`.

`useTrainingEngine()` is mounted here. `useHotkeys("h", cycleHint, { enabled:
phase === "waiting" })`.

Derived: `userColor = trainingColorAtom`, `userIsWhite = userColor === "white"`,
`userParity = userIsWhite ? 0 : 1`.

#### `#left` — `<Board>`

- `phase === "setup"`: `<Board editingMode viewOnly={false} movable="turn"
onMove={handleSetupMove} disableVariations />` — the user plays moves from the
  start position; each `onMove` `appendMove`s so `root` walks forward. A "reset
  to start" control clears back to the setup FEN.
- otherwise: `<Board training movable={userColor} viewOnly={false}
disableVariations boardRef=… />`. `training` is a new boolean prop (see §7).

#### `#topRight` — panel

**Setup panel** (`phase === "setup"`):

- **Start position** `Paper`:
  - `TextInput` + **Load** button → validate with `parseFen`, `setFen(fen)`,
    reset the tree, set `trainingColorAtom` from the FEN's side to move.
  - Hint text: "Play moves on the board, or paste a FEN. Training starts from
    the position shown, with you to move as the side to move."
  - A **swap sides** `ActionIcon` toggling `trainingColorAtom` (independent of
    whose turn it is — if it is the opponent's turn at the start position the
    opponent moves first).
- **Evaluation engine** `Paper`: `Select` over
  `enginesAtom.filter(e => e.type === "local" && e.loaded)` bound to
  `trainingEvalEngineConfigAtom.engineId`; optional variant `Select`; movetime
  `NumberInput` (ms, min 100, step 100) bound to `trainingEvalMovetimeAtom`.
  If no loaded local engine: an `Alert` with a link to `/engines` and **Start**
  disabled.
- **Opponent (out of book)** `Paper`: `Select` (same engine list) +
  "Strength (Skill Level 0–20, blank = full)" `NumberInput` bound to
  `trainingOpponentSkillAtom`. Optional — blank engine ⇒ out-of-book only offers
  New Game.
- **Opening book** `Paper`: Lichess/Masters `SegmentedControl`
  (`trainingBookSourceAtom`); "Leave book below N games" `NumberInput`
  (`trainingMinBookGamesAtom`). If no Lichess token: the
  `Board.Database.ExplorerAuthRequired*` alert + **Start** disabled.
- **Thresholds** `Paper`: "Max eval loss (pawns)" `NumberInput` step 0.01
  (`trainingMaxLossPawnsAtom`); "Max eval loss (%)" `NumberInput` step 5
  (`trainingMaxLossPctAtom`). One dim line restating the rule: _"A move is
  undone if it loses more than 0.05 pawns AND more than 40% of your current
  edge — whichever limit is larger."_
- **Start** `Button` → `startSession()`.

**Play panels** (mirror `PracticePlay`'s `Stack p="sm" gap="md"`):

- Session stats: two-cell `SimpleGrid` — Moves played, Mistakes.
- `waiting`: `Paper` — "Your move", **Hint** button (label
  `stage === 1 ? "Show arrows" : "Hint"`), **Stop** (`variant="subtle"
color="red"`). While the eval for the current position hasn't landed yet, a
  small `Loader` + "Evaluating…" and the Hint button disabled.
- `checking`: `Paper` — `Loader` + "Checking your move…".
- `opponentThinking`: `Paper` — `Loader` + "Opponent is thinking…" + Stop.
- `outOfBook`: `Paper` — "Out of book." + **Play on vs {engineName}** button
  (disabled / hidden if no opponent engine) + **New Game** + Stop.
- `gameOver`: `Paper` — result text + **New Game** + Stop.
- A `Badge` showing which color the user is playing.

#### `#bottomRight`

`GameNotation` + `MoveControls` (read-only during non-`setup` phases), same as
Puzzles. Notation is blurred via `currentInvisibleAtom` whenever phase is
`waiting` / `checking` / `opponentThinking`, cleared otherwise (so the user can
scroll the finished game in `gameOver`).

#### Flow functions

- **`startSession()`**:
  - Capture the current `root.fen` as `startFen`; `goToMove([])`.
  - `setInvisible(true)`, `setHint({ stage: 0 })`, stats `{ movesPlayed: 0,
mistakes: 0 }`.
  - Whose turn at `startFen`? If it's the user's → `phase: "waiting"`, else
    `phase: "opponentThinking"`. `engineOpponentActive: false`.
  - `trainingStateAtom.fen = root.fen`, `path = []`.

- **`waiting` — capture prior score** (effect keyed on `phase === "waiting"`,
  `resultFen`, `lines`):
  - When `resultFen === currentNode.fen` and `lines.length > 0` and
    `trainingState.priorScore === undefined`: set
    `priorScore = scoreToCp(lines[0].score, userIsWhite)`.
  - The board is unlocked for `userColor` (via `training` prop + lock, §7).

- **User move** — intercepted in `Board.tsx` (§7): the move is appended, board
  navigates to child **C**, panel effect sees `phase === "waiting"` &&
  `currentNode` advanced past `trainingState.path` on the user's parity →
  `setHint({ stage: 0 })`, `phase: "checking"`, remember `checkParent =
trainingState.path`, `checkChildFen = C.fen`.

- **`checking`** (effect keyed on `phase === "checking"`, `resultFen`, `lines`):
  - Wait until `resultFen === checkChildFen` && `lines.length > 0` (the eval
    hook is now evaluating C).
  - `afterCp = -scoreToCp(lines[0].score, userIsWhite)` — `lines[0].score` is
    from the side-to-move-at-C POV already normalised to White; `scoreToCp`
    gives White/…; negation flips to the _user's_ POV since it's the opponent
    to move at C. (Implement precisely: `scoreToCp` takes `userIsWhite`; at C
    the mover is the opponent, so pass `!userIsWhite` and do not negate —
    settle the exact form in code with a unit test using a known Score.)
  - `passesThreshold(priorScore, afterCp, cfg)`:
    - **false** → `deleteMove(childPath)`, `goToMove(checkParent)`,
      `stats.mistakes++`, `trainingState` back to `{ phase: "waiting", fen:
parentFen, path: checkParent, priorScore }` (keep the already-known prior
      score — the position is unchanged). No notification, no answer.
    - **true** → `stats.movesPlayed++`; if `getNodeAtPath(root,
childPath)` is terminal (`positionFromFen(fen)` → `pos.isEnd()`) →
      `phase: "gameOver"`, `result` from the position; else `phase:
"opponentThinking"`, `fen: C.fen`, `path: childPath`,
      `priorScore: undefined`.

- **`opponentThinking`** (effect keyed on `phase`, `currentNode.fen`; race-guard
  by capturing `fenAtStart` and bailing if `currentFenRef.current` changed —
  same pattern as `PracticePlay`):
  - Terminal position → `phase: "gameOver"`.
  - `engineOpponentActive === false`:
    - `stats = await searchExplorerMoves(source, [fenAtStart], token)
.then(r => r[0] ?? []).catch(() => [])`.
    - `total = totalBookGames(stats)`. If `stats` empty or `total < minBookGames`
      → `phase: "outOfBook"`, return.
    - `san = sampleBookMove(stats)`; parse to a move from `fenAtStart`
      (`parseSan` via `positionFromFen`); `await OPPONENT_DELAY_MS` (~400);
      re-check the race guard; `appendMove({ payload: move })`.
  - `engineOpponentActive === true`:
    - one-shot `commands.getBestMoves("-training-opponent" id, path, tab,
{ t: "Time", c: 300 }, { fen: rootFen, moves, extraOptions:
withSkill(...) })`; from the returned `bestLines` pick index
      `min(bestLines.length - 1, weightedRandom([0,1,2]))` (favour the top),
      `appendMove` its first move. Fallback to a random legal move if the
      engine returns nothing.
  - After appending → `phase: "waiting"`, `fen: newNode.fen`,
    `path: newPath`, `priorScore: undefined`.

- **`outOfBook`**:
  - **Play on vs {engine}** → `engineOpponentActive: true`, `phase:
"opponentThinking"` (re-enters the effect, now on the engine branch).
  - **New Game** → `startSession()` from `startFen` (re-sample from scratch;
    stats reset).

- **`gameOver`**: **New Game** → `startSession()`.

- **Stop** (any non-`setup` phase) → `phase: "setup"`, `setInvisible(false)`,
  `setHint({ stage: 0 })`, stats zeroed, `engineOpponentActive: false`. The
  tree is left as-is on the board (`goToMove(findFen(startFen, root))` to
  return to the start, keeping the played line as history the user can browse).

- **`cycleHint`**: `setHint(h => ({ stage: h.stage === 0 ? 1 : h.stage === 1 ? 2 : 1 }))`.

- **Forward/back pinning**: `setPracticePath(phase !== "setup" ? (path ?? null)
: null)` in an effect, so `→`/`←` walk the played line and stop at the live
  position (same as `PracticePlay`). Cleared on unmount.

- **Cleanup effect** (unmount): reset `trainingStateAtom` to
  `{ phase: "setup", engineOpponentActive: false }`, `trainingHintAtom` to
  `{ stage: 0 }`, `currentInvisibleAtom` false, `setPracticePath(null)`.

### 7. Board wiring — `src/components/boards/Board.tsx`

- Add `training?: boolean` to `ChessboardProps` and the destructure.
- New atom reads (only meaningful when `training`): `const [trainingState,
setTrainingState] = useAtom(trainingStateAtom)`, `const trainingHint =
useAtomValue(trainingHintAtom)`, plus `trainingColorAtom` and the eval
  hook's `lines` — **or** pass `lines` / `hintMoves` down as props from
  `BoardTraining` to avoid mounting the hook's state in `Board`. **Preferred:**
  `BoardTraining` computes `hintMoves: HintMove[]` (via `goodEnoughHints`) and
  passes it as a prop `trainingHintMoves?: HintMove[]`; `Board` only needs
  `training`, `trainingHint.stage` (atom) and that array.
- In `makeMove`, before `if (practicing)`:

  ```ts
  if (training) {
    if (trainingState.phase !== "waiting") {
      setPendingMove(null);
      return;
    }
    // Provisionally accept: append and let the panel's `checking` effect
    // evaluate it and possibly delete it back off.
    setPendingMove(null);
    // fall through to the normal append path (makeMove continues) so the
    // move lands on the tree and the board navigates to it.
  }
  ```

  i.e. don't `return` — let the existing append happen. The panel effect keys
  off the position change. (If the normal path shows a promotion dialog etc.,
  that is fine and matches play mode.)

- `trainingLock`: extend the `movableColor` memo —
  `const trainingLock = !!training && trainingState.phase !== "waiting";`
  return `undefined` when `trainingLock` (same as `practiceLock` / `playLock`).
  When unlocked, restrict to `trainingColorAtom`'s color only.
- Hint shapes: after the block concatenating `currentNode.shapes`, add:

  ```ts
  if (training && trainingHint.stage > 0 && trainingHintMoves) {
    const seen = new Set<string>();
    for (const h of trainingHintMoves) {
      if (trainingHint.stage === 1) {
        if (seen.has(h.from)) continue;
        seen.add(h.from);
        shapes.push({ orig: h.from, brush: h.brush });
      } else {
        shapes.push({
          orig: h.from,
          dest: h.to,
          brush: h.brush,
          modifiers: { lineWidth: h.lineWidth },
        });
      }
    }
  }
  ```

  Rides the non-persisted `autoShapes` array — never written to a file.

### 8. i18n — `src/translation/en-US.json` (added by hand)

`Home.Card.Training.Title` "Training", `.Desc` "Drill a position against a
probability opponent with engine feedback", `.Button` "Train";
`Home.Card.Training.PuzzlesButton` "Puzzles"; `Home.TrainingMode` "Training".

`Board.Training.*`:

```
"Setup.Title": "Training setup",
"Setup.StartPosition": "Start position",
"Setup.StartPositionHint": "Play moves on the board, or paste a FEN. Training starts from the position shown.",
"Setup.LoadFen": "Load FEN",
"Setup.SwapSides": "Swap sides",
"Setup.EvalEngine": "Evaluation engine",
"Setup.Movetime": "Time per evaluation (ms)",
"Setup.OpponentEngine": "Opponent engine (out of book)",
"Setup.OpponentSkill": "Strength (Skill Level 0–20, blank = full)",
"Setup.Book": "Opening book",
"Setup.MinBookGames": "Leave book below N games",
"Setup.MaxLossPawns": "Max eval loss (pawns)",
"Setup.MaxLossPct": "Max eval loss (%)",
"Setup.ThresholdRule": "A move is undone if it loses more than {{pawns}} pawns and more than {{pct}}% of your current edge — whichever limit is larger.",
"Setup.Start": "Start training",
"Setup.NoEngine": "Add and load a local engine first.",
"YourMove": "Your move",
"Evaluating": "Evaluating…",
"CheckingMove": "Checking your move…",
"OpponentThinking": "Opponent is thinking…",
"Hint": "Hint",
"ShowArrows": "Show arrows",
"OutOfBook": "Out of book.",
"PlayOnVsEngine": "Play on vs {{engine}}",
"NewGame": "New game",
"GameOver": "Game over",
"MovesPlayed": "Moves played",
"Mistakes": "Mistakes",
"PlayingAs": "Playing as {{color}}"
```

Reuse existing `Common.Stop`, `Board.Database.ExplorerAuthRequired*`,
`Fen.White` / `Fen.Black`.

### 9. Tests — `src/utils/tests/training.test.ts`

- **`allowedDrop` / `passesThreshold`** — table including the user's three
  cases (cp, `{ maxLossPawns: 0.05, maxLossPct: 40 }`):
  `prior 0, after -2 → pass`; `prior 8, after 4 → pass`;
  `prior 20, after 10 → fail`; plus `prior -5, after -20 → fail`
  (`allowedDrop` = 5, drop 15); `prior 300, after 50 → fail`
  (allowedDrop 120, drop 250); `prior 300, after 320 → pass` (improved).
- **`scoreToCp`** — a `cp` Score and a `mate` Score, both POVs, mate clamped to
  ±2000.
- **`sampleBookMove`** — deterministic `rng` lands in each move's weighted
  slice; `"*"` excluded; all-zero counts → still returns something (or define:
  zero-weight rows are skipped, empty result → null); `[]` → null.
  `totalBookGames` sums `white + draw + black` over non-`"*"` rows.
- **`goodEnoughHints`** — given a fixture `BestMoves[]` (varying scores) and a
  `priorCp`, returns exactly the lines within threshold, ranked by cp desc,
  with the documented brush/lineWidth per rank; lines missing `uciMoves[0]`
  dropped; POV conversion correct for `userIsWhite` false.

No Rust tests (no backend change).

## Files touched

| File                                      | Change                                                            |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `src/utils/training.ts`                   | new — threshold math, book sampling, hint ranking (pure)          |
| `src/utils/tests/training.test.ts`        | new — unit tests                                                  |
| `src/hooks/useTrainingEngine.ts`          | new — continuous eval-engine session (score + MultiPV)            |
| `src/components/boards/BoardTraining.tsx` | new — setup screen + phase machine + Portals                      |
| `src/components/boards/Board.tsx`         | `training` prop, `makeMove` branch, `trainingLock`, hint shapes   |
| `src/state/atoms.ts`                      | training state/hint/stats/color families + persisted config atoms |
| `src/utils/tabs.ts`                       | add `"training"` to the tab type enum                             |
| `src/components/tabs/BoardsPage.tsx`      | `TabSwitch` `.with("training", …)` + import                       |
| `src/components/tabs/BoardTab.tsx`        | `IconTargetArrow` for `training`                                  |
| `src/components/tabs/NewTabHome.tsx`      | Training card: primary Train button + secondary Puzzles button    |
| `src/translation/en-US.json`              | new `Board.Training.*` + `Home.Card.Training.*` keys (by hand)    |
| `src/utils/coach.ts`                      | (only if needed) make `withMultiPvFloor`'s floor a parameter      |

## Open questions / deferred

- **Exact POV/negation in `checking`** — `lines[0].score` at child node C is
  reported from White's perspective already (backend `invert_score`); whether
  the orchestrator passes `userIsWhite` or `!userIsWhite` to `scoreToCp` and
  whether it negates is pinned down in code against a unit test with a known
  Score, not guessed here.
- **Opponent-engine move variety** — starts as "pick among top 3 with a bias to
  the best". If games feel too samey or too random, tune the weights; no API
  change.
- **`OPPONENT_DELAY_MS`, hint rank→style constants, MultiPV floor (6)** — module
  constants, tuned by feel after first use.
- **Strength option name** — `Skill Level` (Stockfish) is assumed. If the chosen
  engine doesn't expose it the value is simply ignored by the engine; a future
  pass could detect `UCI_LimitStrength` / `UCI_Elo` instead.
- **Resign / claim draw** — not offered; the user hits Stop or New Game. A
  terminal board position ends the session on its own.
- **Setup from an existing game/analysis tab** — not in scope; Training tabs are
  launched empty from the new-tab home and set up in-place.
