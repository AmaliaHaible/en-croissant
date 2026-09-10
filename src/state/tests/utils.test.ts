import { describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/plugin-log", () => ({
    warn: vi.fn<(message: string) => Promise<void>>(),
    error: vi.fn<(message: string) => Promise<void>>(),
}));

import { compressedStringStorage, createZodStorage } from "../utils";
import { z } from "zod";

function memoryStringStorage() {
    const map = new Map<string, string>();
    return {
        map,
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => {
            map.set(k, v);
        },
        removeItem: (k: string) => {
            map.delete(k);
        },
    };
}

describe("compressedStringStorage", () => {
    test("round-trips a value through compression", () => {
        const inner = memoryStringStorage();
        const storage = compressedStringStorage(inner);

        const value = JSON.stringify({ hello: "world", list: [1, 2, 3] });
        storage.setItem("k", value);

        expect(inner.map.get("k")).not.toBe(value); // actually compressed on disk
        expect(storage.getItem("k")).toBe(value);
    });

    test("shrinks large repetitive payloads", () => {
        const inner = memoryStringStorage();
        const storage = compressedStringStorage(inner);

        const big = JSON.stringify(
            Array.from({ length: 500 }, (_, i) => ({
                fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
                answer: "Nf6",
                card: { due: "2026-09-10T19:17:58.791Z", reps: i % 3 },
            })),
        );
        storage.setItem("deck", big);

        expect(inner.map.get("deck")!.length).toBeLessThan(big.length / 3);
        expect(storage.getItem("deck")).toBe(big);
    });

    test("reads legacy uncompressed values verbatim, then re-compresses on write", () => {
        const inner = memoryStringStorage();
        const storage = compressedStringStorage(inner);

        const legacy = JSON.stringify({ positions: [], logs: [] });
        inner.map.set("deck", legacy); // written before compression existed

        expect(storage.getItem("deck")).toBe(legacy);

        storage.setItem("deck", legacy);
        expect(inner.map.get("deck")).not.toBe(legacy);
        expect(storage.getItem("deck")).toBe(legacy);
    });

    test("returns null for a missing key", () => {
        const storage = compressedStringStorage(memoryStringStorage());
        expect(storage.getItem("nope")).toBeNull();
    });
});

describe("createZodStorage.setItem", () => {
    test("does not throw when the underlying storage is out of quota", () => {
        const inner = {
            getItem: () => null,
            setItem: () => {
                throw new DOMException("quota exceeded", "QuotaExceededError");
            },
            removeItem: () => {},
        };
        const storage = createZodStorage(z.object({ a: z.number() }), inner);

        expect(() => storage.setItem("k", { a: 1 })).not.toThrow();
    });
});
