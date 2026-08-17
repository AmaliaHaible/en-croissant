import { expect, test } from "vitest";
import { defaultTree, type TreeNode, getTreeStructureHash } from "../treeReducer";

function buildLargeTree(depth: number, branching: number): TreeNode {
    const root = defaultTree().root;

    function addChildren(parent: TreeNode, currentDepth: number) {
        if (currentDepth >= depth) return;
        for (let i = 0; i < branching; i++) {
            const child: TreeNode = {
                fen: `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - ${currentDepth} ${i}`,
                move: null,
                san: `e${i + 1}`,
                children: [],
                score: null,
                depth: null,
                halfMoves: currentDepth * 2 + i,
                shapes: [],
                annotations: [],
                comment: "",
            };
            parent.children.push(child);
            addChildren(child, currentDepth + 1);
        }
    }

    addChildren(root, 0);
    return root;
}

test("tree structure hash produces consistent deterministic hashes", () => {
    const tree1 = buildLargeTree(4, 3);
    const tree2 = buildLargeTree(4, 3);
    const tree3 = buildLargeTree(4, 3);
    tree3.children[0].san = "d4";

    const hash1 = getTreeStructureHash(tree1);
    const hash2 = getTreeStructureHash(tree2);
    const hash3 = getTreeStructureHash(tree3);

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(typeof hash1).toBe("string");
});

test("benchmark tree structure hash on 3280-node tree", () => {
    const largeTree = buildLargeTree(7, 3);

    const iterations = 500;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        getTreeStructureHash(largeTree);
    }
    const elapsedMs = performance.now() - start;
    const perIterMs = elapsedMs / iterations;

    console.log(
        `Tree structure hash benchmark: ${iterations} runs on 3,280-node tree took ${elapsedMs.toFixed(2)}ms (${(perIterMs * 1000).toFixed(2)} µs/op)`,
    );

    expect(perIterMs).toBeLessThan(5);
});
