import { expect, test } from "vitest";
import { getDisplayName, getEntryDisplayName, normalizeFileInfoMetadata } from "../file";

test("normalizeFileInfoMetadata fills in missing fields from the fallback", () => {
    const result = normalizeFileInfoMetadata(null, {
        displayName: "My Game",
        createdAt: 12345,
    });
    expect(result).toEqual({
        type: "other",
        tags: [],
        displayName: "My Game",
        createdAt: 12345,
    });
});

test("normalizeFileInfoMetadata preserves existing fields and only fills gaps", () => {
    const result = normalizeFileInfoMetadata(
        { type: "game", tags: ["opening"] },
        { displayName: "Fallback Name", createdAt: 99 },
    );
    expect(result).toEqual({
        type: "game",
        tags: ["opening"],
        displayName: "Fallback Name",
        createdAt: 99,
    });
});

test("normalizeFileInfoMetadata does not overwrite an already-present displayName/createdAt", () => {
    const result = normalizeFileInfoMetadata(
        { type: "game", tags: [], displayName: "Real Name", createdAt: 1 },
        { displayName: "Fallback Name", createdAt: 99 },
    );
    expect(result.displayName).toBe("Real Name");
    expect(result.createdAt).toBe(1);
});

test("getDisplayName prefers the stored display name over the technical file name", () => {
    const file = {
        name: "Alice_vs_Bob_2026-08-28",
        metadata: { type: "game" as const, tags: [], displayName: "Alice vs Bob", createdAt: 0 },
    };
    expect(getDisplayName(file)).toBe("Alice vs Bob");
});

test("getDisplayName falls back to the technical name when displayName is empty", () => {
    const file = {
        name: "Alice_vs_Bob_2026-08-28",
        metadata: { type: "game" as const, tags: [], displayName: "", createdAt: 0 },
    };
    expect(getDisplayName(file)).toBe("Alice_vs_Bob_2026-08-28");
});

test("getEntryDisplayName uses the display name for files and the raw name for directories", () => {
    const file = {
        type: "file" as const,
        name: "raw",
        path: "/raw.pgn",
        numGames: 1,
        metadata: { type: "game" as const, tags: [], displayName: "Pretty Name", createdAt: 0 },
        lastModified: 0,
    };
    const dir = { type: "directory" as const, name: "My Folder", path: "/My Folder", children: [] };
    expect(getEntryDisplayName(file)).toBe("Pretty Name");
    expect(getEntryDisplayName(dir)).toBe("My Folder");
});
