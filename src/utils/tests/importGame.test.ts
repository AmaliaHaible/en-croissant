import { expect, test } from "vitest";
import { parseFenInput } from "../importGame";

test("parses a valid FEN into its normalized form", () => {
    const result = parseFenInput("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    expect(result.ok).toBe(true);
    expect(result.ok && result.parsedFen).toBe(
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    );
});

test("trims surrounding whitespace before parsing", () => {
    const result = parseFenInput("  rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1  ");
    expect(result.ok).toBe(true);
});

test("returns an error for an invalid FEN", () => {
    const result = parseFenInput("not a fen");
    expect(result.ok).toBe(false);
});
