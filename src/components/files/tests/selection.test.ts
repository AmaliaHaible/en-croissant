import { expect, test } from "vitest";
import { computeRangeSelection, flattenVisibleEntries } from "../selection";

type Entry =
    | { type: "file"; path: string }
    | { type: "directory"; path: string; children: Entry[] };

test("flattenVisibleEntries lists top-level entries in order when nothing is expanded", () => {
    const files: Entry[] = [
        { type: "directory", path: "/a", children: [{ type: "file", path: "/a/1" }] },
        { type: "file", path: "/b" },
    ];
    expect(flattenVisibleEntries(files, () => false)).toEqual(["/a", "/b"]);
});

test("flattenVisibleEntries includes children of expanded directories", () => {
    const files: Entry[] = [
        { type: "directory", path: "/a", children: [{ type: "file", path: "/a/1" }] },
        { type: "file", path: "/b" },
    ];
    expect(flattenVisibleEntries(files, (path) => path === "/a")).toEqual(["/a", "/a/1", "/b"]);
});

test("flattenVisibleEntries does not descend into collapsed nested directories", () => {
    const files: Entry[] = [
        {
            type: "directory",
            path: "/a",
            children: [
                {
                    type: "directory",
                    path: "/a/b",
                    children: [{ type: "file", path: "/a/b/1" }],
                },
            ],
        },
    ];
    expect(flattenVisibleEntries(files, (path) => path === "/a")).toEqual(["/a", "/a/b"]);
});

test("computeRangeSelection returns every path between anchor and target inclusive", () => {
    const order = ["/a", "/b", "/c", "/d"];
    expect(computeRangeSelection(order, "/b", "/d")).toEqual(["/b", "/c", "/d"]);
});

test("computeRangeSelection works when the target comes before the anchor", () => {
    const order = ["/a", "/b", "/c", "/d"];
    expect(computeRangeSelection(order, "/d", "/b")).toEqual(["/b", "/c", "/d"]);
});

test("computeRangeSelection falls back to just the target when the anchor is not visible", () => {
    const order = ["/a", "/b"];
    expect(computeRangeSelection(order, "/missing", "/b")).toEqual(["/b"]);
});
