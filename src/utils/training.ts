import { makeSquare, parseUci } from "chessops";
import type { BestMoves, Score } from "@/bindings";

/** Mate scores are clamped to this many centipawns so a huge swing between two
 *  winning positions can't dominate the drop arithmetic. */
export const MATE_CP = 2000;

/** A backend engine score (always White's POV) → the given player's POV, in
 *  centipawns, with mate clamped to ±MATE_CP. */
export function scoreToCp(score: Score, userIsWhite: boolean): number {
    const whiteCp =
        score.value.type === "cp" ? score.value.value : Math.sign(score.value.value || 1) * MATE_CP;
    const userCp = userIsWhite ? whiteCp : -whiteCp;
    return Math.max(-MATE_CP, Math.min(MATE_CP, userCp));
}

export type ThresholdConfig = { maxLossPawns: number; maxLossPct: number };

/** The largest eval loss (centipawns) still considered "good enough":
 *  max(pawn floor, percentage of the current positive edge). */
export function allowedDrop(priorCp: number, cfg: ThresholdConfig): number {
    const floor = cfg.maxLossPawns * 100;
    const pct = (cfg.maxLossPct / 100) * Math.max(priorCp, 0);
    return Math.max(floor, pct);
}

/** true ⇔ the move is good enough and should NOT be undone. */
export function passesThreshold(priorCp: number, afterCp: number, cfg: ThresholdConfig): boolean {
    return priorCp - afterCp <= allowedDrop(priorCp, cfg);
}

export type ExplorerMoveStat = { move: string; white: number; black: number; draw: number };

const rowWeight = (s: ExplorerMoveStat) => s.white + s.black + s.draw;

export function totalBookGames(stats: ExplorerMoveStat[]): number {
    return stats.filter((s) => s.move !== "*").reduce((a, s) => a + rowWeight(s), 0);
}

/** Weighted sample (by total games) over the non-`*` rows. `rng` in [0, 1),
 *  injected for tests. null when no row has positive weight. */
export function sampleBookMove(
    stats: ExplorerMoveStat[],
    rng: () => number = Math.random,
): string | null {
    const rows = stats.filter((s) => s.move !== "*" && rowWeight(s) > 0);
    if (rows.length === 0) return null;
    const total = rows.reduce((a, s) => a + rowWeight(s), 0);
    let r = rng() * total;
    for (const row of rows) {
        if (r < rowWeight(row)) return row.move;
        r -= rowWeight(row);
    }
    return rows[rows.length - 1].move;
}

export type HintMove = {
    uci: string;
    from: string;
    to: string;
    cp: number;
    rank: number;
    brush: "green" | "blue" | "yellow";
    lineWidth: number;
};

const RANK_STYLE: { brush: HintMove["brush"]; lineWidth: number }[] = [
    { brush: "green", lineWidth: 12 },
    { brush: "green", lineWidth: 8 },
    { brush: "blue", lineWidth: 6 },
];
const RANK_STYLE_TAIL = { brush: "yellow" as const, lineWidth: 4 };

/** Every MultiPV line whose resulting eval is still good enough vs `priorCp`
 *  (best line's cp, user POV), ranked by eval descending and styled by rank. */
export function goodEnoughHints(
    lines: BestMoves[],
    priorCp: number,
    userIsWhite: boolean,
    cfg: ThresholdConfig,
): HintMove[] {
    return lines
        .map((l) => ({ uci: l.uciMoves[0], cp: scoreToCp(l.score, userIsWhite) }))
        .filter((l): l is { uci: string; cp: number } => !!l.uci)
        .filter((l) => passesThreshold(priorCp, l.cp, cfg))
        .sort((a, b) => b.cp - a.cp)
        .map((l, i) => {
            const move = parseUci(l.uci);
            const from = move && "from" in move ? makeSquare(move.from) : "";
            const to = move && "to" in move ? makeSquare(move.to) : "";
            const style = RANK_STYLE[i] ?? RANK_STYLE_TAIL;
            return { uci: l.uci, from, to, cp: l.cp, rank: i + 1, ...style };
        })
        .filter((h) => h.from && h.to);
}
