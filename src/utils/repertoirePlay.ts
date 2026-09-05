import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { positionFromFen } from "./chessops";
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
export function matchUserMove(root: TreeNode, currentPath: number[], san: string): UserMoveResult {
    const node = getNodeAtPath(root, currentPath);
    const idx = node.children.findIndex((c) => c.san === san);
    if (idx !== -1) {
        return { ok: true, nextPath: resolvePointer(root, [...currentPath, idx]) };
    }
    const fen = fenAfterSan(node.fen, san);
    if (fen) {
        const transposed = findNode(root, fen, { requireChildren: true }) ?? findNode(root, fen);
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
    const weights = node.children.map((c) => Math.max(gamesBySan.get(c.san ?? "") ?? 0, EPSILON));
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
