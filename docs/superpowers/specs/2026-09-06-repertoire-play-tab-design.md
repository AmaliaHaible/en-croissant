# Repertoire "Play" tab — design

## Summary

Add a third mode to the repertoire trainer (`PracticePanel`), alongside **Train**
and **Build**: a **Play** tab where the user plays their repertoire against a
probability-based opponent. The opponent walks the user's prepared tree, choosing
which prepared branch to enter using Lichess opening-explorer move frequencies.
The user plays their own moves; a wrong move is silently undone (no result shown)
and a two-stage hint is the only feedback offered. When a line runs out, the user
gets a **New Game** button. Transpositions between lines are followed.

This is an ephemeral training mode — nothing it produces is persisted, and the
repertoire tree is never mutated. Play is pure navigation over the existing tree.

## Goals

- Let the user rehearse full repertoire lines under game-like conditions.
- Bias the opponent toward the lines the user is most likely to actually face
  (Lichess frequency weighting), so practice time is spent where it matters.
- Give a low-pressure correction loop: undo the mistake, no answer reveal, a
  hint on demand.
- Follow transpositions so a position prepared under one move order is
  recognised when reached by another.

## Non-goals

- No engine opponent, no evaluation, no "realistic" out-of-book play. The
  opponent only ever plays moves the user has prepared a reply for.
- No persistence (no FSRS, no logs, no saved stats). Session stats reset when
  the tab unmounts.
- No new backend code. The Lichess explorer cache
  (`get_explorer_moves` / `searchExplorerMoves`) already provides permanent
  on-disk caching keyed on the normalised FEN, which also makes transpositions
  share cache entries.

## Background — how the existing modes work

- `PracticePanel.tsx` renders a vertical `Tabs` strip with `train` and `build`
  panels. It is shown only when `tabFile?.metadata.type === "repertoire"`, inside
  the `practice` board tab of `BoardAnalysis.tsx`.
- `currentPracticeTabAtom` (family `practiceTabFamily`, default `"train"`) holds
  the selected sub-tab.
- **Train** (`PracticePanel` + `Board.tsx`): `newPractice` picks an FSRS card
  (one FEN → one answer SAN), `goToMove`s the board there, sets
  `currentInvisibleAtom` true (blurs the notation list so the user can't read
  ahead), and sets `practiceStateAtom` to `{ phase: "waiting", currentFen }`.
  The user's move is intercepted in `Board.tsx makeMove` under `if (practicing)`:
  `san === c.answer` commits and goes to `phase: "correct"`; otherwise it shows a
  red notification, records a lapse, and moves on. `practicing` is
  `currentTabSelected === "practice" && practiceTabSelected === "train"`.
- **Build** (`RepertoireInfo.tsx`): uses `searchExplorerMoves("lichess" |
  "masters", fens, token)` for per-move stats; needs a Lichess OAuth token
  (`sessions.find(s => s.lichess?.accessToken)`), otherwise shows an auth alert
  linking to `/accounts`.
- Tree store (`src/state/store/tree.ts`, one Zustand instance per board tab via
  `TreeStateContext`): `goToMove(path)`, `currentNode()`, `position`, `root`,
  `headers` (`.orientation`, `.start`), `setShapes` (persists shapes onto the
  node — **not** used here). `findFen(fen, root)` (`treeReducer.ts`) walks the
  tree for an exact-FEN node.
- `Board.tsx` builds a local `shapes: DrawShape[]` array each render and passes
  it as chessground `drawable.autoShapes`. This array is **not** persisted
  (only user-drawn shapes via `onChange → setShapes` are). Hint shapes ride on
  this array.
- Explorer cache (`src-tauri/src/explorer.rs`): `normalize_fen` keeps the first
  four FEN fields; the cache is permanent, per `(source, fen)`, throttled to
  ~1.1 s between network fetches, and needs the Lichess token.

## Design

### 1. Placement and gating

- `PracticePanel.tsx`: add a third `Tabs.Tab value="play"` and a
  `Tabs.Panel value="play"` rendering `<PracticePlay />`.
- `BoardAnalysis.tsx`: add
  `const playing = currentTabSelected === "practice" && practiceTabSelected === "play";`
  and pass `playing={playing}` to `<Board>`. Add `playing` to the existing
  `useEffect` that clears practice-only board state when leaving the mode
  (reset `playStateAtom` / `playHintAtom` / `currentInvisibleAtom` when
  `!playing && !practicing`).
- No change to the `isRepertoire` gate — the whole panel is already
  repertoire-only.

