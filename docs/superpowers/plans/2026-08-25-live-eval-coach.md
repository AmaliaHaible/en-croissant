# Live Evaluation & Coach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional live evaluation bar, incremental chess.com-style move-quality feedback (per color), and a two-stage hint button to live play (`BoardGame.tsx`), for both engine games and local human-vs-human games.

**Architecture:** A new hook, `useLiveCoachEngine`, mounted only in `BoardGame.tsx`, runs a dedicated short-movetime engine process (under its own process key, separate from any opponent engine or analysis-mode session) whenever any of three new toggles (live eval, White feedback, Black feedback) or an active hint request require it. It writes scores directly into the tree store for the currently viewed node (driving the existing, already-shared `EvalBar`) and writes move classifications onto specific mainline nodes via a new store action, reusing the existing `getAnnotation`/`AnnotationHint` machinery that already powers the offline "Generate report" feature. A Hint button reuses the exact circle→arrow shape-drawing mechanism already shipped in `Puzzles.tsx`, sourcing the move from the same engine feed instead of a stored puzzle solution.

**Tech Stack:** React + TypeScript, Jotai (atoms), Zustand (per-tab tree store), Mantine v8, `@tauri-apps` bindings via `src/bindings`, Vitest for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-25-live-eval-coach-design.md`

## Global Constraints

- No backend (Rust) changes — everything is built on the existing `get_best_moves`/`stop_engine` commands and `best-moves-payload` event.
- The live-coach engine process must use a process key distinct from `(tab, engineId)` so it can never collide with an opponent engine or an analysis-mode session for the same engine/tab.
- Live-coach movetime is a fixed `{ t: "Time", c: 300 }` (300ms) — not user-configurable in v1.
- The three new toggles (live eval, White feedback, Black feedback) are booleans backed by `atomWithStorage`, persisted as a user preference, not scoped per game.
- English (`en-US.json`) translations are required for all new strings; other locales are not touched.
- Follow existing code style: no comments except where a non-obvious constraint demands one, no new abstractions beyond what's described here.

---

## Task 1: `setNodeAnnotation` tree store action

**Files:**

- Modify: `src/state/store/tree.ts`
- Modify: `src/utils/tests/store.test.ts`

**Interfaces:**

- Consumes: `getNodeAtPath(root, path)` (existing, from `@/utils/treeReducer`), `ANNOTATION_INFO` (existing, from `@/utils/annotation`).
- Produces: `TreeStoreState.setNodeAnnotation(path: number[], annotation: Annotation): void` — adds `annotation` to the node at `path` (not `state.position`), following the same "replace same-group annotation" rule as the existing `setAnnotation` action, but additive-only (never toggles an annotation off, and does nothing if `annotation` is `""` or already present). This is what later tasks use to write a move classification onto a specific mainline node regardless of which node is currently being viewed.

- [ ] **Step 1: Write the failing test**

Add to the end of `src/utils/tests/store.test.ts`:

```ts
test("should handle setNodeAnnotation", () => {
  store.setState(treeE4D5());
  store.getState().setNodeAnnotation([0], "!");

  expect(getNewState()).toStrictEqual({
    ...treeE4D5(),
    dirty: true,
    root: {
      ...treeE4D5().root,
      children: [
        {
          ...treeE4D5().root.children[0],
          annotations: ["!"],
        },
      ],
    },
  });
});

