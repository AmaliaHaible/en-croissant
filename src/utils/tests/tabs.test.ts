import { expect, test } from "vitest";
import { mergeAnalysisLabel, resolveAnalysisLabel } from "../tabs";
import type { GameHeaders } from "../treeReducer";

const baseHeaders: GameHeaders = {
    id: 0,
    fen: "startpos",
    event: "?",
    site: "?",
    white: "?",
    black: "?",
    result: "*",
};

test("mergeAnalysisLabel adds the label into headers.other", () => {
    const merged = mergeAnalysisLabel(baseHeaders, "Stockfish 16, depth 20 — 2026-08-29");
    expect(merged.other?.Analysis).toBe("Stockfish 16, depth 20 — 2026-08-29");
});

test("mergeAnalysisLabel preserves existing other headers", () => {
    const headers: GameHeaders = { ...baseHeaders, other: { ECO: "B90" } };
    const merged = mergeAnalysisLabel(headers, "Stockfish 16, depth 20 — 2026-08-29");
    expect(merged.other).toEqual({ ECO: "B90", Analysis: "Stockfish 16, depth 20 — 2026-08-29" });
});

test("mergeAnalysisLabel returns the same headers unchanged when label is null", () => {
    const merged = mergeAnalysisLabel(baseHeaders, null);
    expect(merged).toBe(baseHeaders);
});

test("resolveAnalysisLabel reads the label back out", () => {
    const headers: GameHeaders = {
        ...baseHeaders,
        other: { Analysis: "Stockfish 16 — 2026-08-29" },
    };
    expect(resolveAnalysisLabel(headers)).toBe("Stockfish 16 — 2026-08-29");
});

test("resolveAnalysisLabel returns null when there is no analysis label", () => {
    expect(resolveAnalysisLabel(baseHeaders)).toBeNull();
    expect(resolveAnalysisLabel({ ...baseHeaders, other: { ECO: "B90" } })).toBeNull();
});