### 2. Opponent engine — `src/utils/repertoirePlay.ts`

A pure module (no React, no Tauri) with colocated tests. All functions take the
tree `root` and integer `position` paths (`number[]`), matching the rest of the
codebase.

```ts
/** First four FEN fields — placement, side, castling, en passant.
 *  Mirrors `normalize_fen` in explorer.rs so transposition keys match the cache. */
export function normalizeFen(fen: string): string;

/** Given the node we would navigate to (`candidatePath`, whose position is `fen`),
 *  return the path we should actually use. If the candidate node is a leaf but
 *  another node in the tree has the same normalised FEN AND has children, return
 *  that node's path instead (follow the transposition into the prepared line).
 *  Prefers the shallowest such node; returns `candidatePath` unchanged if none. */
export function resolvePointer(root: TreeNode, candidatePath: number[], fen: string): number[];

export type UserMoveResult =
  | { ok: true; nextPath: number[] }
  | { ok: false };

/** Is `san` a prepared continuation from the node at `currentPath`?
 *   1. direct child whose `.san === san` → resolvePointer to it;
 *   2. else compute the FEN after `san`; if some node in the tree has that
 *      normalised FEN (a transposition into another line) → resolvePointer to it;
 *   3. else → { ok: false } (a mistake). */
export function matchUserMove(root: TreeNode, currentPath: number[], san: string): UserMoveResult;

export type OpponentPick = { san: string; nextPath: number[] };

/** Choose the opponent's reply from `node.children` (each child is an opponent
 *  move the user prepared for). Weight each child by the Lichess game count for
 *  its SAN, floored to `EPSILON` so a prepared line Lichess has never seen stays
 *  reachable but rare. If every weight is `EPSILON`, pick uniformly. Returns the
 *  picked SAN and `resolvePointer([...currentPath, childIndex])`.
 *  `rng` defaults to `Math.random`, injected for tests. */
export function pickOpponentMove(
  root: TreeNode,
  currentPath: number[],
  lichessStats: { move: string; white: number; draw: number; black: number }[],
  rng?: () => number,
): OpponentPick | null;   // null only if node has no children

export type LineStatus = "continue" | "complete" | "gap";

/** At the node reached:
 *   - has children            → "continue"
 *   - leaf, opponent to move   → "complete" (user finished their prepared line)
 *   - leaf, user to move       → "gap" (opponent entered a spot with no prepared reply) */
export function lineStatus(node: TreeNode, userColor: "white" | "black"): LineStatus;
```

FEN-after-move and legal-move handling use `positionFromFen` / `parseSanOrUci`
from `src/utils/chessops.ts` plus chessops `makeFen(pos.toSetup())`.

`EPSILON` is a module constant (start at `0.5`); tuning it later needs no API
change.

### 3. State — new atoms in `src/state/atoms.ts`

Tab-scoped families, following `practiceStateFamily` (plain `atom`, not
persisted):

```ts
export type PlayPhase = "idle" | "opponentThinking" | "waiting" | "lineComplete" | "gap";
export type PlayState = { phase: PlayPhase; fen?: string };
// `fen` pins the position the machine expects during `opponentThinking` / `waiting`,
// so wandering the move list during your turn neither starts a phantom opponent turn
// nor lets a move from a different line count.
const playStateFamily = atomFamily((_tab: string) => atom<PlayState>({ phase: "idle" }));
export const playStateAtom = tabValue(playStateFamily);

export type PlayHint = { stage: 0 | 1 | 2 };
const playHintFamily = atomFamily((_tab: string) => atom<PlayHint>({ stage: 0 }));
export const playHintAtom = tabValue(playHintFamily);

export type PlaySessionStats = { linesCompleted: number; mistakes: number };
const playSessionStatsFamily = atomFamily((_tab: string) =>
  atom<PlaySessionStats>({ linesCompleted: 0, mistakes: 0 }));
export const playSessionStatsAtom = tabValue(playSessionStatsFamily);

export const repertoirePlaySourceAtom = atomWithStorage<"lichess" | "masters">(
  "repertoire-play-source", "lichess");
```

### 4. Flow — orchestrated in `PracticePlay.tsx`

Mirrors `PracticePanel`'s `newPractice` + effect structure. The panel holds a
ref to the current repertoire `position` and drives phase transitions; the board
only intercepts the user's move.

