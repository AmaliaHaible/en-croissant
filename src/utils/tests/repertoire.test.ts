import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NormalizedGame, PositionStats } from "@/bindings";
import { searchPosition as realSearchPosition } from "../db";
import { computeTreeCoverage } from "../repertoire";
import type { TreeNode } from "../treeReducer";

vi.mock("../db");
const searchPosition = vi.mocked(realSearchPosition);

function node(fen: string, halfMoves: number, child?: TreeNode): TreeNode {
    return {
        fen,
        move: null,
        san: halfMoves === 0 ? null : "e4",
        children: child ? [child] : [],
        score: null,
        depth: null,
        halfMoves,
        shapes: [],
        annotations: [],
        comment: "",
    };
}

/** A linear repertoire line of `depth` plies, one child ("e4") per node. */
function linearTree(depth: number): TreeNode {
    let current = node(`fen-${depth}`, depth);
    for (let i = depth - 1; i >= 0; i--) {
        current = node(`fen-${i}`, i, current);
    }
    return current;
}

const dbResult: [PositionStats[], NormalizedGame[]] = [
    [{ move: "e4", white: 50, draw: 30, black: 20 }],
    [],
];

beforeEach(() => {
    searchPosition.mockReset();
});

describe("computeTreeCoverage", () => {
    test("walks the whole line when not cancelled", async () => {
        searchPosition.mockResolvedValue(dbResult);

        const result = await computeTreeCoverage(linearTree(8), "white", "db.db3", 1);

        expect(result.coverageMap.size).toBeGreaterThan(0);
        expect(searchPosition.mock.calls.length).toBeGreaterThan(3);
    });

    test("stops issuing searches once the signal aborts mid-traversal", async () => {
        const controller = new AbortController();
        let calls = 0;
        searchPosition.mockImplementation(async () => {
            calls += 1;
            if (calls === 3) controller.abort();
            return dbResult;
        });

        await expect(
            computeTreeCoverage(linearTree(20), "white", "db.db3", 1, [], controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });

        expect(searchPosition).toHaveBeenCalledTimes(3);
    });

    test("rejects immediately when handed an already-aborted signal", async () => {
        searchPosition.mockResolvedValue(dbResult);

        await expect(
            computeTreeCoverage(linearTree(8), "white", "db.db3", 1, [], AbortSignal.abort()),
        ).rejects.toMatchObject({ name: "AbortError" });

        expect(searchPosition).not.toHaveBeenCalled();
    });
});
