# Repertoire "Play" Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third mode to the repertoire trainer where the user plays their repertoire against a Lichess-frequency-weighted opponent, with silent undo on mistakes, a two-stage hint, and transposition following.

**Architecture:** Play is pure navigation over the existing repertoire move tree — the tree is never mutated. A small pure module (`repertoirePlay.ts`) decides transposition targets, validates the user's move, and picks the opponent's reply from the prepared children weighted by cached Lichess explorer stats. `Board.tsx` intercepts the user's move; a `useEffect` in the new `PracticePlay.tsx` panel drives the opponent and the phase machine. All runtime state is tab-scoped Jotai atoms; nothing is persisted.

**Tech Stack:** React 19 + TypeScript, Jotai (atoms), Zustand (`TreeStateContext` move tree), Mantine 8 UI, chessops (chess rules), vitest (tests), react-i18next. Package manager pnpm.

**Spec:** `docs/superpowers/specs/2026-09-06-repertoire-play-tab-design.md`

## Global Constraints

- Never edit `src/bindings/generated.ts` or `src/routeTree.gen.ts` by hand.
- No backend/Rust changes — the Lichess explorer cache already exists (`searchExplorerMoves` in `src/utils/db.ts`, permanent on-disk cache keyed on the first 4 FEN fields).
- i18n: add new keys **by hand** to `src/translation/en-US.json` only. Do **not** run `pnpm i18n:extract` (it rewrites every catalog).
- Lint/format toolchain is oxc: `pnpm lint` (tsc + oxlint), `pnpm format` (oxfmt). Run `pnpm format` then `pnpm lint` before every commit.
- Frontend tests: `pnpm vitest run <file>` for one file.
- Commit message footer, every commit:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01EppjpYNTnCYJvp3PevFFZ9
  ```
- Follow existing patterns: tab-scoped atoms use `atomFamily` + `tabValue(...)` (see `practiceStateFamily` in `src/state/atoms.ts`); panels live in `src/components/panels/practice/`.
- `TreeNode` shape (from `src/utils/treeReducer.ts`): `{ fen: string; move: Move | null; san: string | null; children: TreeNode[]; score; depth; halfMoves: number; shapes: DrawShape[]; annotations; comment }`. `halfMoves` = plies played to reach the node (0 = white to move at the standard start).

---

## Task 1: Transposition & line-status helpers in `repertoirePlay.ts`

**Files:**
- Create: `src/utils/repertoirePlay.ts`
- Test: `src/utils/tests/repertoirePlay.test.ts`

**Interfaces:**
- Consumes: `getNodeAtPath`, `treeIterator`, `TreeNode` from `src/utils/treeReducer.ts`.
- Produces:
  - `normalizeFen(fen: string): string`
  - `findNode(root: TreeNode, fen: string, opts?: { requireChildren?: boolean }): number[] | null` — shallowest node whose normalized FEN matches; `requireChildren` restricts to nodes with ≥1 child.
  - `resolvePointer(root: TreeNode, candidatePath: number[]): number[]`
  - `lineStatus(node: TreeNode, userColor: "white" | "black"): "continue" | "complete" | "gap"`

- [ ] **Step 1: Write the failing test**

Create `src/utils/tests/repertoirePlay.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { Chess } from "chessops";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { getNodeAtPath, type TreeNode } from "../treeReducer";
import { findNode, lineStatus, normalizeFen, resolvePointer } from "../repertoirePlay";

function mkNode(
  fen: string,
  san: string | null,
  halfMoves: number,
  children: TreeNode[],
): TreeNode {
  return {
    fen,
    move: null,
    san,
    children,
    score: null,
    depth: null,
    halfMoves,
    shapes: [],
    annotations: [],
    comment: "",
  };
}

/** FEN after playing `sans` from the standard start position. */
function fenAfter(sans: string[]): string {
  const pos = Chess.default();
  for (const san of sans) pos.play(parseSan(pos, san)!);
  return makeFen(pos.toSetup());
}

/**
 * White repertoire tree with a real transposition. Both orders reach the same
 * position after 5 plies, ending on a knight move so neither has an en-passant
 * square — placement/side/castling/ep all match, so the normalized FENs are equal
 * (only the halfmove clock, dropped by normalizeFen, differs).
 *   Line A: 1.d4 Nf6 2.c4 e6 3.Nf3 ... (built out with 3...d5)
 *   Line B: 1.d4 e6 2.c4 Nf6 3.Nf3     (leaf)
 */
function transpositionTree(): {
  root: TreeNode;
  lineABuilt: number[]; // Line A's 3.Nf3 node — has a prepared continuation
  lineBLeaf: number[]; // Line B's 3.Nf3 node — a leaf, same position
  lineBBeforeNf3: number[]; // Line B's ...Nf6 node — White to move, plays Nf3
} {
  const aD5 = mkNode(fenAfter(["d4", "Nf6", "c4", "e6", "Nf3", "d5"]), "d5", 6, []);
  const aNf3 = mkNode(fenAfter(["d4", "Nf6", "c4", "e6", "Nf3"]), "Nf3", 5, [aD5]);
  const aE6 = mkNode(fenAfter(["d4", "Nf6", "c4", "e6"]), "e6", 4, [aNf3]);
  const aC4 = mkNode(fenAfter(["d4", "Nf6", "c4"]), "c4", 3, [aE6]);
  const aNf6 = mkNode(fenAfter(["d4", "Nf6"]), "Nf6", 2, [aC4]);
  const aD4 = mkNode(fenAfter(["d4"]), "d4", 1, [aNf6]);

  const bNf3 = mkNode(fenAfter(["d4", "e6", "c4", "Nf6", "Nf3"]), "Nf3", 5, []);
  const bNf6 = mkNode(fenAfter(["d4", "e6", "c4", "Nf6"]), "Nf6", 4, [bNf3]);
  const bC4 = mkNode(fenAfter(["d4", "e6", "c4"]), "c4", 3, [bNf6]);
  const bE6 = mkNode(fenAfter(["d4", "e6"]), "e6", 2, [bC4]);
  const bD4 = mkNode(fenAfter(["d4"]), "d4", 1, [bE6]);

  const root = mkNode(fenAfter([]), null, 0, [aD4, bD4]);
  return {
    root,
    lineABuilt: [0, 0, 0, 0, 0], // aNf3
    lineBLeaf: [1, 0, 0, 0, 0], // bNf3
    lineBBeforeNf3: [1, 0, 0, 0], // bNf6 (White to move)
  };
}

