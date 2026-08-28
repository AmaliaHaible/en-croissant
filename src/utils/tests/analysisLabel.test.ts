import { expect, test } from "vitest";
import { buildAnalysisLabel } from "../analysisLabel";

test("formats a depth-based analysis", () => {
    expect(buildAnalysisLabel("Stockfish 16", { t: "Depth", c: 20 }, new Date(2026, 7, 28))).toBe(
        "Stockfish 16, depth 20 — 2026-08-28",
    );
});

test("formats a time-based analysis", () => {
    expect(buildAnalysisLabel("Stockfish 16", { t: "Time", c: 500 }, new Date(2026, 7, 28))).toBe(
        "Stockfish 16, 500ms per move — 2026-08-28",
    );
});

test("formats a nodes-based analysis", () => {
    expect(
        buildAnalysisLabel("Stockfish 16", { t: "Nodes", c: 1000000 }, new Date(2026, 7, 28)),
    ).toBe("Stockfish 16, 1000000 nodes — 2026-08-28");
});

test("falls back to just the engine name for unrecognized go modes", () => {
    expect(buildAnalysisLabel("Stockfish 16", { t: "Infinite" }, new Date(2026, 7, 28))).toBe(
        "Stockfish 16 — 2026-08-28",
    );
});
