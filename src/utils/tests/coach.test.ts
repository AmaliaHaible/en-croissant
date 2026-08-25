import { parseUci } from "chessops";
import { expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import { classifyMove } from "../coach";
import type { ListNode, TreeNode } from "../treeReducer";

// classifyMove only ever compares fens as opaque strings, so synthetic ids keep
// the fixtures readable.
const ROOT_FEN = "fen-0";
const FEN_1 = "fen-1";
const FEN_2 = "fen-2";
const FEN_3 = "fen-3";

function lines(cp: number, san = "Nf3", uci = "g1f3"): BestMoves[] {
    return [
        {
            depth: 20,
            multipv: 1,
            nodes: 1000,
            nps: 1000,
            score: { value: { type: "cp", value: cp }, wdl: null },
            sanMoves: [san],
            uciMoves: [uci],
        },
    ];
}

function node(fen: string, halfMoves: number, san: string | null): TreeNode {
    return {
        fen,
        move: san ? parseUci("e2e4")! : null,
        san,
        children: [],
        score: null,
        depth: null,
        halfMoves,
        shapes: [],
        annotations: [],
        comment: "",
    };
}

/** Main line root -> e4 -> e5 -> Nf3, so the tip is a white move. */
function mainLine(): ListNode[] {
    return [
        { position: [], node: node(ROOT_FEN, 0, null) },
        { position: [0], node: node(FEN_1, 1, "e4") },
        { position: [0, 0], node: node(FEN_2, 2, "e5") },
        { position: [0, 0, 0], node: node(FEN_3, 3, "Nf3") },
    ];
}

/** White was +0.50 before the tip move. */
function cacheWithPrevScores(): Map<string, BestMoves[]> {
    return new Map([
        [ROOT_FEN, lines(20)],
        [FEN_1, lines(30)],
        [FEN_2, lines(50)],
    ]);
}

const bothColors = { white: true, black: true };

test("should classify a blunder on the main line tip", () => {
    const result = classifyMove({
        mainLine: mainLine(),
        finalFen: FEN_3,
        bestLines: lines(-500),
        cache: cacheWithPrevScores(),
        feedbackEnabled: bothColors,
    });

    expect(result).toStrictEqual({
        path: [0, 0, 0],
        fen: FEN_3,
        annotation: "??",
    });
});

test("should not classify a fine move", () => {
    const result = classifyMove({
        mainLine: mainLine(),
        finalFen: FEN_3,
        bestLines: lines(40),
        cache: cacheWithPrevScores(),
        feedbackEnabled: bothColors,
    });

    expect(result).toBeNull();
});

test("should skip a move whose color has feedback disabled", () => {
    const result = classifyMove({
        mainLine: mainLine(),
        finalFen: FEN_3,
        bestLines: lines(-500),
        cache: cacheWithPrevScores(),
        feedbackEnabled: { white: false, black: true },
    });

    expect(result).toBeNull();
});

test("should skip when the analysed position is not the main line tip", () => {
    const result = classifyMove({
        mainLine: mainLine(),
        finalFen: FEN_2,
        bestLines: lines(-500),
        cache: cacheWithPrevScores(),
        feedbackEnabled: bothColors,
    });

    expect(result).toBeNull();
});

test("should skip a position that was already classified", () => {
    const result = classifyMove({
        mainLine: mainLine(),
        finalFen: FEN_3,
        bestLines: lines(-500),
        cache: cacheWithPrevScores(),
        feedbackEnabled: bothColors,
        classifiedFens: new Set([FEN_3]),
    });

    expect(result).toBeNull();
});

test("should classify a black blunder using the black perspective", () => {
    const line = mainLine().slice(0, 3);

    expect(
        classifyMove({
            mainLine: line,
            finalFen: FEN_2,
            bestLines: lines(500),
            cache: cacheWithPrevScores(),
            feedbackEnabled: bothColors,
        }),
    ).toStrictEqual({ path: [0, 0], fen: FEN_2, annotation: "??" });

    expect(
        classifyMove({
            mainLine: line,
            finalFen: FEN_2,
            bestLines: lines(500),
            cache: cacheWithPrevScores(),
            feedbackEnabled: { white: true, black: false },
        }),
    ).toBeNull();
});

test("should skip empty engine output", () => {
    const result = classifyMove({
        mainLine: mainLine(),
        finalFen: FEN_3,
        bestLines: [],
        cache: cacheWithPrevScores(),
        feedbackEnabled: bothColors,
    });

    expect(result).toBeNull();
});
