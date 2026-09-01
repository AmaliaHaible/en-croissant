import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PositionStats } from "@/bindings";
import { searchPositionsBatch as realSearchPositionsBatch } from "../db";
import { computeTreeCoverage } from "../repertoire";
import type { TreeNode } from "../treeReducer";

vi.mock("../db");
const searchPositionsBatch = vi.mocked(realSearchPositionsBatch);

function node(fen: string, san: string | null, halfMoves: number, children: TreeNode[]): TreeNode {
    return {
        fen,
        move: null,
        san,
        children,
        score: null,
        depth: null,
        halfMoves,
        shapes: [],
        annotations: [],
        comment: "",
    };
}

/** root → e4 → e5 (leaf), from White's perspective. */
function sampleTree(): TreeNode {
    const e5 = node("fen-e5", "e5", 2, []);
    const e4 = node("fen-e4", "e4", 1, [e5]);
    return node("fen-root", null, 0, [e4]);
}

const stats = (move: string, n: number): PositionStats => ({
    move,
    white: n,
    draw: 0,
    black: 0,
});

beforeEach(() => {
    searchPositionsBatch.mockReset();
});

describe("computeTreeCoverage", () => {
    test("resolves every position in one batch call, not one per node", async () => {
        searchPositionsBatch.mockResolvedValue([]);

        await computeTreeCoverage(sampleTree(), "white", "db.db3", 10);

        expect(searchPositionsBatch).toHaveBeenCalledTimes(1);
        expect(searchPositionsBatch).toHaveBeenCalledWith(
            "db.db3",
            expect.arrayContaining(["fen-root", "fen-e4", "fen-e5"]),
        );
    });

    test("weights coverage by database frequency of the covered move", async () => {
        // At fen-e4 the DB has two significant replies; the repertoire only
        // answers "e5", so it covers half the traffic and "c5" (15 games) is the
        // biggest gap.
        searchPositionsBatch.mockImplementation(async (_db: string, fens: string[]) =>
            fens.map((fen) => {
                if (fen === "fen-root") return [stats("e4", 100)];
                if (fen === "fen-e4") return [stats("e5", 15), stats("c5", 15)];
                return [];
            }),
        );

        const { coverageMap, missingGamesMap, gamesMap } = await computeTreeCoverage(
            sampleTree(),
            "white",
            "db.db3",
            10,
        );

        expect(coverageMap.get("0")).toBeCloseTo(0.5);
        expect(missingGamesMap.get("0")).toBe(15);
        expect(gamesMap.get("")).toBe(100);
    });

    test("rejects immediately when handed an already-aborted signal", async () => {
        searchPositionsBatch.mockResolvedValue([]);

        await expect(
            computeTreeCoverage(sampleTree(), "white", "db.db3", 10, [], AbortSignal.abort()),
        ).rejects.toMatchObject({ name: "AbortError" });

        expect(searchPositionsBatch).not.toHaveBeenCalled();
    });

    test("rejects if the signal aborts while the batch search is in flight", async () => {
        const controller = new AbortController();
        searchPositionsBatch.mockImplementation(async () => {
            controller.abort();
            return [];
        });

        await expect(
            computeTreeCoverage(sampleTree(), "white", "db.db3", 10, [], controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
    });
});