describe("normalizeFen", () => {
  test("keeps placement/side/castling/ep, drops clocks and move number", () => {
    expect(normalizeFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")).toBe(
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3",
    );
  });
});

describe("findNode", () => {
  test("finds the shallowest node with a matching normalized FEN", () => {
    const { root, lineABuilt, lineBLeaf } = transpositionTree();
    const fen = getNodeAtPath(root, lineBLeaf).fen; // Line B leaf, same position as Line A move 3
    // requireChildren picks Line A's node (has continuation), not Line B's leaf.
    expect(findNode(root, fen, { requireChildren: true })).toEqual(lineABuilt);
    // without the constraint, a match is still found.
    expect(findNode(root, fen)).not.toBeNull();
  });

  test("returns null when nothing matches", () => {
    const { root } = transpositionTree();
    expect(findNode(root, fenAfter(["e4", "e5", "Nf3", "Nc6", "Bb5"]))).toBeNull();
  });
});

describe("resolvePointer", () => {
  test("follows a transposition from a leaf into the prepared line", () => {
    const { root, lineABuilt, lineBLeaf } = transpositionTree();
    expect(resolvePointer(root, lineBLeaf)).toEqual(lineABuilt);
  });

  test("keeps the candidate path when it already has children", () => {
    const { root, lineABuilt } = transpositionTree();
    expect(resolvePointer(root, lineABuilt)).toEqual(lineABuilt);
  });

  test("keeps the candidate path when there is no transposition", () => {
    const leaf = mkNode(fenAfter(["e4"]), "e4", 1, []);
    const root = mkNode(fenAfter([]), null, 0, [leaf]);
    expect(resolvePointer(root, [0])).toEqual([0]);
  });
});

