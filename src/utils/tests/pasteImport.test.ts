import { expect, test } from "vitest";
import { detectPasteType } from "../pasteImport";

test("detects a plain FEN string", () => {
    expect(detectPasteType("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBe("fen");
});

test("detects a chess.com game link", () => {
    expect(detectPasteType("https://www.chess.com/game/live/12345678")).toBe("link");
});

test("detects a lichess game link", () => {
    expect(detectPasteType("https://lichess.org/abcd1234")).toBe("link");
});

test("falls back to pgn for anything else", () => {
    const pgn = `[Event "Casual Game"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 2. Nf3 *`;
    expect(detectPasteType(pgn)).toBe("pgn");
});
