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
