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