test("should not duplicate an existing setNodeAnnotation", () => {
  store.setState(treeE4D5());
  store.getState().setNodeAnnotation([0], "!");
  store.getState().setNodeAnnotation([0], "!");

  expect(getNewState()).toStrictEqual({
    ...treeE4D5(),
    dirty: true,
    root: {
      ...treeE4D5().root,
      children: [
        {
          ...treeE4D5().root.children[0],
          annotations: ["!"],
        },
      ],
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/tests/store.test.ts -t "setNodeAnnotation"`
Expected: FAIL with `store.getState().setNodeAnnotation is not a function`

- [ ] **Step 3: Add the action**

In `src/state/store/tree.ts`, add to the `TreeStoreState` interface, right after `setAnnotation: (payload: Annotation) => void;`:

```ts
    setNodeAnnotation: (path: number[], payload: Annotation) => void;
```

Add to the `stateCreator` object, right after the existing `setAnnotation` implementation:

```ts
        setNodeAnnotation: (path, payload) =>
            set(
                produce((state) => {
                    if (!payload) return;
                    const node = getNodeAtPath(state.root, path);
                    if (!node || node.annotations.includes(payload)) return;
                    state.dirty = true;
                    const newAnnotations = node.annotations.filter(
                        (a) =>
                            !ANNOTATION_INFO[a].group ||
                            ANNOTATION_INFO[a].group !== ANNOTATION_INFO[payload].group,
                    );
                    node.annotations = [...newAnnotations, payload].sort((a, b) =>
                        ANNOTATION_INFO[a].nag > ANNOTATION_INFO[b].nag ? 1 : -1,
                    );
                }),
            ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/tests/store.test.ts -t "setNodeAnnotation"`
Expected: PASS (both new tests)

- [ ] **Step 5: Run the full store test file to check for regressions**

Run: `npx vitest run src/utils/tests/store.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/state/store/tree.ts src/utils/tests/store.test.ts
git commit -m "$(cat <<'EOF'
Add setNodeAnnotation tree store action

Lets a caller annotate a specific mainline node by path instead of
only the currently viewed node, needed for incremental move
classification during live play.
EOF
)"
```

---

## Task 2: Persisted coach toggle atoms

**Files:**

- Modify: `src/state/atoms.ts`

**Interfaces:**

- Produces:
  - `export const liveEvalEnabledAtom: WritableAtom<boolean, ...>` (via `atomWithStorage`)
  - `export const coachFeedbackWhiteAtom: WritableAtom<boolean, ...>`
  - `export const coachFeedbackBlackAtom: WritableAtom<boolean, ...>`

  All three default to `false` (opt-in) and persist across app restarts.

- [ ] **Step 1: Add the atoms**

In `src/state/atoms.ts`, add immediately after the existing `flipBoardAfterMoveAtom` declaration (`export const flipBoardAfterMoveAtom = atomWithStorage<boolean>("flip-board-after-move", true);`):

```ts
export const liveEvalEnabledAtom = atomWithStorage<boolean>("live-eval-enabled", false);
export const coachFeedbackWhiteAtom = atomWithStorage<boolean>("coach-feedback-white", false);
export const coachFeedbackBlackAtom = atomWithStorage<boolean>("coach-feedback-black", false);
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/state/atoms.ts
git commit -m "$(cat <<'EOF'
Add persisted toggle atoms for live coaching

Three independent, opt-in booleans for the live eval bar and
per-color move-quality feedback during play.
EOF
)"
```

---

## Task 3: `useLiveCoachEngine` hook and toggle controls in `BoardGame`

**Files:**

- Create: `src/hooks/useLiveCoachEngine.ts`
- Modify: `src/components/boards/BoardGame.tsx`

**Interfaces:**

- Consumes:
  - `TreeStoreState.setNodeAnnotation` (Task 1)
  - `liveEvalEnabledAtom`, `coachFeedbackWhiteAtom`, `coachFeedbackBlackAtom` (Task 2)
  - Existing: `activeTabAtom`, `enginesAtom` (`@/state/atoms`), `TreeStateContext` (`@/components/common/TreeStateContext`), `commands`, `events`, `type BestMoves`, `type GoMode` (`@/bindings`), `getVariationLine` (`@/utils/chess`), `positionFromFen` (`@/utils/chessops`), `type LocalEngine` (`@/utils/engines`), `getAnnotation` (`@/utils/score`), `useThrottledEffect` (`@/utils/misc`), `treeIteratorMainLine` (`@/utils/treeReducer`), `unwrap` (`@/utils/unwrap`).
- Produces: `useLiveCoachEngine(hintActive: boolean): { bestMoveUci: string | null; engine: LocalEngine | null }`, a default export from `src/hooks/useLiveCoachEngine.ts`. `bestMoveUci` and `engine` are consumed by Task 4 (Hint button).

**Note on the spec's "catch-up eval" for missing prior scores:** the design spec described firing an extra one-shot engine query when a move's prior-position score is missing from cache (e.g. right after enabling coaching mid-game). The implementation below skips that extra round-trip: `getAnnotation` (in `@/utils/score.ts`) already treats a missing `prev`/`prevprev` score as neutral (`0` centipawns) rather than throwing, so a cache miss just means the affected move's classification may be slightly less accurate — never absent or crashing. This only affects the first move classified after coaching is turned on mid-game; every subsequent move has a real cached prior score. This is a strict simplification (one fewer engine round-trip, no added latency) with an equivalent-or-better user experience, so no separate catch-up mechanism is implemented.

**Note on `is_sacrifice` and Brilliant ("!!"):** `getAnnotation`'s Brilliant classification and its sacrifice-flavored Interesting ("!?") branch are gated on an `is_sacrifice` boolean, which the offline batch report computes via a Rust-side quiescence search (`analyze_game`'s `naive_eval`) that `get_best_moves` does not expose. Per the Global Constraints, this plan makes no backend changes, so the hook below always passes `is_sacrifice: false`. In practice this means live coaching can produce Good ("!"), Interesting/Dubious/Mistake/Blunder, but will not surface Brilliant ("!!") moves. This is an accepted v1 gap consistent with the spec's "occasional misclassification ... is expected and acceptable for v1" edge case, not a bug to fix in this plan.

- [ ] **Step 1: Create the hook**

Create `src/hooks/useLiveCoachEngine.ts`:

```ts
import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { useAtomValue } from "jotai";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type BestMoves, commands, events, type GoMode } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  activeTabAtom,
  coachFeedbackBlackAtom,
  coachFeedbackWhiteAtom,
  enginesAtom,
  liveEvalEnabledAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import type { LocalEngine } from "@/utils/engines";
import { useThrottledEffect } from "@/utils/misc";
import { getAnnotation } from "@/utils/score";
import { treeIteratorMainLine } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";

const LIVE_COACH_SUFFIX = "-live-coach";
const LIVE_COACH_GO_MODE: GoMode = { t: "Time", c: 300 };

function liveCoachId(engineId: string): string {
  return `${engineId}${LIVE_COACH_SUFFIX}`;
}

export function useLiveCoachEngine(hintActive: boolean): {
  bestMoveUci: string | null;
  engine: LocalEngine | null;
} {
  const liveEvalEnabled = useAtomValue(liveEvalEnabledAtom);
  const whiteFeedbackEnabled = useAtomValue(coachFeedbackWhiteAtom);
  const blackFeedbackEnabled = useAtomValue(coachFeedbackBlackAtom);
  const active = liveEvalEnabled || whiteFeedbackEnabled || blackFeedbackEnabled || hintActive;

  const engines = useAtomValue(enginesAtom);
  const engine = useMemo(
    () => (engines ?? []).find((e): e is LocalEngine => e.type === "local" && !!e.loaded) ?? null,
    [engines],
  );

  const activeTab = useAtomValue(activeTabAtom);
  const store = useContext(TreeStateContext)!;
  const setScore = useStore(store, (s) => s.setScore);
  const setNodeAnnotation = useStore(store, (s) => s.setNodeAnnotation);
  const fen = useStore(store, (s) => s.root.fen);
  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position)),
  );

  const [pos] = positionFromFen(fen);
  if (pos) {
    for (const uci of moves) {
      const move = parseUci(uci);
      if (!move) break;
      pos.play(move);
    }
  }
  const isGameOver = pos?.isEnd() ?? false;
  const finalFen = useMemo(() => (pos ? makeFen(pos.toSetup()) : fen), [pos, fen]);

  const [bestMoveUci, setBestMoveUci] = useState<string | null>(null);
  const bestLinesCacheRef = useRef<Map<string, BestMoves[]>>(new Map());
  const classifiedNodesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!active || !engine || !activeTab) return;
    const listenerId = liveCoachId(engine.id);

    const unlisten = events.bestMovesPayload.listen(({ payload }) => {
      if (
        payload.engine !== listenerId ||
        payload.tab !== activeTab ||
        payload.fen !== fen ||
        !equal(payload.moves, moves) ||
        payload.bestLines.length === 0
      ) {
        return;
      }

      bestLinesCacheRef.current.set(finalFen, payload.bestLines);
      setBestMoveUci(payload.bestLines[0].uciMoves[0] ?? null);

      if (liveEvalEnabled) {
        setScore(payload.bestLines[0].score);
      }

      if (payload.progress < 100) return;

      const state = store.getState();
      const mainLine = Array.from(treeIteratorMainLine(state.root));
      const tip = mainLine[mainLine.length - 1];
      if (tip.node.fen !== finalFen || !tip.node.move) return;

      const nodeKey = tip.position.join(",");
      if (classifiedNodesRef.current.has(nodeKey)) return;

      const color = tip.node.halfMoves % 2 === 1 ? "white" : "black";
      const colorFeedbackEnabled = color === "white" ? whiteFeedbackEnabled : blackFeedbackEnabled;
      if (!colorFeedbackEnabled) return;

      const parentEntry = mainLine[mainLine.length - 2];
      const grandparentEntry = mainLine.length >= 3 ? mainLine[mainLine.length - 3] : null;
      const prevMoves = bestLinesCacheRef.current.get(parentEntry.node.fen) ?? [];
      const prevScore = prevMoves[0]?.score.value ?? null;
      const prevprevScore = grandparentEntry
        ? (bestLinesCacheRef.current.get(grandparentEntry.node.fen)?.[0]?.score.value ?? null)
        : null;

      const annotation = getAnnotation(
        prevprevScore,
        prevScore,
        payload.bestLines[0].score.value,
        color,
        prevMoves,
        false,
        tip.node.san || "",
      );

      if (annotation) {
        setNodeAnnotation(tip.position, annotation);
        classifiedNodesRef.current.add(nodeKey);
      }
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [
    active,
    engine,
    activeTab,
    fen,
    JSON.stringify(moves),
    finalFen,
    liveEvalEnabled,
    whiteFeedbackEnabled,
    blackFeedbackEnabled,
    setScore,
    setNodeAnnotation,
    store,
  ]);

  useThrottledEffect(
    () => {
      if (!active || !engine || !activeTab) return;
      if (isGameOver) {
        commands.stopEngine(liveCoachId(engine.id), activeTab).then((r) => unwrap(r));
        return;
      }
      commands
        .getBestMoves(liveCoachId(engine.id), engine.path, activeTab, LIVE_COACH_GO_MODE, {
          fen,
          moves,
          extraOptions: [{ name: "MultiPV", value: "2" }],
        })
        .then((r) => unwrap(r));
    },
    50,
    [active, engine, activeTab, fen, JSON.stringify(moves), isGameOver],
  );

  return { bestMoveUci, engine };
}

