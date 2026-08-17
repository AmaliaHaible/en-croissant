import { describe, expect, it } from "vitest";
import {
    applySyzygyPathToAllEngines,
    applySyzygyPathToEngine,
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
            settings: [],
        };
        const updated = applySyzygyPathToEngine(engine, "/tablebases/syzygy");
        expect(updated.settings).toEqual([
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
            settings: [
                { name: "Threads", value: 4 },
                { name: "syzygypath", value: "/old/path" },
            ],
        };
        const updated = applySyzygyPathToEngine(engine, "/new/tablebase/path");
        expect(updated.settings).toEqual([
            { name: "Threads", value: 4 },
            { name: "syzygypath", value: "/new/tablebase/path" },
        ]);
    });

    it("applies syzygy path across multiple engines while preserving non-local engines", () => {
        const engines: Engine[] = [
            {
                type: "local",
                id: "sf",
                name: "Stockfish",
                version: "17",
                path: "/path/sf",
                settings: [{ name: "Hash", value: 512 }],
            },
            {
                type: "chessdb",
                id: "cloud",
                name: "ChessDB",
                url: "https://chessdb.cn",
            },
            {
                type: "local",
                id: "koivisto",
                name: "Koivisto",
                version: "9.2",
                path: "/path/koivisto",
                settings: [{ name: "SyzygyPath", value: "/old" }],
            },
        ];

        const updated = applySyzygyPathToAllEngines(engines, "/global/syzygy");
        expect(updated[0].settings).toEqual([
            { name: "Hash", value: 512 },
            { name: "SyzygyPath", value: "/global/syzygy" },
        ]);
        expect(updated[1]).toEqual(engines[1]); // Cloud engine untouched
        expect(updated[2].settings).toEqual([
            { name: "SyzygyPath", value: "/global/syzygy" },
        ]);
    });
});
