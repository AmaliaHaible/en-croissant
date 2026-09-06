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
            nodes: 0,
            depth: 0,
            score,
            uciMoves: [uci],
            sanMoves: [],
            multipv: 1,
            nps: 0,
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
        expect(hints[0]).toMatchObject({
            from: "e2",
            to: "e4",
            rank: 1,
            brush: "green",
            lineWidth: 12,
        });
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