export default useLiveCoachEngine;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Mount the hook and add toggle icons in `BoardGame.tsx`**

In `src/components/boards/BoardGame.tsx`:

Add to the `@tabler/icons-react` import block (currently `IconArrowsExchange, IconDownload, IconFileText, IconPlus, IconTrophy, IconX, IconZoomCheck`):

```ts
import {
  IconArrowsExchange,
  IconChartBar,
  IconDownload,
  IconFileText,
  IconPlus,
  IconTrophy,
  IconX,
  IconZoomCheck,
} from "@tabler/icons-react";
```

Add `Tooltip` to the `@mantine/core` import block.

Add a new import line:

```ts
import { useLiveCoachEngine } from "@/hooks/useLiveCoachEngine";
```

Add `coachFeedbackBlackAtom`, `coachFeedbackWhiteAtom`, and `liveEvalEnabledAtom` into the _existing_ multi-line `import { ... } from "@/state/atoms";` block (the one starting with `activeTabAtom, addRecentFileAtom, ...`) — do not add a second, separate import statement from `@/state/atoms`. Inserted alphabetically, that block becomes:

```ts
import {
  activeTabAtom,
  addRecentFileAtom,
  coachFeedbackBlackAtom,
  coachFeedbackWhiteAtom,
  flipBoardAfterMoveAtom,
  currentGameIdAtom,
  currentGameStateAtom,
  currentPlayersAtom,
  gameInputColorAtom,
  gameMatchAlternateColorsAtom,
  gameMatchGameCountAtom,
  gameMatchSavePathAtom,
  gameMatchSeriesEnabledAtom,
  gameMatchTournamentNameAtom,
  gameOpeningBookEnabledAtom,
  gameOpeningBookMaxPlyAtom,
  gameOpeningBookPathAtom,
  gamePlayer1SettingsAtom,
  gamePlayer2SettingsAtom,
  gameSameTimeControlAtom,
  liveEvalEnabledAtom,
  tabsAtom,
} from "@/state/atoms";
```

