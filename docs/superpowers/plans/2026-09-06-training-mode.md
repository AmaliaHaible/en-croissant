# Training Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Training" board tab where the user drills a self-chosen start position against a Lichess-probability opponent while an engine silently undoes any move that loses too much evaluation, with an on-demand two-stage hint.

**Architecture:** New `training` tab type with a dedicated `BoardTraining.tsx` component (Portal-based, mirrors `BoardGame`/`Puzzles`). A pure module (`src/utils/training.ts`) holds the threshold math, Lichess-move sampling, and hint ranking. A continuous eval-engine hook (`src/hooks/useTrainingEngine.ts`, modeled on `useLiveCoachEngine`) writes `score` onto whichever tree node the board sits on. `BoardTraining` runs a phase machine (`setup → waiting → checking → opponentThinking → outOfBook / gameOver`); on the user's move it appends the move, locks the board, waits for that node's eval, and either keeps it or `deleteMove`s it back off. Nothing is persisted except the engine choices and thresholds.

**Tech Stack:** React 19 + TypeScript, Jotai (global/persisted state) + Zustand (`TreeStateContext` per-tab tree store), Mantine 8, Lichess chessground, chessops, vitest. Tauri commands `getBestMoves` / `getExplorerMoves` (no backend changes).

**Spec:** `docs/superpowers/specs/2026-09-06-training-mode-design.md`

## Global Constraints

- Package manager is **pnpm**. Typecheck+lint gate: `pnpm lint` (`tsc --noEmit && oxlint`). Format: `pnpm format` (oxfmt). Tests: `pnpm vitest run <file>`.
- Linting/formatting is the **oxc** toolchain, not ESLint/Prettier. Match surrounding code style (4-space indent in `src/utils` and `src/state`, 2-space in `src/components` — follow each file's existing indentation).
- **Never** edit `src/bindings/generated.ts` by hand. This feature adds no Rust code and no new bindings.
- i18n: add new keys **by hand** to `src/translation/en-US.json` only. Do **not** run `pnpm i18n:extract` (it rewrites every catalog). Use `t("Key.Path", "English default")` at call sites.
- Persisted atoms use `atomWithStorage`; per-tab ephemeral state uses `atomFamily` + the local `tabValue` helper — follow the existing `playStateFamily` / `repertoirePlaySourceAtom` patterns in `src/state/atoms.ts`.
- Engine scores from the backend are **always normalized to White's POV** (`invert_score` in `chess.rs`), regardless of whose turn it is. Converting to a player's POV is therefore turn-independent: `userIsWhite ? cp : -cp`.
- Explorer / opening-book calls require a Lichess OAuth token (`sessions.find(s => s.lichess?.accessToken)?.lichess?.accessToken`); without it show the existing `Board.Database.ExplorerAuthRequired*` alert.
- Only one board tab mounts its Portal UI at a time — do not change that; `BoardTraining` renders into the same `#left` / `#topRight` / `#bottomRight` Portal hosts as the other board components.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/utils/training.ts` | **new.** Pure functions: `scoreToCp`, `allowedDrop`, `passesThreshold`, `totalBookGames`, `sampleBookMove`, `goodEnoughHints`. No React, no Tauri. |
| `src/utils/tests/training.test.ts` | **new.** Unit tests for every export of `training.ts`. |
| `src/state/atoms.ts` | **modify.** Add training state/hint/stats/color families + persisted config atoms, after the Repertoire "Play" block (~line 697). |
| `src/utils/tabs.ts` | **modify.** Add `"training"` to the `tabSchema` type enum (line 61). |
| `src/hooks/useTrainingEngine.ts` | **new.** Continuous eval-engine session for the active training tab; `setScore` onto the current node; exposes latest MultiPV lines. |
| `src/components/boards/BoardTraining.tsx` | **new.** Setup screen + phase machine + the three Portals. |
| `src/components/boards/Board.tsx` | **modify.** `training` + `trainingHintMoves` props; `makeMove` `training` branch; `trainingLock` in `movableColor`; hint shapes. |
| `src/components/tabs/BoardsPage.tsx` | **modify.** `TabSwitch` `match(tab.type)` — add `.with("training", …)` (line ~364) + import. |
| `src/components/tabs/BoardTab.tsx` | **modify.** `TabIcon` — `training` → `IconTargetArrow` (line ~132). |
| `src/components/tabs/NewTabHome.tsx` | **modify.** The `IconPuzzle` card becomes "Training" with a primary **Train** button and a secondary **Puzzles** button (line ~357). |
| `src/translation/en-US.json` | **modify.** New `Board.Training.*` and `Home.Card.Training.*` keys. |

---

## Task 1: Pure `training.ts` module

**Files:**
- Create: `src/utils/training.ts`
- Test: `src/utils/tests/training.test.ts`

**Interfaces:**
- Consumes: `Score`, `BestMoves` from `@/bindings`. Explorer rows are `{ move: string; white: number; black: number; draw: number }` (the `*` summary row has `move === "*"`).
- Produces:
  - `MATE_CP = 2000`
  - `scoreToCp(score: Score, userIsWhite: boolean): number` — White-POV score → user-POV centipawns, mate clamped to ±`MATE_CP`.
  - `type ThresholdConfig = { maxLossPawns: number; maxLossPct: number }`
  - `allowedDrop(priorCp: number, cfg: ThresholdConfig): number`
  - `passesThreshold(priorCp: number, afterCp: number, cfg: ThresholdConfig): boolean`
  - `type ExplorerMoveStat = { move: string; white: number; black: number; draw: number }`
  - `totalBookGames(stats: ExplorerMoveStat[]): number`
  - `sampleBookMove(stats: ExplorerMoveStat[], rng?: () => number): string | null` — returns a SAN, or null when no non-`*` row has positive weight.
  - `type HintMove = { uci: string; from: string; to: string; cp: number; rank: number; brush: "green" | "blue" | "yellow"; lineWidth: number }`
  - `goodEnoughHints(lines: BestMoves[], priorCp: number, userIsWhite: boolean, cfg: ThresholdConfig): HintMove[]`

- [ ] **Step 1: Write the failing test**

Create `src/utils/tests/training.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BestMoves, Score } from "@/bindings";
import {
    allowedDrop,
    goodEnoughHints,
    MATE_CP,
    passesThreshold,
    sampleBookMove,
    scoreToCp,
    totalBookGames,
} from "../training";

const cfg = { maxLossPawns: 0.05, maxLossPct: 40 };

function cp(value: number): Score {
    return { value: { type: "cp", value }, wdl: null };
}
function mate(value: number): Score {
    return { value: { type: "mate", value }, wdl: null };
}

describe("scoreToCp", () => {
    it("passes White-POV cp straight through for White", () => {
        expect(scoreToCp(cp(80), true)).toBe(80);
    });
    it("negates for Black", () => {
        expect(scoreToCp(cp(80), false)).toBe(-80);
    });
    it("clamps mate to ±MATE_CP", () => {
        expect(scoreToCp(mate(3), true)).toBe(MATE_CP);
        expect(scoreToCp(mate(-2), true)).toBe(-MATE_CP);
        expect(scoreToCp(mate(3), false)).toBe(-MATE_CP);
    });
});

describe("allowedDrop", () => {
    it("is the pawn floor when the percentage term is smaller", () => {
        // max(5, 40% of 8) = 5
        expect(allowedDrop(8, cfg)).toBe(5);
    });
    it("is the percentage term when it is larger", () => {
        // max(5, 40% of 20) = 8
        expect(allowedDrop(20, cfg)).toBe(8);
    });
    it("ignores a negative prior for the percentage term", () => {
        // max(5, 40% of max(-30, 0)) = 5
        expect(allowedDrop(-30, cfg)).toBe(5);
    });
});

describe("passesThreshold (user's own examples)", () => {
    it("0.00 -> -0.02 is fine", () => {
        expect(passesThreshold(0, -2, cfg)).toBe(true);
    });
    it("+0.08 -> +0.04 is fine", () => {
        expect(passesThreshold(8, 4, cfg)).toBe(true);
    });
    it("+0.20 -> +0.10 is bad", () => {
        expect(passesThreshold(20, 10, cfg)).toBe(false);
    });
    it("-0.05 -> -0.20 is bad", () => {
        expect(passesThreshold(-5, -20, cfg)).toBe(false);
    });
    it("improving the position always passes", () => {
        expect(passesThreshold(20, 35, cfg)).toBe(true);
    });
});

describe("totalBookGames / sampleBookMove", () => {
    const stats = [
        { move: "e4", white: 40, black: 30, draw: 30 }, // 100
        { move: "d4", white: 20, black: 10, draw: 20 }, // 50
        { move: "*", white: 60, black: 40, draw: 50 }, // excluded
    ];
    it("totalBookGames sums non-* rows", () => {
        expect(totalBookGames(stats)).toBe(150);
    });
    it("sampleBookMove picks by weighted slice", () => {
        expect(sampleBookMove(stats, () => 0.0)).toBe("e4"); // 0..100
        expect(sampleBookMove(stats, () => 0.9)).toBe("d4"); // 100..150
    });
    it("sampleBookMove returns null when nothing has weight", () => {
        expect(sampleBookMove([{ move: "*", white: 5, black: 5, draw: 5 }])).toBeNull();
        expect(sampleBookMove([])).toBeNull();
    });
});

