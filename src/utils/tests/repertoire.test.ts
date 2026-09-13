import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PositionStats } from "@/bindings";
import {
    searchExplorerMoves as realSearchExplorerMoves,
    searchPositionsBatch as realSearchPositionsBatch,
} from "../db";
import { computeTreeCoverage, findBiggestGap } from "../repertoire";
import type { TreeNode } from "../treeReducer";

vi.mock("../db");
const searchPositionsBatch = vi.mocked(realSearchPositionsBatch);
const searchExplorerMoves = vi.mocked(realSearchExplorerMoves);

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
    searchExplorerMoves.mockReset();
});

describe("computeTreeCoverage", () => {
    test("resolves every position in one batch call, not one per node", async () => {
        searchPositionsBatch.mockResolvedValue([]);

        await computeTreeCoverage(sampleTree(), "white", { kind: "local", path: "db.db3" }, 10);

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
            { kind: "local", path: "db.db3" },
            10,
        );

        expect(coverageMap.get("0")).toBeCloseTo(0.5);
        expect(missingGamesMap.get("0")).toBe(15);
        expect(gamesMap.get("")).toBe(100);
    });

    test("rejects immediately when handed an already-aborted signal", async () => {
        searchPositionsBatch.mockResolvedValue([]);

        await expect(
            computeTreeCoverage(
                sampleTree(),
                "white",
                { kind: "local", path: "db.db3" },
                10,
                [],
                AbortSignal.abort(),
            ),
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
            computeTreeCoverage(
                sampleTree(),
                "white",
                { kind: "local", path: "db.db3" },
                10,
                [],
                controller.signal,
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    test("uses the lichess explorer when the reference is a lichess source", async () => {
        searchExplorerMoves.mockImplementation(async (_source: string, fens: string[]) =>
            fens.map((fen) => {
                if (fen === "fen-root") return [stats("e4", 100)];
                if (fen === "fen-e4") return [stats("e5", 15), stats("c5", 15)];
                return [];
            }),
        );

        const { coverageMap, missingGamesMap } = await computeTreeCoverage(
            sampleTree(),
            "white",
            { kind: "lichess", token: "tok" },
            10,
        );

        expect(searchExplorerMoves).toHaveBeenCalledTimes(1);
        expect(searchExplorerMoves).toHaveBeenCalledWith(
            "lichess",
            expect.arrayContaining(["fen-root", "fen-e4", "fen-e5"]),
            "tok",
        );
        expect(searchPositionsBatch).not.toHaveBeenCalled();
        expect(coverageMap.get("0")).toBeCloseTo(0.5);
        expect(missingGamesMap.get("0")).toBe(15);
    });
});

describe("findBiggestGap", () => {
    /**
     * root --d4--> A(opponent choice) --Nf6(answered, 1M games)--> B(user's move)
     *                    \--d5 (unanswered, 500K games, no tree node)
     *
     * A --Nf6--> B --c4--> C(opponent) --e6(answered, 10K games)--> D(user, leaf, unanswered)
     *
     * The unanswered "d5" reply at A represents 500K missing games and should
     * outweigh the unanswered leaf at D, which only represents ~10K games.
     */
    function scenarioTree(): TreeNode {
        const d = node("fen-d", "e6", 4, []);
        const c = node("fen-c", "c4", 3, [d]);
        const b = node("fen-b", "Nf6", 2, [c]);
        const a = node("fen-a", "d4", 1, [b]);
        return node("fen-root", null, 0, [a]);
    }

    test("prefers the shallow unanswered reply with far more games over a deep unanswered leaf", async () => {
        searchPositionsBatch.mockImplementation(async (_db: string, fens: string[]) =>
            fens.map((fen) => {
                if (fen === "fen-root") return [stats("d4", 1_500_000)];
                if (fen === "fen-a") return [stats("Nf6", 1_000_000), stats("d5", 500_000)];
                if (fen === "fen-b") return [stats("c4", 10_500)];
                if (fen === "fen-c") return [stats("e6", 10_000)];
                if (fen === "fen-d") return [{ move: "*", white: 10_000, draw: 0, black: 0 }];
                return [];
            }),
        );

        const root = scenarioTree();
        const { coverageMap, gamesMap, missingGamesMap } = await computeTreeCoverage(
            root,
            "white",
            { kind: "local", path: "db.db3" },
            10,
        );

        expect(missingGamesMap.get("0")).toBe(500_000);

        const gap = findBiggestGap(root, "white", coverageMap, gamesMap, missingGamesMap, 10);

        expect(gap).toEqual([0]);
    });
});