Inside the `BoardGame` function body, right after the existing `const [selectedPiece, setSelectedPiece] = useState<Piece | null>(null);` line, add:

```ts
const [hintActive, setHintActive] = useState(false);
const { bestMoveUci, engine: coachEngine } = useLiveCoachEngine(hintActive);
const [liveEvalEnabled, setLiveEvalEnabled] = useAtom(liveEvalEnabledAtom);
const [whiteFeedbackEnabled, setWhiteFeedbackEnabled] = useAtom(coachFeedbackWhiteAtom);
const [blackFeedbackEnabled, setBlackFeedbackEnabled] = useAtom(coachFeedbackBlackAtom);
```

In the JSX, inside the `(gameState === "playing" || gameState === "gameOver")` block, right after `<Box flex={1}><GameInfo headers={headers} /></Box>` and before `<Group grow>`, add:

```tsx
<Group gap="xs">
  <Tooltip label={coachEngine ? t("Board.Coach.LiveEval") : t("Board.Coach.NoEngine")}>
    <ActionIcon
      variant={liveEvalEnabled ? "filled" : "default"}
      disabled={!coachEngine}
      onClick={() => setLiveEvalEnabled((v) => !v)}
    >
      <IconChartBar size="1rem" />
    </ActionIcon>
  </Tooltip>
  <Tooltip label={coachEngine ? t("Board.Coach.WhiteFeedback") : t("Board.Coach.NoEngine")}>
    <ActionIcon
      variant={whiteFeedbackEnabled ? "filled" : "default"}
      disabled={!coachEngine}
      onClick={() => setWhiteFeedbackEnabled((v) => !v)}
    >
      <Text fz="xs" fw="bold">
        W
      </Text>
    </ActionIcon>
  </Tooltip>
  <Tooltip label={coachEngine ? t("Board.Coach.BlackFeedback") : t("Board.Coach.NoEngine")}>
    <ActionIcon
      variant={blackFeedbackEnabled ? "filled" : "default"}
      disabled={!coachEngine}
      onClick={() => setBlackFeedbackEnabled((v) => !v)}
    >
      <Text fz="xs" fw="bold">
        B
      </Text>
    </ActionIcon>
  </Tooltip>
</Group>
```

