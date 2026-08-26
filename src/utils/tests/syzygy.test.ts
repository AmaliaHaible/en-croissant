import { describe, expect, it } from "vitest";
import {
    applySyzygyPathToAllEngines,
    applySyzygyPathToEngine,
    createVariant,
    type Engine,
    type LocalEngine,
} from "@/utils/engines";

describe("Syzygy tablebase engine configuration", () => {
    it("applies syzygy path to a local engine without existing settings", () => {
        const engine: LocalEngine = {
            type: "local",
            id: "1",
            name: "Stockfish",
            version: "17",
            path: "/usr/bin/stockfish",
            variants: [createVariant("Default", [])],
        };
        const updated = applySyzygyPathToEngine(engine, "/tablebases/syzygy");
        expect(updated.variants[0].settings).toEqual([
            { name: "SyzygyPath", value: "/tablebases/syzygy" },
        ]);
    });

    it("updates existing syzygypath setting case-insensitively", () => {
        const engine: LocalEngine = {
            type: "local",
            id: "2",
            name: "Berserk",
            version: "13",
            path: "/usr/bin/berserk",
            variants: [
                createVariant("Default", [
                    { name: "Threads", value: 4 },
                    { name: "syzygypath", value: "/old/path" },
                ]),
            ],
        };
        const updated = applySyzygyPathToEngine(engine, "/new/tablebase/path");
        expect(updated.variants[0].settings).toEqual([
            { name: "Threads", value: 4 },
            { name: "syzygypath", value: "/new/tablebase/path" },
        ]);
    });

    it("applies syzygy path across all variants of all local engines, preserving non-local engines", () => {
        const engines: Engine[] = [
            {
                type: "local",
                id: "sf",
                name: "Stockfish",
                version: "17",
                path: "/path/sf",
                variants: [
                    createVariant("Default", [{ name: "Hash", value: 512 }]),
                    createVariant("Aggressive", [{ name: "Hash", value: 256 }]),
                ],
            },
            {
                type: "chessdb",
                id: "cloud",
                name: "ChessDB",
                url: "https://chessdb.cn",
                variants: [createVariant("Default", [])],
            },
            {
                type: "local",
                id: "koivisto",
                name: "Koivisto",
                version: "9.2",
                path: "/path/koivisto",
                variants: [createVariant("Default", [{ name: "SyzygyPath", value: "/old" }])],
            },
        ];

        const updated = applySyzygyPathToAllEngines(engines, "/global/syzygy");
        expect((updated[0] as LocalEngine).variants[0].settings).toEqual([
            { name: "Hash", value: 512 },
            { name: "SyzygyPath", value: "/global/syzygy" },
        ]);
        expect((updated[0] as LocalEngine).variants[1].settings).toEqual([
            { name: "Hash", value: 256 },
            { name: "SyzygyPath", value: "/global/syzygy" },
        ]);
        expect(updated[1]).toEqual(engines[1]); // Cloud engine untouched
        expect((updated[2] as LocalEngine).variants[0].settings).toEqual([
            { name: "SyzygyPath", value: "/global/syzygy" },
        ]);
    });
});