- **New Game** (`startGame`):
  - `goToMove(headers.start ?? [])`, `setPlayHint({ stage: 0 })`,
    `setInvisible(true)`.
  - Session stats are kept (New Game mid-session keeps the running totals; a
    separate Reset via the Stop button zeroes them).
  - If `lineStatus(startNode) === "gap"` immediately (empty repertoire) → phase
    `gap`. Else if it is the opponent's move at the start position (user is
    Black, start ply is White to move) → phase `opponentThinking`. Else →
    `waiting`.

- **`opponentThinking`** (effect keyed on `phase === "opponentThinking"` and the
  current FEN):
  - `searchExplorerMoves(source, [currentNode.fen], token)` — permanent disk
    cache makes repeats instant; a cold FEN costs one throttled fetch.
  - `pickOpponentMove(root, position, stats)`; if `null` (no children) →
    `lineStatus` decides `complete` / `gap`.
  - `await` ~400 ms (constant `OPPONENT_DELAY_MS`) for feel, then
    `goToMove(pick.nextPath)`.
  - `lineStatus` of the new node → `waiting` / `lineComplete` / `gap`.
  - Guard against races: capture the FEN at effect start, bail if
    `currentNode.fen` changed (Stop, New Game) before the fetch resolves.

- **`waiting`**: board is unlocked for the user's color. The move is intercepted
  in `Board.tsx makeMove` (section 5):
  - `matchUserMove` `ok` → `goToMove(nextPath)`, `setPlayHint({ stage: 0 })`,
    then `lineStatus` → `opponentThinking` or `lineComplete`.
  - `ok: false` → **do not commit**: `setPendingMove(null)` (board re-renders
    from the unchanged `currentNode.fen` and snaps back), `mistakes++`, stay in
    `waiting`. No notification, no answer text.

- **`lineComplete`**: `linesCompleted++` (once, on entering the phase),
  `setInvisible(false)` so the user can scroll the finished line, panel shows a
  single **New Game** button.

- **`gap`**: `setInvisible(false)`; **New Game** button plus a dimmed line: "No prepared reply here —
  add one in Build" with a button that switches to the `build` sub-tab
  (`setTab("build")`, the board is already on the gap position).

- **Stop**: phase → `idle`, `setInvisible(false)`, `setPlayHint({ stage: 0 })`,
  session stats zeroed.

### 5. Board wiring — `src/components/boards/Board.tsx`

- Add `playing?: boolean` to `ChessboardProps` and the destructure.
- New atoms read: `const [playState, setPlayState] = useAtom(playStateAtom)`,
  `const setPlaySessionStats = useSetAtom(playSessionStatsAtom)`,
  `const playHint = useAtomValue(playHintAtom)`.
- In `makeMove`, before the existing `if (practicing)`:

  ```ts
  if (playing) {
    if (playState.phase !== "waiting") { setPendingMove(null); return; }
    const san = makeSan(pos, move);
    const res = matchUserMove(root, position, san);
    if (!res.ok) {
      setPendingMove(null);
      setPlaySessionStats((s) => ({ ...s, mistakes: s.mistakes + 1 }));
      return;
    }
    setPendingMove(null);
    goToMove(res.nextPath);
    // phase transition handled by the panel effect watching position/FEN
    return;
  }
  ```

  (`position` and `goToMove` are already available from the store in `Board`.)
- `playLock`: extend the `movableColor` memo —
  `const playLock = !!playing && playState.phase !== "waiting";` and return
  `undefined` when `playLock` (same as `practiceLock`).
- Hint shapes: after the block that concatenates `currentNode.shapes`, add:

  ```ts
  if (playing && playHint.stage > 0 && pos) {
    const hintChild = currentNode.children[0];
    if (hintChild?.move) {
      const from = makeSquare((hintChild.move as NormalMove).from);
      const to = makeSquare((hintChild.move as NormalMove).to);
      if (from && playHint.stage === 1) shapes.push({ orig: from, brush: "green" });
      if (from && to && playHint.stage === 2) shapes.push({ orig: from, dest: to, brush: "green" });
    }
  }
  ```

  This rides the non-persisted `autoShapes` array, so hints never touch the
  repertoire file.

### 6. Panel UI — `src/components/panels/practice/PracticePlay.tsx`

Layout mirrors the Train panel's `Stack p="sm" gap="md"`.

- **Auth / empty gates** (checked first):
  - not repertoire — cannot happen (panel is gated), no handling.
  - no Lichess token → the same alert Build uses
    (`Board.Database.ExplorerAuthRequired*`, link to `/accounts`).
  - `root.children.length === 0` → alert "Add moves in Build first" + button to
    the `build` sub-tab.