describe("goodEnoughHints", () => {
    // priorCp is the best line's cp (user POV). Lines are White-POV Scores.
    function line(uci: string, score: Score): BestMoves {
        return {
            nodes: 0, depth: 0, score, uciMoves: [uci], sanMoves: [], multipv: 1, nps: 0,
        };
    }
    it("keeps only lines within threshold, ranked, styled", () => {
        const lines = [
            line("e2e4", cp(20)), // afterCp 20, drop 0  -> keep, rank 1, green/12
            line("d2d4", cp(14)), // drop 6 > allowed 8? allowed=max(5, 8)=8 -> keep, rank 2, green/8
            line("g1f3", cp(9)), //  drop 11 > 8 -> drop
            line("b1c3", cp(12)), // drop 8 == 8 -> keep, rank 3, blue/6
        ];
        const hints = goodEnoughHints(lines, 20, true, cfg);
        expect(hints.map((h) => h.uci)).toEqual(["e2e4", "d2d4", "b1c3"]);
        expect(hints[0]).toMatchObject({ from: "e2", to: "e4", rank: 1, brush: "green", lineWidth: 12 });
        expect(hints[1]).toMatchObject({ rank: 2, brush: "green", lineWidth: 8 });
        expect(hints[2]).toMatchObject({ rank: 3, brush: "blue", lineWidth: 6 });
    });
    it("converts POV for Black and drops lines with no first move", () => {
        const lines = [
            line("e7e5", cp(-15)), // Black POV: +15
            { ...line("", cp(-15)), uciMoves: [] as string[] },
        ];
        const hints = goodEnoughHints(lines, 15, false, cfg);
        expect(hints).toHaveLength(1);
        expect(hints[0].from).toBe("e7");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/utils/tests/training.test.ts`
Expected: FAIL — `Cannot find module '../training'`.

- [ ] **Step 3: Write `src/utils/training.ts`**

```ts
import { makeSquare, parseUci } from "chessops";
import type { BestMoves, Score } from "@/bindings";

/** Mate scores are clamped to this many centipawns so a huge swing between two
 *  winning positions can't dominate the drop arithmetic. */
export const MATE_CP = 2000;

/** A backend engine score (always White's POV) → the given player's POV, in
 *  centipawns, with mate clamped to ±MATE_CP. */
export function scoreToCp(score: Score, userIsWhite: boolean): number {
    const whiteCp =
        score.value.type === "cp"
            ? score.value.value
            : Math.sign(score.value.value || 1) * MATE_CP;
    const userCp = userIsWhite ? whiteCp : -whiteCp;
    return Math.max(-MATE_CP, Math.min(MATE_CP, userCp));
}

export type ThresholdConfig = { maxLossPawns: number; maxLossPct: number };

/** The largest eval loss (centipawns) still considered "good enough":
 *  max(pawn floor, percentage of the current positive edge). */
export function allowedDrop(priorCp: number, cfg: ThresholdConfig): number {
    const floor = cfg.maxLossPawns * 100;
    const pct = (cfg.maxLossPct / 100) * Math.max(priorCp, 0);
    return Math.max(floor, pct);
}

/** true ⇔ the move is good enough and should NOT be undone. */
export function passesThreshold(priorCp: number, afterCp: number, cfg: ThresholdConfig): boolean {
    return priorCp - afterCp <= allowedDrop(priorCp, cfg);
}

export type ExplorerMoveStat = { move: string; white: number; black: number; draw: number };

const rowWeight = (s: ExplorerMoveStat) => s.white + s.black + s.draw;

export function totalBookGames(stats: ExplorerMoveStat[]): number {
    return stats.filter((s) => s.move !== "*").reduce((a, s) => a + rowWeight(s), 0);
}

/** Weighted sample (by total games) over the non-`*` rows. `rng` in [0, 1),
 *  injected for tests. null when no row has positive weight. */
export function sampleBookMove(
    stats: ExplorerMoveStat[],
    rng: () => number = Math.random,
): string | null {
    const rows = stats.filter((s) => s.move !== "*" && rowWeight(s) > 0);
    if (rows.length === 0) return null;
    const total = rows.reduce((a, s) => a + rowWeight(s), 0);
    let r = rng() * total;
    for (const row of rows) {
        if (r < rowWeight(row)) return row.move;
        r -= rowWeight(row);
    }
    return rows[rows.length - 1].move;
}

export type HintMove = {
    uci: string;
    from: string;
    to: string;
    cp: number;
    rank: number;
    brush: "green" | "blue" | "yellow";
    lineWidth: number;
};

const RANK_STYLE: { brush: HintMove["brush"]; lineWidth: number }[] = [
    { brush: "green", lineWidth: 12 },
    { brush: "green", lineWidth: 8 },
    { brush: "blue", lineWidth: 6 },
];
const RANK_STYLE_TAIL = { brush: "yellow" as const, lineWidth: 4 };

/** Every MultiPV line whose resulting eval is still good enough vs `priorCp`
 *  (best line's cp, user POV), ranked by eval descending and styled by rank. */
export function goodEnoughHints(
    lines: BestMoves[],
    priorCp: number,
    userIsWhite: boolean,
    cfg: ThresholdConfig,
): HintMove[] {
    return lines
        .map((l) => ({ uci: l.uciMoves[0], cp: scoreToCp(l.score, userIsWhite) }))
        .filter((l): l is { uci: string; cp: number } => !!l.uci)
        .filter((l) => passesThreshold(priorCp, l.cp, cfg))
        .sort((a, b) => b.cp - a.cp)
        .map((l, i) => {
            const move = parseUci(l.uci);
            const from = move && "from" in move ? makeSquare(move.from) : "";
            const to = move && "to" in move ? makeSquare(move.to) : "";
            const style = RANK_STYLE[i] ?? RANK_STYLE_TAIL;
            return { uci: l.uci, from, to, cp: l.cp, rank: i + 1, ...style };
        })
        .filter((h) => h.from && h.to);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/utils/tests/training.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/training.ts src/utils/tests/training.test.ts
git commit -m "feat(training): pure threshold / book-sampling / hint module"
```

---

## Task 2: Training state atoms

**Files:**
- Modify: `src/state/atoms.ts` (insert after the `repertoirePlaySourceAtom` block, ~line 697, before `engineMovesFamily`)

**Interfaces:**
- Consumes: `atom`, `atomFamily`, `atomWithStorage` (already imported in the file), the local `tabValue` helper (defined ~line 434), `CoachEngineConfig` (defined ~line 225).
- Produces (all exported):
  - `type TrainingPhase = "setup" | "waiting" | "checking" | "opponentThinking" | "outOfBook" | "gameOver"`
  - `type TrainingState = { phase: TrainingPhase; fen?: string; path?: number[]; priorScore?: number; checkParent?: number[]; engineOpponentActive: boolean; result?: string }`
  - `trainingStateAtom` (tabValue) default `{ phase: "setup", engineOpponentActive: false }`
  - `type TrainingHint = { stage: 0 | 1 | 2 }`; `trainingHintAtom` default `{ stage: 0 }`
  - `type TrainingSessionStats = { movesPlayed: number; mistakes: number }`; `trainingSessionStatsAtom` default `{ movesPlayed: 0, mistakes: 0 }`
  - `trainingColorAtom` (tabValue) default `"white"` — `"white" | "black"`
  - `trainingEvalEngineConfigAtom` — `atomWithStorage<CoachEngineConfig>("training-eval-engine-config", { engineId: null, variantId: null })`
  - `trainingEvalMovetimeAtom` — `atomWithStorage<number>("training-eval-movetime-ms", 500)`
  - `trainingOpponentEngineConfigAtom` — `atomWithStorage<CoachEngineConfig>("training-opponent-engine-config", { engineId: null, variantId: null })`
  - `trainingOpponentSkillAtom` — `atomWithStorage<number | null>("training-opponent-skill", null)`
  - `trainingMaxLossPawnsAtom` — `atomWithStorage<number>("training-max-loss-pawns", 0.05)`
  - `trainingMaxLossPctAtom` — `atomWithStorage<number>("training-max-loss-pct", 40)`
  - `trainingBookSourceAtom` — `atomWithStorage<"lichess" | "masters">("training-book-source", "lichess")`
  - `trainingMinBookGamesAtom` — `atomWithStorage<number>("training-min-book-games", 10)`

- [ ] **Step 1: Add the atoms**

Insert (4-space indent, matching the file):

```ts
// Training mode — ephemeral per-tab play state + persisted setup config.
// Nothing here is persisted except the trainingEval*/trainingOpponent*/
// trainingMax*/trainingBook*/trainingMinBookGames config atoms.

export type TrainingPhase =
    | "setup"
    | "waiting"
    | "checking"
    | "opponentThinking"
    | "outOfBook"
    | "gameOver";

export type TrainingState = {
    phase: TrainingPhase;
    /** Position the machine expects during waiting/checking/opponentThinking. */
    fen?: string;
    /** That position's tree path — feeds `practicePath` so forward/back stays
     *  on the played line. */
    path?: number[];
    /** Best eval of `fen`, user POV, centipawns (mate clamped). Set once the
     *  engine answers in `waiting`; read in `checking`. */
    priorScore?: number;
    /** Path to navigate back to when a move is rejected in `checking`. */
    checkParent?: number[];
    /** The user chose to keep playing out of book against the opponent engine. */
    engineOpponentActive: boolean;
    /** Terminal result string for the gameOver panel. */
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

const trainingColorFamily = atomFamily((_tab: string) => atom<"white" | "black">("white"));
export const trainingColorAtom = tabValue(trainingColorFamily);

export const trainingEvalEngineConfigAtom = atomWithStorage<CoachEngineConfig>(
    "training-eval-engine-config",
    { engineId: null, variantId: null },
);
export const trainingEvalMovetimeAtom = atomWithStorage<number>("training-eval-movetime-ms", 500);
export const trainingOpponentEngineConfigAtom = atomWithStorage<CoachEngineConfig>(
    "training-opponent-engine-config",
    { engineId: null, variantId: null },
);
export const trainingOpponentSkillAtom = atomWithStorage<number | null>(
    "training-opponent-skill",
    null,
);
export const trainingMaxLossPawnsAtom = atomWithStorage<number>("training-max-loss-pawns", 0.05);
export const trainingMaxLossPctAtom = atomWithStorage<number>("training-max-loss-pct", 40);
export const trainingBookSourceAtom = atomWithStorage<"lichess" | "masters">(
    "training-book-source",
    "lichess",
);
export const trainingMinBookGamesAtom = atomWithStorage<number>("training-min-book-games", 10);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm lint`
Expected: no errors (`tabValue`, `CoachEngineConfig`, `atom`, `atomFamily`, `atomWithStorage` already in scope).

- [ ] **Step 3: Commit**

```bash
git add src/state/atoms.ts
git commit -m "feat(training): add training-mode state and config atoms"
```

---

## Task 3: Tab wiring + `BoardTraining` scaffold

Makes "Train" on the new-tab home open a `training` tab that renders a placeholder. No play logic yet.

**Files:**
- Modify: `src/utils/tabs.ts:61`
- Create: `src/components/boards/BoardTraining.tsx` (scaffold)
- Modify: `src/components/tabs/BoardsPage.tsx` (~line 19 import, ~line 364 match arm)
- Modify: `src/components/tabs/BoardTab.tsx` (~line 3 import, ~line 132 `TabIcon`)
- Modify: `src/components/tabs/NewTabHome.tsx` (~line 357 card)

**Interfaces:**
- Produces: `BoardTraining` — `export default function BoardTraining({ id }: { id: string })`, renders three `Portal`s into `#left` / `#topRight` / `#bottomRight`.

- [ ] **Step 1: Extend the tab type enum**

`src/utils/tabs.ts` line 61:

```ts
    type: z.enum(["new", "play", "analysis", "puzzles", "training"]),
```

- [ ] **Step 2: Create the `BoardTraining` scaffold**

Create `src/components/boards/BoardTraining.tsx` (2-space indent):

```tsx
import { Paper, Portal, Stack, Text } from "@mantine/core";
import { useContext, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import { TreeStateContext } from "../common/TreeStateContext";
import Board from "./Board";

function BoardTraining({ id }: { id: string }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  // Touch the store so the provider stays engaged like the other board views.
  useStore(store, (s) => s.root.fen);
  const boardRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        <Board editingMode={false} boardRef={boardRef} movable="turn" disableVariations />
      </Portal>
      <Portal target="#topRight" style={{ height: "100%" }}>
        <Paper h="100%" withBorder p="md">
          <Stack>
            <Text fw={600}>{t("Board.Training.Setup.Title", "Training setup")}</Text>
            <Text c="dimmed" fz="sm">
              tab {id}
            </Text>
          </Stack>
        </Paper>
      </Portal>
      <Portal target="#bottomRight" style={{ height: "100%" }}>
        <Stack h="100%" gap="xs">
          <GameNotation />
          <MoveControls readOnly />
        </Stack>
      </Portal>
    </>
  );
}

export default BoardTraining;
```

- [ ] **Step 3: Wire `BoardTraining` into `TabSwitch`**

`src/components/tabs/BoardsPage.tsx` — add the import next to the `Puzzles` import (~line 19):

```tsx
import BoardTraining from "../boards/BoardTraining";
```

In `TabSwitch`'s `match(tab.type)` chain, add before `.exhaustive()` (~line 369):

```tsx
          .with("training", () => (
            <>
              {mosaic}
              <BoardTraining id={tab.value} />
            </>
          ))
```

- [ ] **Step 4: Tab icon**

`src/components/tabs/BoardTab.tsx` — add `IconTargetArrow` to the `@tabler/icons-react` import (~line 3), then in `TabIcon` (~line 132) before the `puzzles` check:

```tsx
  if (tabType === "training") {
    return <IconTargetArrow size="0.875rem" />;
  }
```

- [ ] **Step 5: New-tab home card**

`src/components/tabs/NewTabHome.tsx` — replace the `IconPuzzle` card object (~line 357-371) with:

```tsx
    {
      icon: <IconPuzzle size={60} />,
      title: t("Home.Card.Training.Title", "Training"),
      description: t(
        "Home.Card.Training.Desc",
        "Drill a position against a probability opponent with engine feedback",
      ),
      label: t("Home.Card.Training.Button", "Train"),
      onClick: () => {
        setTabs((prev) => {
          const tab = prev.find((t) => t.value === id);
          if (!tab) return prev;
          tab.name = t("Home.TrainingMode", "Training");
          tab.type = "training";
          return [...prev];
        });
      },
      secondaryLabel: t("Home.Card.Training.PuzzlesButton", "Puzzles"),
      onSecondaryClick: () => {
        setTabs((prev) => {
          const tab = prev.find((t) => t.value === id);
          if (!tab) return prev;
          tab.name = t("Home.PuzzleTraining");
          tab.type = "puzzles";
          return [...prev];
        });
      },
    },
```

(The card grid already renders a two-button `Group` when `onSecondaryClick` is present — same as the Import card.)

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm lint`
Expected: no errors. `match(tab.type).exhaustive()` now requires the `training` arm — confirm tsc is happy.

- [ ] **Step 7: Manual smoke**

Run: `pnpm tauri dev`. On the new-tab home, the third card reads **Training** with **Train** / **Puzzles** buttons. **Puzzles** opens the puzzle trainer exactly as before. **Train** opens a tab with the target-arrow icon showing the "Training setup" placeholder and an empty board. Close the dev app.

- [ ] **Step 8: Commit**

```bash
git add src/utils/tabs.ts src/components/boards/BoardTraining.tsx src/components/tabs/BoardsPage.tsx src/components/tabs/BoardTab.tsx src/components/tabs/NewTabHome.tsx
git commit -m "feat(training): add training tab type, scaffold, and new-tab card"
```

---

## Task 4: `useTrainingEngine` hook

Continuous eval of the active training tab's current position: writes `score` onto the node and exposes the latest MultiPV lines. Structure mirrors `src/hooks/useLiveCoachEngine.ts` (copy its lifecycle plumbing — it survived a full review for concurrency/lifecycle bugs — and strip the classification half).

**Files:**
- Create: `src/hooks/useTrainingEngine.ts`

**Interfaces:**
- Consumes: `trainingStateAtom`, `trainingEvalEngineConfigAtom`, `trainingEvalMovetimeAtom` (Task 2); `enginesAtom`, `activeTabAtom` (existing); `withMultiPvFloor` from `@/utils/coach` (`(settings, floor=2) => EngineOption[]`); `getDefaultVariant`, `LocalEngine` from `@/utils/engines`; `commands`, `events`, `BestMoves`, `GoMode` from `@/bindings`; `TreeStateContext`; `getVariationLine` from `@/utils/chess`; `positionFromFen` from `@/utils/chessops`; `useThrottledEffect` from `@/utils/misc`.
- Produces: `useTrainingEngine(): { engine: LocalEngine | null; lines: BestMoves[]; resultFen: string }` — `lines` is the latest MultiPV list for `resultFen`; `resultFen` is the FEN those lines describe.

- [ ] **Step 1: Create the hook**

Copy `src/hooks/useLiveCoachEngine.ts` to `src/hooks/useTrainingEngine.ts` and adapt:

- Rename `useLiveCoachEngine` → `useTrainingEngine`, `LIVE_COACH_SUFFIX` → `TRAINING_EVAL_SUFFIX = "-training-eval"`, `liveCoachId` → `trainingEvalId`.
- Replace the `liveEvalEnabled` / `coachFeedback*` reads with:

  ```ts
  const trainingState = useAtomValue(trainingStateAtom);
  const active =
      trainingState.phase === "waiting" ||
      trainingState.phase === "checking" ||
      trainingState.phase === "opponentThinking";
  const config = useAtomValue(trainingEvalEngineConfigAtom);
  const movetime = useAtomValue(trainingEvalMovetimeAtom);
  ```

- `goMode`: `const goMode: GoMode = useMemo(() => ({ t: "Time", c: Math.max(50, movetime) }), [movetime]);`
- `extraOptions`: `const extraOptions = useMemo(() => withMultiPvFloor(variant?.settings ?? [], 6), [variant]);`
- Keep the `engine` / `variant` resolution (`enginesAtom` filtered to loaded local, `config.engineId` fallback to `[0]`), keep `fen` / `moves` / `finalFen` / `isGameOver` derivation, keep the `bestMovesPayload` listener and the `useThrottledEffect` search loop and the unmount `killEngine` cleanup **verbatim** (only the id suffix changes).
- Replace `handleResultRef`'s body with:

  ```ts
  handleResultRef.current = (resultFen, bestLines, _progress) => {
      if (bestLines.length === 0 || resultFen !== finalFen) return;
      linesRef.current = { fen: finalFen, lines: bestLines };
      setLines(bestLines);
      setResultFen(finalFen);
      setScore(bestLines[0].score);
  };
  ```

  Delete every reference to `classifyMove`, `setNodeAnnotation`, `classifiedFensRef`, `mainLineLengthRef`, `treeIteratorMainLine`, `whiteFeedbackEnabled`, `blackFeedbackEnabled`, `goMode.t !== "Infinite"` progress gymnastics. `{ t: "Time" }` always reports `progress === 100` on completion, but publishing intermediate lines here is fine and desirable (the eval keeps improving while the user thinks), so **do not** gate on `progress`.
- Add the exposed state:

  ```ts
  const [lines, setLines] = useState<BestMoves[]>([]);
  const [resultFen, setResultFen] = useState("");
  const linesRef = useRef<{ fen: string; lines: BestMoves[] }>({ fen: "", lines: [] });
  ```

- When `active` goes false, clear: `useEffect(() => { if (!active) { setLines([]); setResultFen(""); } }, [active]);`
- `return { engine, lines, resultFen };`

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm lint`
Expected: no errors. Verify no leftover imports (`equal` from `fast-deep-equal` is still used by the listener; keep it).

- [ ] **Step 3: Manual smoke (deferred to Task 5)**

The hook has no consumer yet; it is exercised in Task 5. No commit-blocking test here.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useTrainingEngine.ts
git commit -m "feat(training): continuous eval-engine hook for training tab"
```

---

## Task 5: Setup screen

Replace the `BoardTraining` scaffold's `#topRight` with the real setup panel; add `startSession()` that transitions the phase machine out of `setup`. The board plays moves freely during setup.

**Files:**
- Modify: `src/components/boards/BoardTraining.tsx`
- Modify: `src/translation/en-US.json` (setup keys — see Step 4)

**Interfaces:**
- Consumes: Task 2 atoms; `enginesAtom`, `sessionsAtom` (existing); `EnginesSelect` from `@/components/boards/EnginesSelect`; `EngineVariantSelect` from `@/components/common/EngineVariantSelect`; `resolveConfiguredEngine`, `LocalEngine` from `@/utils/engines`; `parseFen` from `chessops/fen`; `positionFromFen` from `@/utils/chessops`; tree store `setFen`, `setHeaders`, `headers`, `currentNode`, `goToMove`, `position`.
- Produces: `startSession()` behaviour — captures `startFen = currentNode().fen`, `userColor` from the side to move, `setFen(startFen)` to collapse any setup moves into a fresh root, sets `trainingColorAtom`, resets stats/hint, sets `trainingStateAtom` to `{ phase: <userToMove ? "waiting" : "opponentThinking">, fen: startFen, path: [], priorScore: undefined, engineOpponentActive: false }`, `setInvisible(true)`.

- [ ] **Step 1: Build the setup panel**

Rewrite `BoardTraining.tsx`. Full component for this task (phase machine effects come in Task 7 — for now only `setup` renders real UI; other phases show a stub `Text`):

```tsx
import {
  ActionIcon,
  Alert,
  Button,
  Divider,
  Group,
  NumberInput,
  Paper,
  Portal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconArrowsExchange, IconInfoCircle } from "@tabler/icons-react";
import { parseFen } from "chessops/fen";
import { Link } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useContext, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  currentInvisibleAtom,
  enginesAtom,
  sessionsAtom,
  trainingBookSourceAtom,
  trainingColorAtom,
  trainingEvalEngineConfigAtom,
  trainingEvalMovetimeAtom,
  trainingHintAtom,
  trainingMaxLossPawnsAtom,
  trainingMaxLossPctAtom,
  trainingMinBookGamesAtom,
  trainingOpponentEngineConfigAtom,
  trainingOpponentSkillAtom,
  trainingSessionStatsAtom,
  trainingStateAtom,
} from "@/state/atoms";
import { positionFromFen } from "@/utils/chessops";
import { type LocalEngine, resolveConfiguredEngine } from "@/utils/engines";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import { EngineVariantSelect } from "@/components/common/EngineVariantSelect";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import { TreeStateContext } from "../common/TreeStateContext";
import Board from "./Board";
import { useTrainingEngine } from "@/hooks/useTrainingEngine";

function EngineConfigRow({
  configAtom,
}: {
  configAtom: typeof trainingEvalEngineConfigAtom;
}) {
  const [config, setConfig] = useAtom(configAtom);
  const allEngines = useAtomValue(enginesAtom);
  const selected = resolveConfiguredEngine(config.engineId, allEngines);
  return (
    <Stack gap="xs">
      <EnginesSelect
        engine={selected}
        setEngine={(e: LocalEngine | null) =>
          setConfig({ engineId: e?.id ?? null, variantId: e?.variants[0]?.id ?? null })
        }
        filter={(e) => !!e.loaded}
      />
      {selected && (
        <EngineVariantSelect
          engine={selected}
          variantId={config.variantId}
          setVariantId={(variantId: string) => setConfig((p) => ({ ...p, variantId }))}
        />
      )}
    </Stack>
  );
}

function BoardTraining({ id }: { id: string }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const currentNode = useStore(store, (s) => s.currentNode());
  const setFen = useStore(store, (s) => s.setFen);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const headers = useStore(store, (s) => s.headers);
  const boardRef = useRef<HTMLDivElement | null>(null);

  useTrainingEngine(); // mounts the eval session for this tab

  const [state, setState] = useAtom(trainingStateAtom);
  const [color, setColor] = useAtom(trainingColorAtom);
  const setHint = useSetAtom(trainingHintAtom);
  const setStats = useSetAtom(trainingSessionStatsAtom);
  const setInvisible = useSetAtom(currentInvisibleAtom);

  const evalConfig = useAtomValue(trainingEvalEngineConfigAtom);
  const [movetime, setMovetime] = useAtom(trainingEvalMovetimeAtom);
  const opponentConfig = useAtomValue(trainingOpponentEngineConfigAtom);
  const [skill, setSkill] = useAtom(trainingOpponentSkillAtom);
  const [source, setSource] = useAtom(trainingBookSourceAtom);
  const [minBookGames, setMinBookGames] = useAtom(trainingMinBookGamesAtom);
  const [maxLossPawns, setMaxLossPawns] = useAtom(trainingMaxLossPawnsAtom);
  const [maxLossPct, setMaxLossPct] = useAtom(trainingMaxLossPctAtom);

  const engines = useAtomValue(enginesAtom);
  const hasLoadedEngine = (engines ?? []).some((e) => e.type === "local" && e.loaded);
  const sessions = useAtomValue(sessionsAtom);
  const token = sessions.find((s) => s.lichess?.accessToken)?.lichess?.accessToken ?? null;

  const [fenInput, setFenInput] = useState("");
  const [fenError, setFenError] = useState<string | null>(null);

  const inSetup = state.phase === "setup";

  function loadFen() {
    const parsed = parseFen(fenInput.trim());
    if (parsed.isErr) {
      setFenError(t("Board.Training.Setup.BadFen", "Not a valid FEN."));
      return;
    }
    setFenError(null);
    setFen(fenInput.trim());
    setColor(parsed.unwrap().turn);
  }

  function startSession() {
    const startFen = currentNode.fen;
    const [pos] = positionFromFen(startFen);
    const userToMove = pos?.turn === color;
    setFen(startFen);
    setHeaders({ ...headers, fen: startFen, orientation: color });
    setHint({ stage: 0 });
    setStats({ movesPlayed: 0, mistakes: 0 });
    setInvisible(true);
    setState({
      phase: userToMove ? "waiting" : "opponentThinking",
      fen: startFen,
      path: [],
      priorScore: undefined,
      checkParent: undefined,
      engineOpponentActive: false,
    });
  }

  const opponentEngine = useMemo(
    () => resolveConfiguredEngine(opponentConfig.engineId, engines),
    [opponentConfig.engineId, engines],
  );

  return (
    <>
      <Portal target="#left" style={{ height: "100%" }}>
        <Board
          editingMode={false}
          boardRef={boardRef}
          movable={inSetup ? "turn" : color}
          disableVariations
        />
      </Portal>
      <Portal target="#topRight" style={{ height: "100%" }}>
        <Paper h="100%" withBorder p="md" style={{ overflow: "hidden" }}>
          {inSetup ? (
            <ScrollArea h="100%" offsetScrollbars>
              <Stack gap="md">
                <Text fw={600}>{t("Board.Training.Setup.Title", "Training setup")}</Text>

                <Paper withBorder p="sm">
                  <Stack gap="xs">
                    <Text fz="sm" fw={500}>
                      {t("Board.Training.Setup.StartPosition", "Start position")}
                    </Text>
                    <Text fz="xs" c="dimmed">
                      {t(
                        "Board.Training.Setup.StartPositionHint",
                        "Play moves on the board, or paste a FEN. Training starts from the position shown.",
                      )}
                    </Text>
                    <Group gap="xs" wrap="nowrap">
                      <TextInput
                        flex={1}
                        size="xs"
                        placeholder="rnbqkbnr/pppppppp/..."
                        value={fenInput}
                        error={fenError}
                        onChange={(e) => setFenInput(e.currentTarget.value)}
                      />
                      <Button size="xs" variant="light" onClick={loadFen}>
                        {t("Board.Training.Setup.LoadFen", "Load FEN")}
                      </Button>
                    </Group>
                    <Group gap="xs">
                      <Text fz="sm">
                        {t("Board.Training.PlayingAs", "Playing as {{color}}", {
                          color: color === "white" ? t("Fen.White") : t("Fen.Black"),
                        })}
                      </Text>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        onClick={() => setColor((c) => (c === "white" ? "black" : "white"))}
                        title={t("Board.Training.Setup.SwapSides", "Swap sides")}
                      >
                        <IconArrowsExchange size={16} />
                      </ActionIcon>
                    </Group>
                  </Stack>
                </Paper>

                <Paper withBorder p="sm">
                  <Stack gap="xs">
                    <Text fz="sm" fw={500}>
                      {t("Board.Training.Setup.EvalEngine", "Evaluation engine")}
                    </Text>
                    {hasLoadedEngine ? (
                      <>
                        <EngineConfigRow configAtom={trainingEvalEngineConfigAtom} />
                        <NumberInput
                          size="xs"
                          label={t("Board.Training.Setup.Movetime", "Time per evaluation (ms)")}
                          min={100}
                          step={100}
                          value={movetime}
                          onChange={(v) => setMovetime(typeof v === "number" ? v : 500)}
                        />
                      </>
                    ) : (
                      <Alert icon={<IconInfoCircle />} color="yellow">
                        {t("Board.Training.Setup.NoEngine", "Add and load a local engine first.")}{" "}
                        <Link to="/engines">{t("SideBar.Engines")}</Link>
                      </Alert>
                    )}
                  </Stack>
                </Paper>

                <Paper withBorder p="sm">
                  <Stack gap="xs">
                    <Text fz="sm" fw={500}>
                      {t("Board.Training.Setup.OpponentEngine", "Opponent engine (out of book)")}
                    </Text>
                    <EngineConfigRow configAtom={trainingOpponentEngineConfigAtom} />
                    <NumberInput
                      size="xs"
                      label={t(
                        "Board.Training.Setup.OpponentSkill",
                        "Strength (Skill Level 0–20, blank = full)",
                      )}
                      min={0}
                      max={20}
                      value={skill ?? ""}
                      onChange={(v) => setSkill(typeof v === "number" ? v : null)}
                    />
                  </Stack>
                </Paper>

                <Paper withBorder p="sm">
                  <Stack gap="xs">
                    <Text fz="sm" fw={500}>
                      {t("Board.Training.Setup.Book", "Opening book")}
                    </Text>
                    {token ? (
                      <>
                        <SegmentedControl
                          size="xs"
                          value={source}
                          onChange={(v) => setSource(v as "lichess" | "masters")}
                          data={[
                            { value: "lichess", label: t("Board.Practice.Build.SourceLichess") },
                            {
                              value: "masters",
                              label: t("Board.Practice.Build.SourceLichessMasters"),
                            },
                          ]}
                        />
                        <NumberInput
                          size="xs"
                          label={t("Board.Training.Setup.MinBookGames", "Leave book below N games")}
                          min={0}
                          value={minBookGames}
                          onChange={(v) => setMinBookGames(typeof v === "number" ? v : 0)}
                        />
                      </>
                    ) : (
                      <Alert icon={<IconInfoCircle />} color="yellow">
                        {t("Board.Database.ExplorerAuthRequired1")}{" "}
                        <Link to="/accounts">
                          {t("Board.Database.ExplorerAuthRequired.Accounts")}
                        </Link>{" "}
                        {t("Board.Database.ExplorerAuthRequired2")}
                      </Alert>
                    )}
                  </Stack>
                </Paper>

                <Paper withBorder p="sm">
                  <Stack gap="xs">
                    <Text fz="sm" fw={500}>
                      {t("Board.Training.Setup.Thresholds", "Thresholds")}
                    </Text>
                    <Group grow>
                      <NumberInput
                        size="xs"
                        label={t("Board.Training.Setup.MaxLossPawns", "Max eval loss (pawns)")}
                        min={0}
                        step={0.01}
                        decimalScale={2}
                        value={maxLossPawns}
                        onChange={(v) => setMaxLossPawns(typeof v === "number" ? v : 0.05)}
                      />
                      <NumberInput
                        size="xs"
                        label={t("Board.Training.Setup.MaxLossPct", "Max eval loss (%)")}
                        min={0}
                        max={100}
                        step={5}
                        value={maxLossPct}
                        onChange={(v) => setMaxLossPct(typeof v === "number" ? v : 40)}
                      />
                    </Group>
                    <Text fz="xs" c="dimmed">
                      {t(
                        "Board.Training.Setup.ThresholdRule",
                        "A move is undone if it loses more than {{pawns}} pawns and more than {{pct}}% of your current edge — whichever limit is larger.",
                        { pawns: maxLossPawns, pct: maxLossPct },
                      )}
                    </Text>
                  </Stack>
                </Paper>

                <Button
                  fullWidth
                  variant="light"
                  disabled={!hasLoadedEngine || !token}
                  onClick={startSession}
                >
                  {t("Board.Training.Setup.Start", "Start training")}
                </Button>
              </Stack>
            </ScrollArea>
          ) : (
            <Text c="dimmed">phase: {state.phase}</Text>
          )}
        </Paper>
      </Portal>
      <Portal target="#bottomRight" style={{ height: "100%" }}>
        <Stack h="100%" gap="xs">
          <GameNotation />
          <MoveControls readOnly={!inSetup} />
        </Stack>
      </Portal>
    </>
  );
}

export default BoardTraining;
```

> If `EnginesSelect`'s prop names differ (`engine` / `setEngine` / `filter`), match its actual signature — check `src/components/boards/EnginesSelect.tsx`. Likewise confirm `EngineVariantSelect`'s props against `src/components/common/EngineVariantSelect.tsx` and `resolveConfiguredEngine`'s signature in `src/utils/engines.ts` (used the same way in `src/components/settings/CoachSettingsTab.tsx`).

- [ ] **Step 2: Add the setup i18n keys**

In `src/translation/en-US.json`, under the `"Board"` → `"Training"` object (create `"Training": { "Setup": { … }, … }` if absent), add:

```json
"Training": {
  "Setup": {
    "Title": "Training setup",
    "StartPosition": "Start position",
    "StartPositionHint": "Play moves on the board, or paste a FEN. Training starts from the position shown.",
    "LoadFen": "Load FEN",
    "BadFen": "Not a valid FEN.",
    "SwapSides": "Swap sides",
    "EvalEngine": "Evaluation engine",
    "Movetime": "Time per evaluation (ms)",
    "OpponentEngine": "Opponent engine (out of book)",
    "OpponentSkill": "Strength (Skill Level 0–20, blank = full)",
    "Book": "Opening book",
    "MinBookGames": "Leave book below N games",
    "Thresholds": "Thresholds",
    "MaxLossPawns": "Max eval loss (pawns)",
    "MaxLossPct": "Max eval loss (%)",
    "ThresholdRule": "A move is undone if it loses more than {{pawns}} pawns and more than {{pct}}% of your current edge — whichever limit is larger.",
    "Start": "Start training",
    "NoEngine": "Add and load a local engine first."
  },
  "PlayingAs": "Playing as {{color}}"
}
```

Also add under `"Home"`:

```json
"TrainingMode": "Training",
"Card": {
  "Training": {
    "Title": "Training",
    "Desc": "Drill a position against a probability opponent with engine feedback",
    "Button": "Train",
    "PuzzlesButton": "Puzzles"
  }
}
```

(Merge into the existing `"Home"` / `"Home"."Card"` objects — do not duplicate the keys.)

- [ ] **Step 3: Typecheck + lint + format**

Run: `pnpm lint` then `pnpm format`
Expected: no errors.

- [ ] **Step 4: Manual smoke**

`pnpm tauri dev` → Train tab. Play a few moves on the board (they append to the notation). Paste a FEN + Load → board jumps, "Playing as" flips to that side's turn. Swap sides toggles. Adjust thresholds/movetime — reopen the tab (or restart) and the values persist. With no loaded engine or no Lichess token, **Start** is disabled with the matching alert. With both present, **Start** switches the panel to `phase: waiting` / `opponentThinking` (shows the stub text) and blurs the notation.

- [ ] **Step 5: Commit**

```bash
git add src/components/boards/BoardTraining.tsx src/translation/en-US.json
git commit -m "feat(training): setup screen with engine/book/threshold config"
```

---

## Task 6: Board `training` wiring

Teach the shared `Board` to (a) accept a provisional training move and (b) draw training hint shapes, gated by a `trainingLock`.

**Files:**
- Modify: `src/components/boards/Board.tsx`

**Interfaces:**
- Consumes: `trainingStateAtom`, `trainingHintAtom`, `trainingColorAtom` (Task 2); `HintMove` from `@/utils/training` (Task 1).
- Produces: two new `ChessboardProps` — `training?: boolean` and `trainingHintMoves?: HintMove[]`. When `training` and `phase === "waiting"` and `priorScore` is set and the pointer is on `trainingState.fen`, the board is movable for `trainingColorAtom`'s color only; otherwise locked. A move played in that state is committed to the tree (via `storeMakeMove`) and the phase is set to `"checking"` with `checkParent` = the pre-move path.

- [ ] **Step 1: Props + atom reads**

In `ChessboardProps` (line ~108) add:

```ts
  training?: boolean;
  trainingHintMoves?: import("@/utils/training").HintMove[];
```

Add to the destructure (line ~126, after `playing,`): `training,` and `trainingHintMoves,`.

Near the other practice/play atom reads (line ~220):

```ts
  const [trainingState, setTrainingState] = useAtom(trainingStateAtom);
  const trainingHint = useAtomValue(trainingHintAtom);
  const trainingColor = useAtomValue(trainingColorAtom);
```

(Add `trainingStateAtom`, `trainingHintAtom`, `trainingColorAtom` to the existing `@/state/atoms` import.)

- [ ] **Step 2: `makeMove` training branch**

In `makeMove`, immediately after the `if (playing) { … }` block and before `if (practicing) {`:

```ts
    if (training) {
      const onExpectedPosition =
        trainingState.fen === undefined || currentNode.fen === trainingState.fen;
      if (
        trainingState.phase !== "waiting" ||
        trainingState.priorScore === undefined ||
        !onExpectedPosition
      ) {
        setPendingMove(null);
        snapBack();
        return;
      }
      // Provisionally accept: commit the move and hand off to BoardTraining's
      // `checking` effect, which evaluates the resulting node and either keeps
      // it or deletes it back off.
      storeMakeMove({ payload: move });
      setPendingMove(null);
      setTrainingState((s) => ({
        ...s,
        phase: "checking",
        checkParent: s.path ?? [],
      }));
      return;
    }
```

- [ ] **Step 3: `trainingLock` in `movableColor`**

After the `playLock` declaration (line ~449):

```ts
  const trainingLock =
    !!training &&
    (trainingState.phase !== "waiting" ||
      trainingState.priorScore === undefined ||
      (trainingState.fen !== undefined && currentNode.fen !== trainingState.fen));
```

In the `movableColor` `useMemo`, change the guard and add a training-color clamp:

```ts
  const movableColor: "white" | "black" | "both" | undefined = useMemo(() => {
    if (practiceLock || playLock || trainingLock) return undefined;
    if (training) return trainingColor; // only ever your own pieces
    return editingMode
      ? "both"
      : match(movable)
          .with("white", () => "white" as const)
          .with("black", () => "black" as const)
          .with("turn", () => turn)
          .with("both", () => "both" as const)
          .with("none", () => undefined)
          .exhaustive();
  }, [practiceLock, playLock, trainingLock, training, trainingColor, editingMode, movable, turn]);
```

- [ ] **Step 4: Hint shapes**

After the `if (playing && playHint.stage > 0 …)` block (line ~439):

```ts
  if (training && trainingHint.stage > 0 && trainingHintMoves && trainingHintMoves.length > 0) {
    const seen = new Set<string>();
    for (const h of trainingHintMoves) {
      if (trainingHint.stage === 1) {
        if (seen.has(h.from)) continue;
        seen.add(h.from);
        shapes.push({ orig: h.from as SquareName, brush: h.brush });
      } else {
        shapes.push({
          orig: h.from as SquareName,
          dest: h.to as SquareName,
          brush: h.brush,
          modifiers: { lineWidth: h.lineWidth },
        });
      }
    }
  }
```

(`SquareName` is already imported in `Board.tsx`; if not, cast to the type chessground's `DrawShape.orig` expects — check the existing `shapes.push` calls.)

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm lint`
Expected: no errors. The `import("@/utils/training").HintMove` inline type keeps this task from needing a value import; if oxlint prefers a top import, add `import type { HintMove } from "@/utils/training";` and use it directly.

- [ ] **Step 6: Commit**

```bash
git add src/components/boards/Board.tsx
git commit -m "feat(training): Board move-interception, lock, and hint shapes"
```

---

## Task 7: Phase machine

The core loop: capture the prior score in `waiting`, evaluate the move in `checking`, sample the opponent in `opponentThinking`, handle `outOfBook` / `gameOver`, plus Stop / New Game.

**Files:**
- Modify: `src/components/boards/BoardTraining.tsx`
- Modify: `src/translation/en-US.json` (play-phase keys)

**Interfaces:**
- Consumes: `useTrainingEngine()` → `{ engine, lines, resultFen }` (Task 4); `scoreToCp`, `passesThreshold`, `sampleBookMove`, `totalBookGames`, `type ThresholdConfig` from `@/utils/training` (Task 1); `searchExplorerMoves` from `@/utils/db`; tree store `appendMove`, `goToMove`, `deleteMove`, `position`, `root`, `setPracticePath`; `getNodeAtPath` from `@/utils/treeReducer`; `positionFromFen` from `@/utils/chessops`; `parseSan` from `chessops/san`; `makeFen` from `chessops/fen`; `commands`, `GoMode` from `@/bindings`; `activeTabAtom`.
- Produces: fully working `waiting`/`checking`/`opponentThinking`/`outOfBook`/`gameOver` panels + `stopSession()` (→ `setup`, stats zeroed, `setInvisible(false)`) and `newGame()` (re-run `startSession` semantics from the stored `state.fen` at `phase: setup`… see Step 3).

- [ ] **Step 1: Add hooks/refs/derived values to `BoardTraining`**

Add near the top of the component:

```tsx
  const { lines, resultFen } = useTrainingEngine();
  const activeTab = useAtomValue(activeTabAtom);
  const appendMove = useStore(store, (s) => s.appendMove);
  const goToMove = useStore(store, (s) => s.goToMove);
  const deleteMove = useStore(store, (s) => s.deleteMove);
  const setPracticePath = useStore(store, (s) => s.setPracticePath);
  const position = useStore(store, (s) => s.position);
  const root = useStore(store, (s) => s.root);

  const cfg = useMemo<ThresholdConfig>(
    () => ({ maxLossPawns: maxLossPawns, maxLossPct: maxLossPct }),
    [maxLossPawns, maxLossPct],
  );
  const userIsWhite = color === "white";
  const startFenRef = useRef<string>(currentNode.fen);
  const currentFenRef = useRef(currentNode.fen);
  currentFenRef.current = currentNode.fen;

  const OPPONENT_DELAY_MS = 400;
```

In `startSession()` set `startFenRef.current = startFen;` right after computing `startFen`.

- [ ] **Step 2: The four effects**

Add these effects (keep them below `startSession`):

```tsx
  // Pin forward/back navigation to the played line.
  useEffect(() => {
    setPracticePath(state.phase !== "setup" ? (state.path ?? null) : null);
  }, [state.phase, state.path, setPracticePath]);

  // Blur notation during active play; restore otherwise.
  useEffect(() => {
    if (state.phase === "waiting" || state.phase === "checking" || state.phase === "opponentThinking") {
      setInvisible(true);
    } else {
      setInvisible(false);
    }
  }, [state.phase, setInvisible]);

  // waiting: capture the prior score once the engine answers for this position.
  useEffect(() => {
    if (state.phase !== "waiting" || state.priorScore !== undefined) return;
    if (resultFen !== currentNode.fen || lines.length === 0) return;
    setState((s) => ({ ...s, priorScore: scoreToCp(lines[0].score, userIsWhite) }));
  }, [state.phase, state.priorScore, resultFen, lines, currentNode.fen, userIsWhite, setState]);

  // checking: evaluate the move the user just played.
  useEffect(() => {
    if (state.phase !== "checking") return;
    if (resultFen !== currentNode.fen || lines.length === 0) return;
    const afterCp = scoreToCp(lines[0].score, userIsWhite);
    const prior = state.priorScore ?? 0;
    const childPath = position;
    const [childPos] = positionFromFen(currentNode.fen);
    const terminal = childPos?.isEnd() ?? false;

    if (!passesThreshold(prior, afterCp, cfg)) {
      const parent = state.checkParent ?? [];
      deleteMove(childPath);
      goToMove(parent);
      setStats((s) => ({ ...s, mistakes: s.mistakes + 1 }));
      setState((s) => ({
        ...s,
        phase: "waiting",
        fen: getNodeAtPath(root, parent).fen,
        path: parent,
        // priorScore for the parent is unchanged — keep it.
      }));
      return;
    }

    setStats((s) => ({ ...s, movesPlayed: s.movesPlayed + 1 }));
    if (terminal) {
      setState((s) => ({ ...s, phase: "gameOver", result: describeResult(childPos!) }));
      return;
    }
    setState((s) => ({
      ...s,
      phase: "opponentThinking",
      fen: currentNode.fen,
      path: childPath,
      priorScore: undefined,
    }));
  }, [state.phase, resultFen, lines, currentNode.fen, position, cfg, userIsWhite, root, deleteMove, goToMove, setStats, setState]);

  // opponentThinking: book sample, else out-of-book engine or stop.
  useEffect(() => {
    if (state.phase !== "opponentThinking") return;
    const fenAtStart = currentNode.fen;
    const pathAtStart = position;
    const [posAtStart] = positionFromFen(fenAtStart);
    if (!posAtStart) return;
    if (posAtStart.isEnd()) {
      setState((s) => ({ ...s, phase: "gameOver", result: describeResult(posAtStart) }));
      return;
    }
    let cancelled = false;

    (async () => {
      let san: string | null = null;

      if (!state.engineOpponentActive) {
        const stats = await searchExplorerMoves(source, [fenAtStart], token)
          .then((r) => r[0] ?? [])
          .catch(() => []);
        if (cancelled || currentFenRef.current !== fenAtStart) return;
        if (stats.length === 0 || totalBookGames(stats) < minBookGames) {
          setState((s) => ({ ...s, phase: "outOfBook" }));
          return;
        }
        san = sampleBookMove(stats);
      } else {
        san = await pickEngineOpponentMove(fenAtStart, pathAtStart);
        if (cancelled || currentFenRef.current !== fenAtStart) return;
      }

      if (!san) {
        setState((s) => ({ ...s, phase: "outOfBook" }));
        return;
      }
      const move = parseSan(posAtStart, san);
      if (!move) {
        setState((s) => ({ ...s, phase: "outOfBook" }));
        return;
      }
      await new Promise((r) => setTimeout(r, OPPONENT_DELAY_MS));
      if (cancelled || currentFenRef.current !== fenAtStart) return;
      appendMove({ payload: move });
      const newPath = [...pathAtStart, getNodeAtPath(root, pathAtStart).children.length];
      const newNode = getNodeAtPath(root, newPath);
      const [newPos] = positionFromFen(newNode.fen);
      if (newPos?.isEnd()) {
        setState((s) => ({ ...s, phase: "gameOver", result: describeResult(newPos) }));
      } else {
        setState((s) => ({
          ...s,
          phase: "waiting",
          fen: newNode.fen,
          path: newPath,
          priorScore: undefined,
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.engineOpponentActive, currentNode.fen, source, token, minBookGames]);
```

Helpers (module scope in the same file):

```tsx
function describeResult(pos: import("chessops").Position): string {
  const outcome = pos.outcome();
  if (!outcome) return "*";
  if (outcome.winner === "white") return "1-0";
  if (outcome.winner === "black") return "0-1";
  return "½-½";
}
```

`pickEngineOpponentMove` (a `useCallback` inside the component):

```tsx
  const pickEngineOpponentMove = useCallback(
    async (fen: string, path: number[]): Promise<string | null> => {
      if (!opponentEngine) return null;
      const variant =
        opponentEngine.variants.find((v) => v.id === opponentConfig.variantId) ??
        opponentEngine.variants[0];
      const extraOptions = [
        ...(variant?.settings ?? []).map((s) => ({ name: s.name, value: String(s.value ?? "") })),
        { name: "MultiPV", value: "3" },
        ...(skill !== null ? [{ name: "Skill Level", value: String(skill) }] : []),
      ];
      const moves = getVariationLine(root, path);
      const go: GoMode = { t: "Time", c: 300 };
      const res = await commands.getBestMoves(
        `${opponentEngine.id}-training-opponent`,
        opponentEngine.path,
        activeTab ?? "",
        go,
        { fen: root.fen, moves, extraOptions },
      );
      const data = res.status === "ok" ? res.data : null;
      const bestLines = data?.[1] ?? [];
      if (bestLines.length === 0) return null;
      // Favour the top move but allow the 2nd/3rd sometimes.
      const weights = [0.6, 0.3, 0.1];
      let r = Math.random();
      let idx = 0;
      for (let i = 0; i < Math.min(bestLines.length, 3); i++) {
        if (r < weights[i]) { idx = i; break; }
        r -= weights[i];
      }
      return bestLines[idx]?.sanMoves[0] ?? bestLines[0].sanMoves[0] ?? null;
    },
    [opponentEngine, opponentConfig.variantId, skill, root, activeTab],
  );
```

(Import `getVariationLine` from `@/utils/chess`, `useCallback`/`useEffect` from `react`, `parseSan` from `chessops/san`, `getNodeAtPath` from `@/utils/treeReducer`, `searchExplorerMoves` from `@/utils/db`, `commands` + `type GoMode` from `@/bindings`.)

- [ ] **Step 3: `stopSession` / `newGame` + play panels**

```tsx
  function stopSession() {
    goToMove([]);
    setState({ phase: "setup", engineOpponentActive: false });
    setHint({ stage: 0 });
    setStats({ movesPlayed: 0, mistakes: 0 });
    setInvisible(false);
  }

  function newGame() {
    const startFen = startFenRef.current;
    setFen(startFen);
    setHeaders({ ...headers, fen: startFen, orientation: color });
    const [pos] = positionFromFen(startFen);
    setHint({ stage: 0 });
    setStats({ movesPlayed: 0, mistakes: 0 });
    setInvisible(true);
    setState({
      phase: pos?.turn === color ? "waiting" : "opponentThinking",
      fen: startFen,
      path: [],
      engineOpponentActive: false,
    });
  }

  function cycleHint() {
    setHint((h) => ({ stage: h.stage === 0 ? 1 : h.stage === 1 ? 2 : 1 }));
  }
  useHotkeys("h", cycleHint, { enabled: state.phase === "waiting" });
```

Replace the `<Text c="dimmed">phase: {state.phase}</Text>` stub with:

```tsx
            <Stack gap="md">
              <SimpleGrid cols={2} spacing="xs">
                <Paper p="xs" withBorder radius="sm">
                  <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
                    {t("Board.Training.MovesPlayed", "Moves played")}
                  </Text>
                  <Text fz="lg" fw={700} c="green">{stats.movesPlayed}</Text>
                </Paper>
                <Paper p="xs" withBorder radius="sm">
                  <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
                    {t("Board.Training.Mistakes", "Mistakes")}
                  </Text>
                  <Text fz="lg" fw={700} c="red">{stats.mistakes}</Text>
                </Paper>
              </SimpleGrid>

              {state.phase === "waiting" && (
                <Paper p="sm" withBorder>
                  <Stack gap="xs" align="center">
                    {state.priorScore === undefined ? (
                      <Group gap="xs">
                        <Loader size="xs" />
                        <Text fz="sm" c="dimmed">
                          {t("Board.Training.Evaluating", "Evaluating…")}
                        </Text>
                      </Group>
                    ) : (
                      <>
                        <Text fz="sm" c="dimmed">{t("Board.Training.YourMove", "Your move")}</Text>
                        <Button variant="light" size="sm" fullWidth onClick={cycleHint}>
                          {hint.stage === 1
                            ? t("Board.Training.ShowArrows", "Show arrows")
                            : t("Board.Training.Hint", "Hint")}
                        </Button>
                      </>
                    )}
                    <Button variant="subtle" size="compact-xs" color="red" onClick={stopSession}>
                      {t("Common.Stop")}
                    </Button>
                  </Stack>
                </Paper>
              )}

              {state.phase === "checking" && (
                <Paper p="sm" withBorder>
                  <Group gap="xs" justify="center">
                    <Loader size="xs" />
                    <Text fz="sm" c="dimmed">
                      {t("Board.Training.CheckingMove", "Checking your move…")}
                    </Text>
                  </Group>
                </Paper>
              )}

              {state.phase === "opponentThinking" && (
                <Paper p="sm" withBorder>
                  <Stack gap="xs" align="center">
                    <Group gap="xs">
                      <Loader size="xs" />
                      <Text fz="sm" c="dimmed">
                        {t("Board.Training.OpponentThinking", "Opponent is thinking…")}
                      </Text>
                    </Group>
                    <Button variant="subtle" size="compact-xs" color="red" onClick={stopSession}>
                      {t("Common.Stop")}
                    </Button>
                  </Stack>
                </Paper>
              )}

              {state.phase === "outOfBook" && (
                <Paper p="sm" withBorder>
                  <Stack gap="xs" align="center">
                    <Text fz="sm" c="dimmed" ta="center">
                      {t("Board.Training.OutOfBook", "Out of book.")}
                    </Text>
                    {opponentEngine && (
                      <Button
                        variant="light"
                        size="sm"
                        fullWidth
                        onClick={() =>
                          setState((s) => ({
                            ...s,
                            phase: "opponentThinking",
                            engineOpponentActive: true,
                          }))
                        }
                      >
                        {t("Board.Training.PlayOnVsEngine", "Play on vs {{engine}}", {
                          engine: opponentEngine.name,
                        })}
                      </Button>
                    )}
                    <Button variant="light" size="sm" fullWidth onClick={newGame}>
                      {t("Board.Training.NewGame", "New game")}
                    </Button>
                    <Button variant="subtle" size="compact-xs" color="red" onClick={stopSession}>
                      {t("Common.Stop")}
                    </Button>
                  </Stack>
                </Paper>
              )}

              {state.phase === "gameOver" && (
                <Paper p="sm" withBorder>
                  <Stack gap="xs" align="center">
                    <Text fw={500}>
                      {t("Board.Training.GameOver", "Game over")} {state.result}
                    </Text>
                    <Button variant="light" size="sm" fullWidth onClick={newGame}>
                      {t("Board.Training.NewGame", "New game")}
                    </Button>
                    <Button variant="subtle" size="compact-xs" color="red" onClick={stopSession}>
                      {t("Common.Stop")}
                    </Button>
                  </Stack>
                </Paper>
              )}

              <Badge variant="light" color="gray" style={{ alignSelf: "flex-start" }}>
                {color === "white" ? t("Fen.White") : t("Fen.Black")}
              </Badge>
            </Stack>
```

Add the needed Mantine imports (`SimpleGrid`, `Loader`, `Badge`, `Group`) and `useHotkeys` from `react-hotkeys-hook`.

Pass `training` to the `<Board>` when not in setup:

```tsx
        <Board
          editingMode={false}
          boardRef={boardRef}
          movable={inSetup ? "turn" : color}
          disableVariations
          training={!inSetup}
        />
```

- [ ] **Step 4: Cleanup on unmount**

```tsx
  useEffect(() => {
    return () => {
      setState({ phase: "setup", engineOpponentActive: false });
      setHint({ stage: 0 });
      setInvisible(false);
      setPracticePath(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 5: Play-phase i18n keys**

Add to the `"Board"."Training"` object:

```json
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
"Mistakes": "Mistakes"
```

- [ ] **Step 6: Typecheck + lint + format**

Run: `pnpm lint` then `pnpm format`
Expected: no errors. Confirm `deleteMove` / `appendMove` / `setPracticePath` names match `src/state/store/tree.ts` (verified: lines 56, 52, and the practice-path setter used in `PracticePlay.tsx`).

- [ ] **Step 7: Manual smoke**

`pnpm tauri dev` → Train. Set up e.g. `1.e4` with you as Black, Start. Opponent (or you) moves. Play a solid reply → accepted, opponent replies from book. Play an obvious blunder (hang the queen) → "Checking…" then the move snaps back, Mistakes ticks. Keep going until the book runs out → "Out of book" with **Play on vs {engine}** (if configured) and **New Game**. Click **Play on** → engine keeps playing. Reach a checkmate → "Game over 1-0/0-1". **Stop** → back to setup, stats zeroed. Forward/back arrows walk the played line only.

- [ ] **Step 8: Commit**

```bash
git add src/components/boards/BoardTraining.tsx src/translation/en-US.json
git commit -m "feat(training): phase machine — eval gate, probability opponent, out-of-book"
```

---

## Task 8: Hint

Wire the two-stage hint from the eval engine's MultiPV to the board.

**Files:**
- Modify: `src/components/boards/BoardTraining.tsx`

**Interfaces:**
- Consumes: `goodEnoughHints` from `@/utils/training` (Task 1); `lines` / `resultFen` from `useTrainingEngine`; `Board`'s `trainingHintMoves` prop (Task 6).
- Produces: `trainingHintMoves` passed to `<Board>` — recomputed only while `phase === "waiting"`, `resultFen === currentNode.fen`, and `state.priorScore !== undefined`.

- [ ] **Step 1: Compute and pass hint moves**

In `BoardTraining`:

```tsx
  const hintMoves = useMemo(() => {
    if (
      state.phase !== "waiting" ||
      state.priorScore === undefined ||
      resultFen !== currentNode.fen ||
      lines.length === 0
    ) {
      return [];
    }
    return goodEnoughHints(lines, state.priorScore, userIsWhite, cfg);
  }, [state.phase, state.priorScore, resultFen, currentNode.fen, lines, userIsWhite, cfg]);
```

Pass to the board:

```tsx
        <Board
          editingMode={false}
          boardRef={boardRef}
          movable={inSetup ? "turn" : color}
          disableVariations
          training={!inSetup}
          trainingHintMoves={hintMoves}
        />
```

- [ ] **Step 2: Reset hint on position / phase change**

The hint stage must drop to 0 whenever the position changes (a move was played, or the machine advanced). Add:

```tsx
  useEffect(() => {
    setHint({ stage: 0 });
  }, [currentNode.fen, setHint]);
```

(Placed after `startSession`; this also covers Stop/New Game since those change the FEN.)

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 4: Manual smoke**

`pnpm tauri dev` → Train, start a session, wait for "Your move". Press **Hint** (or `h`): green circles appear on every piece that has a good-enough move. Press again: arrows appear, the best move thickest/green, weaker ones thinner and blue/yellow. Press again: back to circles. Play a move: shapes clear. Confirm the circled pieces are exactly those with a move that would *not* be undone (cross-check by playing a non-circled piece's only move — it should snap back).

- [ ] **Step 5: Commit**

```bash
git add src/components/boards/BoardTraining.tsx
git commit -m "feat(training): two-stage engine-backed hint"
```

---

## Task 9: Final polish, full gate, self-review

**Files:**
- Possibly touch any of the above for lint/format fixes.

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all pass, including `src/utils/tests/training.test.ts`.

- [ ] **Step 2: CI gate**

Run: `pnpm lint:ci` (tsc + oxfmt --check + oxlint)
Expected: clean. If oxfmt complains, run `pnpm format` and re-commit.

- [ ] **Step 3: Cross-check against the spec**

Re-read `docs/superpowers/specs/2026-09-06-training-mode-design.md` §1–§9 and confirm each is implemented: new-tab card (T3), tab wiring (T3), atoms (T2), pure module (T1), eval hook (T4), setup screen (T5), phase machine (T7), Board wiring (T6), hint (T8), i18n (T5/T7). Note any gap and add a follow-up task.

- [ ] **Step 4: Manual regression on neighbouring features**

`pnpm tauri dev`: open a Puzzles tab (via the new secondary button) — unchanged. Open an Analysis tab and a Play tab — unchanged. Open a repertoire and its Play sub-tab — unchanged (shared `Board.tsx` still behaves; the `training` prop is absent so all new branches are inert).

- [ ] **Step 5: Commit any fixups**

```bash
git add -A
git commit -m "chore(training): lint/format/polish"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
| --- | --- |
| §1 New-tab home (Training card, two buttons) | Task 3 Step 5 |
| §2 Tab wiring (tabs.ts, BoardsPage, BoardTab) | Task 3 Steps 1,3,4 |
| §3 State atoms | Task 2 |
| §4 Pure module `training.ts` | Task 1 |
| §5 Eval engine hook | Task 4 |
| §6 Orchestration / phase machine / flow functions | Tasks 5 (setup) + 7 (play) |
| §7 Board wiring (`training` prop, makeMove branch, lock, hint shapes) | Task 6 |
| §8 i18n keys | Task 5 Step 2 + Task 7 Step 5 |
| §9 Tests | Task 1 Steps 1–4 |
| Threshold rule (user's exact examples) | Task 1 test cases |
| Out-of-book: New Game *or* weak engine | Task 7 Step 3 (`outOfBook` panel) + `pickEngineOpponentMove` |
| Hint: circles → ranked arrows | Task 6 Step 4 + Task 8 |

No gaps.

**2. Placeholder scan** — every code step has real code. The one deliberate deferral in the spec (exact POV/negation) is now resolved concretely: `scoreToCp(score, userIsWhite)` with **no** negation on either side, because backend scores are White-POV and turn-independent (Global Constraints + Task 1 tests pin it).

**3. Type consistency**
- `TrainingState` fields (`phase`, `fen`, `path`, `priorScore`, `checkParent`, `engineOpponentActive`, `result`) — defined Task 2, used identically in Tasks 5–8.
- `HintMove` (`uci`, `from`, `to`, `cp`, `rank`, `brush`, `lineWidth`) — defined Task 1, consumed in Task 6 Step 4 and Task 8.
- `useTrainingEngine` return `{ engine, lines, resultFen }` — defined Task 4, destructured the same way in Tasks 5, 7, 8.
- `ThresholdConfig` (`maxLossPawns`, `maxLossPct`) — Task 1, built in Task 7 Step 1 from `trainingMaxLossPawnsAtom` / `trainingMaxLossPctAtom` (Task 2).
- `commands.getBestMoves(id, path, tab, goMode, { fen, moves, extraOptions })` — signature matches `useLiveCoachEngine.ts` usage.
- Tree store methods `appendMove` / `goToMove` / `deleteMove` / `setFen` / `setHeaders` / `setScore` / `setPracticePath` — all verified present in `src/state/store/tree.ts`.

---

## Execution Handoff

Choose after the plan is reviewed — see the skill's handoff options (subagent-driven vs inline).