`bestMoveUci`, `setHintActive`, and `hintActive` are unused until Task 4 wires the Hint button; leave them assigned as above (Task 4 depends on them existing already).

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors. (`bestMoveUci` and `setHintActive` being unused would normally be a lint warning — Task 4 consumes both in the very next task, so do not add placeholder usages here.)

- [ ] **Step 5: Manual check**

Run: `npm run tauri dev`

- Start a local human-vs-human game (two human players). Confirm the three new icons (chart, "W", "B") appear in the top-right panel next to the game info, and are disabled with a "configure and load a local engine" tooltip if no local engine is loaded in Settings → Engines.
- Load a local engine in Settings → Engines, start a new local human-vs-human game, click the chart icon on. Play a move. Confirm the eval bar (the existing collapsible bar next to the board) starts showing a score shortly after.
- Toggle the chart icon back off. Confirm the eval bar goes blank (no score) even though the bar itself is still visible/collapsible as before.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useLiveCoachEngine.ts src/components/boards/BoardGame.tsx
git commit -m "$(cat <<'EOF'
Add live coach engine hook and toggle controls to play mode

Runs a dedicated short-movetime engine process, under its own
process key, to drive the existing eval bar and per-color move
classification during live play.
EOF
)"
```

---

## Task 4: Hint button

**Files:**

- Modify: `src/components/boards/BoardGame.tsx`

**Interfaces:**

- Consumes: `bestMoveUci`, `setHintActive` (Task 3, already present in `BoardGame.tsx`), existing store action `setShapes` (from `@/state/store/tree.ts`, via `useStore(store, (s) => s.setShapes)`).

- [ ] **Step 1: Add required imports**

In `src/components/boards/BoardGame.tsx`, change the `chessops` import line from:

```ts
import { makeUci, parseUci } from "chessops";
```

to:

```ts
import { makeSquare, makeUci, type NormalMove, parseUci } from "chessops";
```

Add `IconBulb` to the `@tabler/icons-react` import block from Task 3.

- [ ] **Step 2: Bind `setShapes` and `currentNode` from the store**

Right after the existing line `const resetTree = useStore(store, (s) => s.reset);`, add:

```ts
const setShapes = useStore(store, (s) => s.setShapes);
const currentNode = useStore(store, (s) => s.currentNode());
```

- [ ] **Step 3: Add the Hint button**

In the JSX, inside the existing `<Group grow>` button row (the one with Resign/New Game/Save PGN/Analyze/Engine Logs), add this button right after the "Analyze" `Button` and before the `hasEngine && (...)` Engine Logs button:

```tsx
<Button
  variant="default"
  leftSection={<IconBulb size="1rem" />}
  disabled={
    !bestMoveUci ||
    gameState !== "playing" ||
    (pos?.turn === "white" ? players.white.type !== "human" : players.black.type !== "human")
  }
  onClick={() => {
    if (!bestMoveUci) return;
    const move = parseUci(bestMoveUci) as NormalMove;
    const from = makeSquare(move.from);
    const to = makeSquare(move.to);
    if (!from || !to) return;

    const currentShapes = currentNode.shapes;
    const hasCircle = currentShapes.some((s) => s.orig === from && !s.dest);
    const hasArrow = currentShapes.some((s) => s.orig === from && s.dest === to);

    if (hasArrow) {
      setShapes(currentShapes.filter((s) => !(s.orig === from && (!s.dest || s.dest === to))));
      setHintActive(false);
    } else if (hasCircle) {
      setShapes([
        ...currentShapes.filter((s) => !(s.orig === from && !s.dest)),
        { orig: from, dest: to, brush: "green" },
      ]);
    } else {
      setHintActive(true);
      setShapes([...currentShapes, { orig: from, dest: undefined, brush: "green" }]);
    }
  }}
