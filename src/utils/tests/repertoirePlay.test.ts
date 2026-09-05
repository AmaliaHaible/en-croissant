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
