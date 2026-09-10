import { describe, expect, test } from "vitest";
import { createEmptyCard } from "ts-fsrs";
import type { PracticeData } from "@/state/atoms";
import { MAX_REVIEW_LOGS, updateCardPerformance } from "../opening";

function deckWithLogs(logCount: number): PracticeData {
    return {
        positions: [{ fen: "startpos", answer: "e4", card: createEmptyCard() }],
        logs: Array.from(
            { length: logCount },
            (_, i) => ({ fen: `old-${i}` }) as PracticeData["logs"][number],
        ),
    };
}

describe("updateCardPerformance", () => {
    test("appends a review log and updates the card", () => {
        let data = deckWithLogs(0);
        const setData = (u: PracticeData | ((d: PracticeData) => PracticeData)) => {
            data = typeof u === "function" ? u(data) : u;
        };

        updateCardPerformance(setData, 0, data.positions[0].card, 3);

        expect(data.logs).toHaveLength(1);
        expect(data.logs[0].fen).toBe("startpos");
        expect(data.positions[0].card.reps).toBe(1);
    });

    test("caps the review log at MAX_REVIEW_LOGS, dropping the oldest", () => {
        let data = deckWithLogs(MAX_REVIEW_LOGS);
        const setData = (u: PracticeData | ((d: PracticeData) => PracticeData)) => {
            data = typeof u === "function" ? u(data) : u;
        };

        updateCardPerformance(setData, 0, data.positions[0].card, 3);

        expect(data.logs).toHaveLength(MAX_REVIEW_LOGS);
        expect(data.logs.at(-1)?.fen).toBe("startpos"); // newest kept
        expect(data.logs[0].fen).toBe("old-1"); // "old-0" dropped
    });
});