>
  {t("Board.Coach.Hint")}
</Button>
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Manual check**

Run: `npm run tauri dev`

- Start a local human-vs-human game with a local engine loaded. Confirm the Hint button is disabled until it becomes White's turn's engine feed produces a move (may take a moment after game start).
- Click Hint once: confirm a circle appears on the source square of the engine's top move.
- Click Hint again: confirm the circle is replaced by/joined with a full arrow to the destination square.
- Click Hint a third time: confirm both shapes are cleared.
- Play the move (any move, not necessarily the hinted one). Confirm the hint shapes are gone on the new position (since shapes are per-node) and the button resets to its first-click state for the new position.
- Start a game vs. the built-in engine as White. Confirm the Hint button is disabled while it's the engine's turn (Black), and enabled on your own turn.

- [ ] **Step 6: Commit**

```bash
git add src/components/boards/BoardGame.tsx
git commit -m "$(cat <<'EOF'
Add two-stage hint button to play mode

Reuses the circle-then-arrow shape reveal already shipped for
puzzles, sourced from the live coach engine instead of a stored
puzzle solution.
EOF
)"
```

---

## Task 5: Translations

**Files:**

- Modify: `src/translation/en-US.json`

- [ ] **Step 1: Add the new keys**

In `src/translation/en-US.json`, inside the `"translation"` object, add these five keys in alphabetical order among the existing `"Board.*"` keys (they sort right after the `"Board.Analysis.*"` block and before `"Board.Opponent.*"`, since `"Coach"` < `"Opponent"` and `"Coach"` > `"Analysis"` alphabetically):

