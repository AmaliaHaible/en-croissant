import { makeFen, parseFen } from "chessops/fen";
import { getChesscomGame } from "./chess.com/api";
import { chessopsError } from "./chessops";
import { getLichessGame } from "./lichess/api";

export type FenParseResult = { ok: true; parsedFen: string } | { ok: false; error: string };

export function parseFenInput(fen: string): FenParseResult {
    const res = parseFen(fen.trim());
    if (res.isErr) {
        return { ok: false, error: chessopsError(res.error) };
    }
    return { ok: true, parsedFen: makeFen(res.value) };
}

export async function resolveGameLink(link: string): Promise<string | null> {
    if (link.includes("chess.com")) {
        return await getChesscomGame(link);
    }
    if (link.includes("lichess")) {
        const excludedPathParts = ["game", "export", "white", "black"];
        const gameId = new URL(link).pathname
            .split("/")
            .find((x) => x && !excludedPathParts.includes(x));
        if (!gameId) {
            return null;
        }
        return await getLichessGame(gameId);
    }
    return null;
}