- **Source control**: `SegmentedControl` Lichess / Masters bound to
  `repertoirePlaySourceAtom`.
- **Session stats**: a two-cell `SimpleGrid` — Lines completed, Mistakes
  (`Board.Practice.Play.LinesCompleted`, `Board.Practice.Play.Mistakes`).
- **Phase block**:
  - `idle` → `Button` "Start playing" (`onClick={startGame}`).
  - `opponentThinking` → `Group` with `Loader size="xs"` + "Opponent is
    thinking…".
  - `waiting` → a `Paper` with:
    - "Your move" text.
    - **Hint** `Button`: label is `stage === 0 ? "Hint" : stage === 1 ? "Show
      arrow" : "Hint"`. Click: `stage 0 → 1`, `1 → 2`, `2 → 1` (arrow stays
      available; it resets to 0 on the next move via the panel/board flow).
    - **Stop** `Button` (`variant="subtle" color="red"`).
  - `lineComplete` → `Paper`, green check, "Line complete" + **New Game**
    (`onClick={startGame}`).
  - `gap` → `Paper`, "You're out of book — no prepared reply here." + a
    "Go to Build" button + **New Game**.
- **Hotkey**: `useHotkeys("h", () => cycleHint(), { enabled: phase === "waiting" })`.

### 7. i18n

New keys added **by hand** to `src/translation/en-US.json` under
`Board.Practice.Play.*` (repo memory: `pnpm i18n:extract` rewrites every catalog,
so single keys go in by hand):

```
"Play": "Play",
"Play.StartPlaying": "Start playing",
"Play.NewGame": "New game",
"Play.YourMove": "Your move",
"Play.OpponentThinking": "Opponent is thinking…",
"Play.Hint": "Hint",
"Play.ShowArrow": "Show arrow",
"Play.LineComplete": "Line complete",
"Play.OutOfBook": "You're out of book — no prepared reply here.",
"Play.GoToBuild": "Add a reply in Build",
"Play.LinesCompleted": "Lines completed",
"Play.Mistakes": "Mistakes",
"Play.NeedMoves": "Add moves to this repertoire in Build first.",
"Play.Source": "Opponent source"
```

### 8. Tests — `src/utils/tests/repertoirePlay.test.ts`

- `normalizeFen` drops clocks / move number, keeps en passant.
- `resolvePointer`: leaf candidate + deeper same-FEN node elsewhere → returns the
  deeper node's path; no match → returns candidate unchanged; prefers shallowest.
- `matchUserMove`: direct child; transposition into another line; unprepared move
  → `{ ok: false }`.
- `pickOpponentMove`: deterministic `rng` picks the frequency-weighted move;
  a child absent from `lichessStats` still reachable (ε), never chosen when the
  `rng` value lands outside its ε slice; all-absent → uniform; node with no
  children → `null`.
- `lineStatus`: children → `continue`; leaf with opponent to move → `complete`;
  leaf with user to move → `gap`.

Build a small fixture tree with a known transposition (e.g. a QGD move-order
swap) so `resolvePointer` / `matchUserMove` transposition paths are exercised
against real SANs.

## Files touched

| File | Change |
| --- | --- |
| `src/utils/repertoirePlay.ts` | new — pure opponent/transposition engine |
| `src/utils/tests/repertoirePlay.test.ts` | new — unit tests |
| `src/components/panels/practice/PracticePlay.tsx` | new — Play panel UI + flow effect |
| `src/components/panels/practice/PracticePanel.tsx` | add `play` tab + panel |
| `src/components/boards/Board.tsx` | `playing` prop, `makeMove` branch, `playLock`, hint shapes |
| `src/components/boards/BoardAnalysis.tsx` | derive + pass `playing`, extend cleanup effect |
| `src/state/atoms.ts` | `playStateAtom`, `playHintAtom`, `playSessionStatsAtom`, `repertoirePlaySourceAtom` |
| `src/translation/en-US.json` | new `Board.Practice.Play.*` keys |

## Open questions / deferred

- Opponent transpositions *out of* `node.children` (a legal move that is not a
  prepared child but transposes into another prepared subtree) are **not**
  considered — the opponent only plays direct children. Following transpositions
  applies to where the pointer lands, not to expanding the candidate set. Can be
  revisited if lines feel too narrow.
- `EPSILON` and `OPPONENT_DELAY_MS` are constants, tuned by feel after first use.
- No "review the line" step after completion — just New Game. The board is left
  on the final position with the notation un-blurred (`setInvisible(false)` on
  entering `lineComplete` / `gap`) so the user can scroll back manually.