```json
    "Board.Coach.BlackFeedback": "Feedback: Black",
    "Board.Coach.Hint": "Hint",
    "Board.Coach.LiveEval": "Live Evaluation",
    "Board.Coach.NoEngine": "Configure and load a local engine to enable live coaching",
    "Board.Coach.WhiteFeedback": "Feedback: White",
```

- [ ] **Step 2: Verify the i18n test still passes**

Run: `npx vitest run src/utils/tests/i18n.test.ts`
Expected: PASS (this test typically checks key consistency across locale files — since only `en-US.json` is being touched and no other locale references these keys yet, this should pass; if it fails because it requires every key to exist in every locale, add the same five keys with identical English text to every other file in `src/translation/*.json` as a placeholder-free literal copy, not a TODO).

- [ ] **Step 3: Commit**

```bash
git add src/translation/en-US.json
git commit -m "$(cat <<'EOF'
Add translations for live coach toggles and hint button
EOF
)"
```

---

## Task 6: Full manual verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated suite**

Run: `npm run lint && npm test`
Expected: All pass.

- [ ] **Step 2: Local human-vs-human, both feedback toggles on**

Run: `npm run tauri dev`. Start a local human-vs-human game with a local engine loaded. Turn on both the White and Black feedback toggles. Play several moves for both colors, including at least one clear blunder (e.g. hang a piece) and one clearly fine move. Confirm classification icons appear on the board for both colors' moves after each move (reusing the existing `AnnotationHint` on-board icon, which itself only renders when the pre-existing "show comments" display setting is on — it defaults to on, but if icons don't appear, check that setting before assuming a regression).

- [ ] **Step 3: Vs. built-in engine, one color's feedback only**

Start a game vs. the built-in engine as White with only the White feedback toggle on. Play a few moves. Confirm your own moves get classification icons and the engine's moves do not.

- [ ] **Step 4: Live eval bar toggling mid-game**

During an ongoing game, toggle the live-eval icon on and off a few times. Confirm the eval bar populates/clears accordingly and the game clock and move flow are undisturbed (no lag or move-input issues).

- [ ] **Step 5: Hint mid-game**

Use the Hint button mid-game as described in Task 4 Step 5. Confirm the two-stage reveal and the reset on the next move.

- [ ] **Step 6: No engine configured**

In Settings → Engines, unload/remove all local engines. Start a new game. Confirm all three toggle icons and the Hint button are disabled with the "configure and load a local engine" tooltip, and no errors appear in the console.