describe("lineStatus", () => {
  test("node with children continues", () => {
    const { root, lineABuilt } = transpositionTree();
    expect(lineStatus(getNodeAtPath(root, lineABuilt), "white")).toBe("continue");
  });

  test("leaf with opponent to move is complete", () => {
    // halfMoves 5 → white has just moved, black (opponent) to move.
    const leaf = mkNode(fenAfter(["Nf3", "d5", "d4", "Nf6", "c4"]), "c4", 5, []);
    expect(lineStatus(leaf, "white")).toBe("complete");
  });

  test("leaf with the user to move is a gap", () => {
    // halfMoves 4 → white (user) to move, but no prepared reply.
    const leaf = mkNode(fenAfter(["Nf3", "d5", "d4", "Nf6"]), "Nf6", 4, []);
    expect(lineStatus(leaf, "white")).toBe("gap");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/utils/tests/repertoirePlay.test.ts`
Expected: FAIL — `repertoirePlay.ts` does not exist / imports undefined.

- [ ] **Step 3: Write the implementation**

Create `src/utils/repertoirePlay.ts`:

```ts
import { getNodeAtPath, type TreeNode, treeIterator } from "./treeReducer";

export type LineStatus = "continue" | "complete" | "gap";

/**
 * First four FEN fields — piece placement, side to move, castling rights, en
 * passant target. Mirrors `normalize_fen` in `src-tauri/src/explorer.rs`, so a
 * position reached by a different move order shares both its explorer-cache
 * entry and its transposition key.
 */
export function normalizeFen(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/**
 * Shallowest node in `root`'s subtree whose normalized FEN equals `fen`'s.
 * With `requireChildren`, only nodes that have at least one prepared
 * continuation are considered. Returns the node's path, or null.
 */
export function findNode(
  root: TreeNode,
  fen: string,
  opts: { requireChildren?: boolean } = {},
): number[] | null {
  const target = normalizeFen(fen);
  let best: number[] | null = null;
  for (const { node, position } of treeIterator(root)) {
    if (opts.requireChildren && node.children.length === 0) continue;
    if (normalizeFen(node.fen) !== target) continue;
    if (best === null || position.length < best.length) best = position;
  }
  return best;
}

/**
 * The path we should actually navigate to after a move lands us on
 * `candidatePath`. If that node already has a prepared continuation we stay
 * there; otherwise, if the same position exists elsewhere in the tree with a
 * continuation, we follow that transposition; otherwise we stay put (a leaf).
 */
export function resolvePointer(root: TreeNode, candidatePath: number[]): number[] {
  const candidate = getNodeAtPath(root, candidatePath);
  if (candidate.children.length > 0) return candidatePath;
  return findNode(root, candidate.fen, { requireChildren: true }) ?? candidatePath;
}

/**
 * `continue`  — the node has prepared replies.
 * `complete`  — leaf, and it is the opponent's turn (the user finished their line).
 * `gap`       — leaf, and it is the user's turn (opponent played where the user
 *               has no prepared reply).
 */
export function lineStatus(node: TreeNode, userColor: "white" | "black"): LineStatus {
  if (node.children.length > 0) return "continue";
  const userParity = userColor === "white" ? 0 : 1;
  const userToMove = node.halfMoves % 2 === userParity;
  return userToMove ? "gap" : "complete";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/utils/tests/repertoirePlay.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Format, lint, commit**

```bash
pnpm format
pnpm lint
git add src/utils/repertoirePlay.ts src/utils/tests/repertoirePlay.test.ts
git commit -m "$(cat <<'EOF'
feat(practice): transposition and line-status helpers for Play mode

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EppjpYNTnCYJvp3PevFFZ9
EOF
)"
```

---

## Task 2: User-move validation & opponent-move picker in `repertoirePlay.ts`

**Files:**
- Modify: `src/utils/repertoirePlay.ts`
- Test: `src/utils/tests/repertoirePlay.test.ts` (append)

**Interfaces:**
- Consumes: `resolvePointer`, `findNode` (Task 1); `positionFromFen` from `src/utils/chessops.ts`; `parseSan` from `chessops/san`; `makeFen` from `chessops/fen`.
- Produces:
  - `EPSILON: number` (exported const)
  - `type UserMoveResult = { ok: true; nextPath: number[] } | { ok: false }`
  - `matchUserMove(root: TreeNode, currentPath: number[], san: string): UserMoveResult`
  - `type OpponentPick = { san: string; nextPath: number[] }`
  - `pickOpponentMove(root, currentPath, lichessStats: { move: string; white: number; draw: number; black: number }[], rng?: () => number): OpponentPick | null`

- [ ] **Step 1: Write the failing test**

Append to `src/utils/tests/repertoirePlay.test.ts`:

```ts
import { matchUserMove, pickOpponentMove } from "../repertoirePlay";

describe("matchUserMove", () => {
  test("accepts a direct child and follows the transposition after it", () => {
    const { root, lineBBeforeNf3, lineABuilt } = transpositionTree();
    // At Line B's 1.d4 e6 2.c4 Nf6 node (White to move) the stored child is
    // 3.Nf3, a leaf whose position transposes into the built-out Line A.
    const res = matchUserMove(root, lineBBeforeNf3, "Nf3");
    expect(res.ok).toBe(true);
    expect(res.ok && res.nextPath).toEqual(lineABuilt);
  });

  test("accepts a move that is not a stored child but transposes into a prepared line", () => {
    const { root, lineABuilt, lineBBeforeNf3 } = transpositionTree();
    // Drop Line B's stored 3.Nf3 leaf, so Nf3 is reachable only as a transposition.
    getNodeAtPath(root, lineBBeforeNf3).children = [];
    const res = matchUserMove(root, lineBBeforeNf3, "Nf3");
    expect(res.ok).toBe(true);
    expect(res.ok && res.nextPath).toEqual(lineABuilt);
  });

  test("rejects a move that is neither a child nor a transposition", () => {
    const { root, lineBBeforeNf3 } = transpositionTree();
    expect(matchUserMove(root, lineBBeforeNf3, "e4")).toEqual({ ok: false });
  });
});

describe("pickOpponentMove", () => {
  function twoReplyNode() {
    // node (black to move) with two prepared replies: Nc6 and c5.
    const nc6 = mkNode(fenAfter(["e4", "e5", "Nf3", "Nc6"]), "Nc6", 4, [
      mkNode(fenAfter(["e4", "e5", "Nf3", "Nc6", "Bb5"]), "Bb5", 5, []),
    ]);
    const c5 = mkNode(fenAfter(["e4", "e5", "Nf3", "c5"]), "c5", 4, [
      mkNode(fenAfter(["e4", "e5", "Nf3", "c5", "Bc4"]), "Bc4", 5, []),
    ]);
    const nf3 = mkNode(fenAfter(["e4", "e5", "Nf3"]), "Nf3", 3, [nc6, c5]);
    const e5 = mkNode(fenAfter(["e4", "e5"]), "e5", 2, [nf3]);
    const e4 = mkNode(fenAfter(["e4"]), "e4", 1, [e5]);
    return mkNode(fenAfter([]), null, 0, [e4]);
  }
  const NF3_PATH = [0, 0, 0];
  const stats = [
    { move: "Nc6", white: 90, draw: 0, black: 0 },
    { move: "c5", white: 10, draw: 0, black: 0 },
  ];

  test("returns null when the node has no children", () => {
    const root = twoReplyNode();
    expect(pickOpponentMove(root, [0, 0, 0, 0, 0], stats)).toBeNull();
  });

  test("weighted pick — low rng lands on the frequent move, high rng on the rare one", () => {
    const root = twoReplyNode();
    expect(pickOpponentMove(root, NF3_PATH, stats, () => 0.5)?.san).toBe("Nc6");
    expect(pickOpponentMove(root, NF3_PATH, stats, () => 0.95)?.san).toBe("c5");
  });

  test("a reply Lichess has never seen still gets a small floor and is reachable only at the extreme", () => {
    const root = twoReplyNode();
    const onlyNc6 = [{ move: "Nc6", white: 100, draw: 0, black: 0 }];
    expect(pickOpponentMove(root, NF3_PATH, onlyNc6, () => 0.5)?.san).toBe("Nc6");
    expect(pickOpponentMove(root, NF3_PATH, onlyNc6, () => 0.999)?.san).toBe("c5");
  });

  test("nextPath is resolved through transpositions", () => {
    const root = twoReplyNode();
    const pick = pickOpponentMove(root, NF3_PATH, stats, () => 0.5);
    expect(pick?.nextPath).toEqual([0, 0, 0, 0]); // Nc6 child
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/utils/tests/repertoirePlay.test.ts`
Expected: FAIL — `matchUserMove` / `pickOpponentMove` not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/utils/repertoirePlay.ts` (add the two new imports at the top):

```ts
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { positionFromFen } from "./chessops";
```

```ts
/**
 * Weight floor for a prepared reply the explorer has no games for: keeps the
 * line reachable but rare. All-floored weights collapse to a uniform pick.
 */
export const EPSILON = 0.5;

export type UserMoveResult = { ok: true; nextPath: number[] } | { ok: false };

/** FEN after playing SAN `san` from `fen`, or null if illegal / unparseable. */
function fenAfterSan(fen: string, san: string): string | null {
  const [pos] = positionFromFen(fen);
  if (!pos) return null;
  const move = parseSan(pos, san);
  if (!move) return null;
  pos.play(move);
  return makeFen(pos.toSetup());
}

/**
 * Is `san` a prepared continuation from the node at `currentPath`?
 *   1. a direct child → follow it (through any transposition);
 *   2. else, if the resulting position exists elsewhere in the tree — first a
 *      node with a continuation, then any node — follow that transposition;
 *   3. else it is a mistake.
 */
export function matchUserMove(
  root: TreeNode,
  currentPath: number[],
  san: string,
): UserMoveResult {
  const node = getNodeAtPath(root, currentPath);
  const idx = node.children.findIndex((c) => c.san === san);
  if (idx !== -1) {
    return { ok: true, nextPath: resolvePointer(root, [...currentPath, idx]) };
  }
  const fen = fenAfterSan(node.fen, san);
  if (fen) {
    const transposed =
      findNode(root, fen, { requireChildren: true }) ?? findNode(root, fen);
    if (transposed) return { ok: true, nextPath: transposed };
  }
  return { ok: false };
}

export type OpponentPick = { san: string; nextPath: number[] };

/**
 * Pick the opponent's reply from the prepared children of the node at
 * `currentPath`, weighted by the Lichess game count for each child's SAN
 * (floored to `EPSILON`). `rng` returns a value in [0, 1); injected for tests.
 * Returns null only when the node has no children.
 */
export function pickOpponentMove(
  root: TreeNode,
  currentPath: number[],
  lichessStats: { move: string; white: number; draw: number; black: number }[],
  rng: () => number = Math.random,
): OpponentPick | null {
  const node = getNodeAtPath(root, currentPath);
  if (node.children.length === 0) return null;

  const gamesBySan = new Map(
    lichessStats
      .filter((s) => s.move !== "*")
      .map((s) => [s.move, s.white + s.draw + s.black] as const),
  );
  const weights = node.children.map((c) =>
    Math.max(gamesBySan.get(c.san ?? "") ?? 0, EPSILON),
  );
  const total = weights.reduce((a, b) => a + b, 0);

  let r = rng() * total;
  let idx = weights.length - 1;
  for (let i = 0; i < weights.length; i++) {
    if (r < weights[i]) {
      idx = i;
      break;
    }
    r -= weights[i];
  }

  return {
    san: node.children[idx].san ?? "",
    nextPath: resolvePointer(root, [...currentPath, idx]),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/utils/tests/repertoirePlay.test.ts`
Expected: PASS (all cases, Task 1 + Task 2).

- [ ] **Step 5: Format, lint, commit**

```bash
pnpm format
pnpm lint
git add src/utils/repertoirePlay.ts src/utils/tests/repertoirePlay.test.ts
git commit -m "$(cat <<'EOF'
feat(practice): user-move validation and opponent picker for Play mode

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EppjpYNTnCYJvp3PevFFZ9
EOF
)"
```

---

## Task 3: Play-mode atoms in `src/state/atoms.ts`

**Files:**
- Modify: `src/state/atoms.ts` (add after the practice atoms block, which ends near the `practiceCardStartTimeFamily` / `practiceCardStartTimeAtom` lines ~665-666)

**Interfaces:**
- Consumes: `atomFamily`, `atom`, `atomWithStorage`, `tabValue` — all already imported/defined in the file (see `practiceStateFamily` immediately above for the exact pattern).
- Produces:
  - `type PlayPhase = "idle" | "opponentThinking" | "waiting" | "lineComplete" | "gap"`
  - `type PlayState = { phase: PlayPhase }`
  - `playStateAtom` (tab-scoped, default `{ phase: "idle" }`)
  - `type PlayHint = { stage: 0 | 1 | 2 }`
  - `playHintAtom` (tab-scoped, default `{ stage: 0 }`)
  - `type PlaySessionStats = { linesCompleted: number; mistakes: number }`
  - `playSessionStatsAtom` (tab-scoped, default `{ linesCompleted: 0, mistakes: 0 }`)
  - `repertoirePlaySourceAtom` (`atomWithStorage<"lichess" | "masters">`, key `"repertoire-play-source"`, default `"lichess"`)

- [ ] **Step 1: Add the atoms**

Insert into `src/state/atoms.ts` directly after the line `export const practiceCardStartTimeAtom = tabValue(practiceCardStartTimeFamily);`:

```ts
// Repertoire "Play" mode — ephemeral, per-tab. Nothing here is persisted except
// the opponent-source preference.

export type PlayPhase = "idle" | "opponentThinking" | "waiting" | "lineComplete" | "gap";
export type PlayState = { phase: PlayPhase };

const playStateFamily = atomFamily((_tab: string) => atom<PlayState>({ phase: "idle" }));
export const playStateAtom = tabValue(playStateFamily);

export type PlayHint = { stage: 0 | 1 | 2 };

const playHintFamily = atomFamily((_tab: string) => atom<PlayHint>({ stage: 0 }));
export const playHintAtom = tabValue(playHintFamily);

export type PlaySessionStats = { linesCompleted: number; mistakes: number };

const playSessionStatsFamily = atomFamily((_tab: string) =>
    atom<PlaySessionStats>({ linesCompleted: 0, mistakes: 0 }),
);
export const playSessionStatsAtom = tabValue(playSessionStatsFamily);

export const repertoirePlaySourceAtom = atomWithStorage<"lichess" | "masters">(
    "repertoire-play-source",
    "lichess",
);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm lint`
Expected: PASS (no type errors, no unused-symbol warnings — the atoms are consumed in Tasks 4 and 5; if oxlint flags them as unused, that resolves once those tasks land, but `pnpm lint` here should still pass since exports are not flagged unused).

- [ ] **Step 3: Format, commit**

```bash
pnpm format
git add src/state/atoms.ts
git commit -m "$(cat <<'EOF'
feat(state): atoms for repertoire Play mode

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EppjpYNTnCYJvp3PevFFZ9
EOF
)"
```

---

## Task 4: Wire `playing` through `Board.tsx` and `BoardAnalysis.tsx`

**Files:**
- Modify: `src/components/boards/Board.tsx`
- Modify: `src/components/boards/BoardAnalysis.tsx`

**Interfaces:**
- Consumes: `matchUserMove` from `src/utils/repertoirePlay.ts`; `playStateAtom`, `playHintAtom`, `playSessionStatsAtom` from `src/state/atoms.ts`.
- Produces: `<Board>` accepts a `playing?: boolean` prop. While `playing`, a valid user move navigates the tree (`goToMove`) and an invalid one is silently discarded and bumps `playSessionStatsAtom.mistakes`; the board is locked whenever `playStateAtom.phase !== "waiting"`; a green square-marker (hint stage 1) or arrow (hint stage ≥ 2) is drawn for the first prepared child.

There is no unit test for `Board.tsx` in this codebase; verification is `pnpm lint` plus the manual pass in Task 6.

- [ ] **Step 1: `Board.tsx` — add the prop**

In `interface ChessboardProps` (near line 95), add after `practicing?: boolean;`:

```ts
  playing?: boolean;
```

In the `function Board({ ... })` destructure (near line 111), add `playing,` after `practicing,`.

- [ ] **Step 2: `Board.tsx` — store selectors and atom hooks**

After the existing store selectors (near line 152, after `const setFen = useStore(store, (s) => s.setFen);`), add:

```ts
  const position = useStore(store, (s) => s.position);
  const goToMove = useStore(store, (s) => s.goToMove);
```

After the practice atom hooks (near line 210, after `const cardStartTime = useAtomValue(practiceCardStartTimeAtom);`), add:

```ts
  const playState = useAtomValue(playStateAtom);
  const setPlaySessionStats = useSetAtom(playSessionStatsAtom);
  const playHint = useAtomValue(playHintAtom);
```

Add the imports: in the `@/state/atoms` import block add `playStateAtom`, `playHintAtom`, `playSessionStatsAtom`; add `import { matchUserMove } from "@/utils/repertoirePlay";` alongside the other `@/utils/*` imports. Ensure `useAtomValue` and `useSetAtom` are in the `jotai` import (they are already used in this file).

- [ ] **Step 3: `Board.tsx` — intercept the move**

In `async function makeMove(move: NormalMove)` (near line 212), immediately after `const san = makeSan(pos, move);` and **before** `if (practicing) {`, insert:

```ts
    if (playing) {
      if (playState.phase !== "waiting") {
        setPendingMove(null);
        return;
      }
      const res = matchUserMove(root, position, san);
      if (!res.ok) {
        // Silent undo: never commit the move, just let the board re-render from
        // the unchanged FEN. The hint is the only feedback offered.
        setPendingMove(null);
        setPlaySessionStats((s) => ({ ...s, mistakes: s.mistakes + 1 }));
        return;
      }
      setPendingMove(null);
      goToMove(res.nextPath);
      // The phase transition is driven by the PracticePlay effect watching the
      // pointer position.
      return;
    }
```

- [ ] **Step 4: `Board.tsx` — lock the board off-turn**

Find `const practiceLock = !!practicing && !deck.positions.find((c) => c.fen === currentNode.fen);` (near line 388). Directly after it add:

```ts
  const playLock = !!playing && playState.phase !== "waiting";
```

In the `movableColor` `useMemo` immediately below, change `return practiceLock` to `return practiceLock || playLock`, and add `playLock` to the dependency array.

- [ ] **Step 5: `Board.tsx` — draw the hint**

Find the block (near line 377):

```ts
  if (currentNode.shapes.length > 0) {
    shapes = shapes.concat(currentNode.shapes);
  }
```

Directly after it add:

```ts
  if (playing && playHint.stage > 0 && currentNode.children[0]?.move) {
    const hm = currentNode.children[0].move as NormalMove;
    const from = makeSquare(hm.from);
    const to = makeSquare(hm.to);
    if (from && playHint.stage === 1) {
      shapes.push({ orig: from, brush: "green" });
    }
    if (from && to && playHint.stage >= 2) {
      shapes.push({ orig: from, dest: to, brush: "green" });
    }
  }
```

(`makeSquare` and `NormalMove` are already imported and used in this file — see the variation-arrow block just above.)

- [ ] **Step 6: `BoardAnalysis.tsx` — derive and pass `playing`**

Find `const practicing = currentTabSelected === "practice" && practiceTabSelected === "train";` (near line 185). After it add:

```ts
  const playing = currentTabSelected === "practice" && practiceTabSelected === "play";
```

Find `<Board` (near line 236) and add the prop next to `practicing={practicing}`:

```ts
          playing={playing}
```

- [ ] **Step 7: `BoardAnalysis.tsx` — reset play state on leaving the mode**

Add to the `@/state/atoms` import: `playStateAtom`, `playHintAtom`. Near the existing effect:

```ts
  const setPracticePath = useStore(store, (s) => s.setPracticePath);
  useEffect(() => {
    if (!practicing) {
      setPracticePath(null);
    }
  }, [practicing, setPracticePath]);
```

add, directly below it:

```ts
  const setPlayState = useSetAtom(playStateAtom);
  const setPlayHint = useSetAtom(playHintAtom);
  useEffect(() => {
    if (!playing) {
      setPlayState({ phase: "idle" });
      setPlayHint({ stage: 0 });
    }
  }, [playing, setPlayState, setPlayHint]);
```

Ensure `useSetAtom` is in the `jotai` import in this file (add it if missing).

- [ ] **Step 8: Typecheck / lint**

Run: `pnpm format && pnpm lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/components/boards/Board.tsx src/components/boards/BoardAnalysis.tsx
git commit -m "$(cat <<'EOF'
feat(practice): wire Play mode through the board

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EppjpYNTnCYJvp3PevFFZ9
EOF
)"
```

---

## Task 5: `PracticePlay.tsx` panel and phase machine + i18n keys

**Files:**
- Create: `src/components/panels/practice/PracticePlay.tsx`
- Modify: `src/translation/en-US.json`

**Interfaces:**
- Consumes: `playStateAtom`, `playHintAtom`, `playSessionStatsAtom`, `repertoirePlaySourceAtom`, `currentInvisibleAtom`, `currentPracticeTabAtom`, `sessionsAtom`, `currentTabAtom` from `src/state/atoms.ts`; `lineStatus`, `pickOpponentMove` from `src/utils/repertoirePlay.ts`; `searchExplorerMoves` from `src/utils/db.ts`; `getNodeAtPath` from `src/utils/treeReducer.ts`; `TreeStateContext` from `src/components/common/TreeStateContext`.
- Produces: `export default function PracticePlay()` — rendered by Task 6 in the new `play` tab panel.

- [ ] **Step 1: Add i18n keys**

In `src/translation/en-US.json`, add these keys inside the `Board.Practice.` group, keeping the file's alphabetical ordering (they sort between `Board.Practice.PickMovePrompt` and `Board.Practice.Practiced`):

```json
    "Board.Practice.Play": "Play",
    "Board.Practice.Play.GoToBuild": "Add a reply in Build",
    "Board.Practice.Play.Hint": "Hint",
    "Board.Practice.Play.LineComplete": "Line complete",
    "Board.Practice.Play.LinesCompleted": "Lines completed",
    "Board.Practice.Play.Mistakes": "Mistakes",
    "Board.Practice.Play.NeedMoves": "Add moves to this repertoire in Build first.",
    "Board.Practice.Play.NewGame": "New game",
    "Board.Practice.Play.OpponentThinking": "Opponent is thinking…",
    "Board.Practice.Play.OutOfBook": "You're out of book — no prepared reply here.",
    "Board.Practice.Play.ShowArrow": "Show arrow",
    "Board.Practice.Play.Source": "Opponent source",
    "Board.Practice.Play.StartPlaying": "Start playing",
    "Board.Practice.Play.YourMove": "Your move",
```

- [ ] **Step 2: Create the panel**

Create `src/components/panels/practice/PracticePlay.tsx`:

```tsx
import { Alert, Badge, Button, Group, Loader, Paper, SegmentedControl, SimpleGrid, Stack, Text, ThemeIcon } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { IconCheck, IconInfoCircle } from "@tabler/icons-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useContext, useEffect, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  currentInvisibleAtom,
  currentPracticeTabAtom,
  playHintAtom,
  playSessionStatsAtom,
  playStateAtom,
  repertoirePlaySourceAtom,
  sessionsAtom,
} from "@/state/atoms";
import { searchExplorerMoves } from "@/utils/db";
import { lineStatus, pickOpponentMove } from "@/utils/repertoirePlay";
import { getNodeAtPath } from "@/utils/treeReducer";

const OPPONENT_DELAY_MS = 400;

export default function PracticePlay() {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const headers = useStore(store, (s) => s.headers);
  const goToMove = useStore(store, (s) => s.goToMove);
  const currentNode = useStore(store, (s) => s.currentNode());

  const [playState, setPlayState] = useAtom(playStateAtom);
  const [hint, setHint] = useAtom(playHintAtom);
  const [stats, setStats] = useAtom(playSessionStatsAtom);
  const [source, setSource] = useAtom(repertoirePlaySourceAtom);
  const setInvisible = useSetAtom(currentInvisibleAtom);
  const setTab = useSetAtom(currentPracticeTabAtom);
  const sessions = useAtomValue(sessionsAtom);

  const token = sessions.find((s) => s.lichess?.accessToken)?.lichess?.accessToken ?? null;
  const userColor = headers.orientation || "white";
  const startPath = headers.start ?? [];
  const userParity = userColor === "white" ? 0 : 1;

  const phase = playState.phase;
  const positionKey = position.join(",");
  const currentFenRef = useRef(currentNode.fen);
  currentFenRef.current = currentNode.fen;

  const finish = useCallback(
    (status: "complete" | "gap") => {
      setInvisible(false);
      setHint({ stage: 0 });
      setPlayState({ phase: status === "gap" ? "gap" : "lineComplete" });
      if (status === "complete") {
        setStats((s) => ({ ...s, linesCompleted: s.linesCompleted + 1 }));
      }
    },
    [setInvisible, setHint, setPlayState, setStats],
  );

  const startGame = useCallback(() => {
    setHint({ stage: 0 });
    setInvisible(true);
    goToMove(startPath);
    const node = getNodeAtPath(root, startPath);
    const status = lineStatus(node, userColor);
    if (status !== "continue") {
      finish(status);
      return;
    }
    const userToMove = node.halfMoves % 2 === userParity;
    setPlayState({ phase: userToMove ? "waiting" : "opponentThinking" });
  }, [root, startPath, userColor, userParity, setHint, setInvisible, goToMove, setPlayState, finish]);

  const stopGame = useCallback(() => {
    setPlayState({ phase: "idle" });
    setHint({ stage: 0 });
    setInvisible(false);
    setStats({ linesCompleted: 0, mistakes: 0 });
  }, [setPlayState, setHint, setInvisible, setStats]);

  // The user just played a valid move (Board navigated the pointer). React to
  // where the pointer landed.
  useEffect(() => {
    if (phase !== "waiting") return;
    const userToMove = currentNode.halfMoves % 2 === userParity;
    if (userToMove) return; // still the user's turn — nothing happened yet
    setHint({ stage: 0 });
    const status = lineStatus(currentNode, userColor);
    if (status === "continue") {
      setPlayState({ phase: "opponentThinking" });
    } else {
      finish(status);
    }
  }, [phase, positionKey, currentNode, userColor, userParity, setHint, setPlayState, finish]);

  // Opponent's turn: fetch cached Lichess stats, pick a reply, navigate.
  useEffect(() => {
    if (phase !== "opponentThinking") return;
    const fenAtStart = currentNode.fen;
    const pathAtStart = position;
    let cancelled = false;

    (async () => {
      const [statsForFen] = await searchExplorerMoves(source, [fenAtStart], token);
      if (cancelled || currentFenRef.current !== fenAtStart) return;
      const pick = pickOpponentMove(root, pathAtStart, statsForFen ?? []);
      await new Promise((r) => setTimeout(r, OPPONENT_DELAY_MS));
      if (cancelled || currentFenRef.current !== fenAtStart) return;

      if (!pick) {
        finish(lineStatus(getNodeAtPath(root, pathAtStart), userColor) === "gap" ? "gap" : "complete");
        return;
      }
      goToMove(pick.nextPath);
      setHint({ stage: 0 });
      const status = lineStatus(getNodeAtPath(root, pick.nextPath), userColor);
      if (status === "continue") {
        setPlayState({ phase: "waiting" });
      } else {
        finish(status);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, positionKey, source, token, root, position, currentNode.fen, userColor, goToMove, setHint, setPlayState, finish]);

  // Keep the notation un-blurred whenever we are not mid-game.
  useEffect(() => {
    if (phase === "idle") setInvisible(false);
  }, [phase, setInvisible]);

  const cycleHint = useCallback(() => {
    setHint((h) => ({ stage: h.stage === 0 ? 1 : h.stage === 1 ? 2 : 1 }));
  }, [setHint]);

  useHotkeys("h", () => cycleHint(), { enabled: phase === "waiting" });

  const isRepertoireEmpty = root.children.length === 0;

  if (!token) {
    return (
      <Stack p="sm">
        <Alert icon={<IconInfoCircle />} color="yellow">
          {t("Board.Database.ExplorerAuthRequired1")}{" "}
          <Link to="/accounts">{t("Board.Database.ExplorerAuthRequired.Accounts")}</Link>{" "}
          {t("Board.Database.ExplorerAuthRequired2")}
        </Alert>
      </Stack>
    );
  }

  if (isRepertoireEmpty) {
    return (
      <Stack p="sm">
        <Alert icon={<IconInfoCircle />}>
          <Stack gap="xs">
            <Text fz="sm">{t("Board.Practice.Play.NeedMoves")}</Text>
            <Button variant="light" size="xs" onClick={() => setTab("build")}>
              {t("Board.Practice.GoToBuild")}
            </Button>
          </Stack>
        </Alert>
      </Stack>
    );
  }

  return (
    <Stack p="sm" gap="md">
      <Group justify="space-between" wrap="nowrap">
        <Text fz="xs" c="dimmed">
          {t("Board.Practice.Play.Source")}
        </Text>
        <SegmentedControl
          size="xs"
          value={source}
          onChange={(v) => setSource(v as "lichess" | "masters")}
          data={[
            { value: "lichess", label: t("Board.Practice.Build.SourceLichess") },
            { value: "masters", label: t("Board.Practice.Build.SourceLichessMasters") },
          ]}
        />
      </Group>

      <SimpleGrid cols={2} spacing="xs">
        <Paper p="xs" withBorder radius="sm">
          <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
            {t("Board.Practice.Play.LinesCompleted")}
          </Text>
          <Text fz="lg" fw={700} c="green">
            {stats.linesCompleted}
          </Text>
        </Paper>
        <Paper p="xs" withBorder radius="sm">
          <Text fz={10} tt="uppercase" c="dimmed" fw={600}>
            {t("Board.Practice.Play.Mistakes")}
          </Text>
          <Text fz="lg" fw={700} c="red">
            {stats.mistakes}
          </Text>
        </Paper>
      </SimpleGrid>

      {phase === "idle" && (
        <Button size="md" variant="light" fullWidth onClick={startGame}>
          {t("Board.Practice.Play.StartPlaying")}
        </Button>
      )}

      {phase === "opponentThinking" && (
        <Paper p="sm" withBorder>
          <Group gap="xs" justify="center">
            <Loader size="xs" />
            <Text fz="sm" c="dimmed">
              {t("Board.Practice.Play.OpponentThinking")}
            </Text>
          </Group>
        </Paper>
      )}

      {phase === "waiting" && (
        <Paper p="sm" withBorder>
          <Stack gap="xs" align="center">
            <Text fz="sm" c="dimmed">
              {t("Board.Practice.Play.YourMove")}
            </Text>
            <Button variant="light" size="sm" fullWidth onClick={cycleHint}>
              {hint.stage === 1
                ? t("Board.Practice.Play.ShowArrow")
                : t("Board.Practice.Play.Hint")}
            </Button>
            <Button variant="subtle" size="compact-xs" color="red" onClick={stopGame}>
              {t("Common.Stop")}
            </Button>
          </Stack>
        </Paper>
      )}

      {phase === "lineComplete" && (
        <Paper p="sm" withBorder>
          <Stack gap="xs" align="center">
            <ThemeIcon size="xl" radius="xl" color="green" variant="light">
              <IconCheck size={24} />
            </ThemeIcon>
            <Text fw={500}>{t("Board.Practice.Play.LineComplete")}</Text>
            <Button variant="light" size="sm" fullWidth onClick={startGame}>
              {t("Board.Practice.Play.NewGame")}
            </Button>
          </Stack>
        </Paper>
      )}

      {phase === "gap" && (
        <Paper p="sm" withBorder>
          <Stack gap="xs" align="center">
            <Text fz="sm" c="dimmed" ta="center">
              {t("Board.Practice.Play.OutOfBook")}
            </Text>
            <Button
              variant="subtle"
              size="xs"
              onClick={() => setTab("build")}
            >
              {t("Board.Practice.Play.GoToBuild")}
            </Button>
            <Button variant="light" size="sm" fullWidth onClick={startGame}>
              {t("Board.Practice.Play.NewGame")}
            </Button>
          </Stack>
        </Paper>
      )}

      <Badge variant="light" color="gray" style={{ alignSelf: "flex-start" }}>
        {userColor === "white" ? t("Chess.White") : t("Chess.Black")}
      </Badge>
    </Stack>
  );
}
```

Notes for the implementer:
- If any `t("...")` key referenced above for reuse (`Board.Database.ExplorerAuthRequired*`, `Board.Practice.Build.SourceLichess`, `Board.Practice.Build.SourceLichessMasters`, `Board.Practice.GoToBuild`, `Common.Stop`, `Chess.White`, `Chess.Black`) is absent from `en-US.json`, grep for the closest existing key and use that instead — do not invent new ones beyond Step 1's list. `Board.Database.ExplorerAuthRequired1/2/.Accounts` and `Board.Practice.Build.SourceLichess*` are used verbatim by `RepertoireInfo.tsx`, so they exist.
- `sessionsAtom` is the same atom `RepertoireInfo.tsx` reads for `explorerToken`; match that access pattern exactly.

- [ ] **Step 3: Typecheck / lint**

Run: `pnpm format && pnpm lint`
Expected: PASS. Fix any missing-key or import errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/panels/practice/PracticePlay.tsx src/translation/en-US.json
git commit -m "$(cat <<'EOF'
feat(practice): Play panel and phase machine

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EppjpYNTnCYJvp3PevFFZ9
EOF
)"
```

---

## Task 6: Add the `play` tab to `PracticePanel.tsx` + end-to-end verification

**Files:**
- Modify: `src/components/panels/practice/PracticePanel.tsx`

**Interfaces:**
- Consumes: `PracticePlay` default export from Task 5.
- Produces: the third vertical tab in the repertoire practice panel.

- [ ] **Step 1: Import and render the tab**

In `src/components/panels/practice/PracticePanel.tsx`:

Add the import near `import RepertoireInfo from "./RepertoireInfo";`:

```ts
import PracticePlay from "./PracticePlay";
```

In the `<Tabs.List>` (near line 317), after the `build` tab:

```tsx
        <Tabs.Tab value="play">{t("Board.Practice.Play")}</Tabs.Tab>
```

After the `build` `<Tabs.Panel>` (near line 628-630):

```tsx
        <Tabs.Panel value="play" style={{ overflow: "hidden" }}>
          <PracticePlay />
        </Tabs.Panel>
```

- [ ] **Step 2: Typecheck / lint / full test run**

```bash
pnpm format && pnpm lint
pnpm vitest run src/utils/tests/repertoirePlay.test.ts
```

Expected: PASS.

- [ ] **Step 3: Manual verification**

Run `pnpm tauri dev`. With a repertoire file open (or create one via the "+" → Repertoire), open the board's **Practice** tab, then the **Play** sub-tab. Verify:

1. **No Lichess account** → the auth alert with an `/accounts` link shows; **connect a Lichess account** in `/accounts` if not already (the opening explorer needs any valid token).
2. **Empty repertoire** → "Add moves in Build first" with a working "Go to Build" button.
3. Build at least one line a few moves deep for your repertoire colour, then **Start playing**:
   - The board goes to the Start position, the move list blurs.
   - If you're Black, the opponent plays a first move after ~0.4 s.
   - Play a **prepared** move → it's accepted, the opponent replies within your prepared branch. Opponent replies vary across New Games (frequency-weighted).
   - Play an **unprepared** move → the piece snaps back, no notification, the **Mistakes** counter increments.
   - Click **Hint** once → the source square of your first prepared move gets a green marker. Click again → a green arrow. It clears when you move.
   - Press `h` → cycles the hint the same way.
   - Reach the end of a prepared line → **Line complete**, **Lines completed** increments, only a **New Game** button remains, the move list un-blurs.
4. **Transposition check:** build the same position by two move orders, fully expand only one, and confirm that entering it by the other order continues into the expanded line instead of ending the game.
5. Switch to the **Train**/**Build** tab and back → play state resets to idle; switch board tabs entirely → no stale lock.

- [ ] **Step 4: Commit**

```bash
git add src/components/panels/practice/PracticePanel.tsx
git commit -m "$(cat <<'EOF'
feat(practice): add the Play tab to the repertoire trainer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EppjpYNTnCYJvp3PevFFZ9
EOF
)"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
| --- | --- |
| 1. Placement & gating | Task 4 (BoardAnalysis), Task 6 (PracticePanel tab) |
| 2. `repertoirePlay.ts` — `normalizeFen`, `resolvePointer`, `lineStatus` | Task 1 |
| 2. `repertoirePlay.ts` — `matchUserMove`, `pickOpponentMove`, `EPSILON` | Task 2 |
| 2. `findNode` (spec: "some node in the tree has that normalised FEN") | Task 1 (helper) + Task 2 (used by `matchUserMove`) |
| 3. atoms (`playStateAtom`, `playHintAtom`, `playSessionStatsAtom`, `repertoirePlaySourceAtom`) | Task 3 |
| 4. Flow — New Game / opponentThinking / waiting / lineComplete / gap / Stop | Task 5 (`startGame`, `stopGame`, `finish`, the two effects) |
| 4. `setInvisible(true)` on start, `false` on finish/idle | Task 5 |
| 5. Board — `playing` prop, `makeMove` branch, `playLock`, hint shapes | Task 4 |
| 6. Panel UI — auth gate, empty gate, source control, stats, per-phase blocks, `h` hotkey | Task 5 |
| 7. i18n `Board.Practice.Play.*` by hand | Task 5 Step 1 |
| 8. tests | Task 1 Step 1, Task 2 Step 1 |
| Deferred: opponent limited to direct children; `EPSILON`/`OPPONENT_DELAY_MS` constants; no review step | Honoured — `pickOpponentMove` iterates `node.children` only; both constants are module-level; `finish` just sets the terminal phase |

**2. Placeholder scan** — no TBD/TODO; every code step has full code. The one conditional instruction (Task 5 Step 2 note about missing reuse-keys) names the exact fallback (grep the nearest existing key) rather than leaving it open.

**3. Type consistency**

- `PlayPhase` values `"idle" | "opponentThinking" | "waiting" | "lineComplete" | "gap"` — identical in Task 3, Task 4 (`playState.phase !== "waiting"`), Task 5 (all branches).
- `lineStatus` returns `"continue" | "complete" | "gap"` (Task 1); `finish` in Task 5 takes `"complete" | "gap"` and maps `"complete"` → phase `"lineComplete"`. Consistent.
- `matchUserMove` → `{ ok: true; nextPath: number[] } | { ok: false }` (Task 2); consumed in Task 4 as `res.ok` / `res.nextPath`. Consistent.
- `pickOpponentMove` → `{ san, nextPath } | null` (Task 2); consumed in Task 5 as `pick.nextPath` with a `!pick` guard. Consistent.
- `playHintAtom` value `{ stage: 0 | 1 | 2 }` — Task 3, read in Task 4 (`playHint.stage`), written in Task 5 (`cycleHint`, `setHint({ stage: 0 })`). Consistent.
- `repertoirePlaySourceAtom` union `"lichess" | "masters"` matches `searchExplorerMoves`'s first parameter type (`"lichess" | "masters"` in `src/utils/db.ts`). Consistent.
- `findNode` signature `(root, fen, opts?)` — defined Task 1, used Task 1 (`resolvePointer`) and Task 2 (`matchUserMove`) with the same shape. Consistent.
