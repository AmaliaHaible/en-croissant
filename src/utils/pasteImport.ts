import { parseFenInput } from "./importGame";

export type PasteType = "fen" | "link" | "pgn";

export function detectPasteType(text: string): PasteType {
    const trimmed = text.trim();
    if (parseFenInput(trimmed).ok) {
        return "fen";
    }
    if (trimmed.includes("chess.com") || trimmed.includes("lichess")) {
        return "link";
    }
    return "pgn";
}
