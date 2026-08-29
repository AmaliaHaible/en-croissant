import { describe, expect, it, test } from "vitest";
import type { UciOptionConfig } from "@/bindings";
import { backfillRequiredSettings, type Engine, resolveConfiguredEngine } from "../engines";

function localEngine(id: string, over: Partial<Engine> = {}): Engine {
    return {
        type: "local",
        id,
        name: id,
        version: "1",
        path: `/engines/${id}`,
        variants: [
            { id: `${id}-default`, name: "Default", go: { t: "Depth", c: 24 }, settings: [] },
        ],
        loaded: true,
        ...over,
    } as unknown as Engine;
}

function spin(name: string, def: number): UciOptionConfig {
    return {
        type: "spin",
        value: { name, default: BigInt(def), min: BigInt(0), max: BigInt(1024) },
    };
}

function stringOption(name: string, def: string | null = null): UciOptionConfig {
    return { type: "string", value: { name, default: def } };
}

const stockfishOptions: UciOptionConfig[] = [
    spin("Threads", 1),
    spin("Hash", 16),
    spin("MultiPV", 1),
    stringOption("SyzygyPath", ""),
];

test("backfills missing required settings from UCI defaults", () => {
    const result = backfillRequiredSettings([], stockfishOptions, "");
    expect(result).not.toBeNull();
    // UCI spin option defaults are bigint per the backend's UciOptionConfig type; the function
    // (matching the original inline logic) passes them through as-is, not converted to number.
    expect(result).toContainEqual({ name: "Threads", value: BigInt(1) });
    expect(result).toContainEqual({ name: "Hash", value: BigInt(16) });
    expect(result).toContainEqual({ name: "MultiPV", value: BigInt(1) });
});

test("adds the global syzygy path when the engine supports it and none is set yet", () => {
    const settings = [
        { name: "Threads", value: 4 },
        { name: "Hash", value: 64 },
        { name: "MultiPV", value: 1 },
    ];
    const result = backfillRequiredSettings(settings, stockfishOptions, "/tablebases");
    expect(result).not.toBeNull();
    expect(result).toContainEqual({ name: "SyzygyPath", value: "/tablebases" });
});

test("returns null when everything is already backfilled — does not report a spurious change", () => {
    // Regression test: switching to a variant that already has all required
    // settings AND an already-applied global syzygy path must NOT trigger a
    // rewrite. The old inline logic in EnginesPage.tsx unconditionally
    // reported "changed" whenever the engine supports SyzygyPath and a global
    // path is configured, regardless of whether anything was actually
    // missing — this caused a spurious setEngines() write on every variant
    // switch, which could race with and silently undo a concurrent variant
    // deletion/duplication.
    const settings = [
        { name: "Threads", value: 4 },
        { name: "Hash", value: 64 },
        { name: "MultiPV", value: 1 },
        { name: "SyzygyPath", value: "/tablebases" },
    ];
    const result = backfillRequiredSettings(settings, stockfishOptions, "/tablebases");
    expect(result).toBeNull();
});

test("returns null when no global syzygy path is configured, even if the engine supports it", () => {
    const settings = [
        { name: "Threads", value: 4 },
        { name: "Hash", value: 64 },
        { name: "MultiPV", value: 1 },
    ];
    const result = backfillRequiredSettings(settings, stockfishOptions, "");
    expect(result).toBeNull();
});

test("returns null when the engine doesn't advertise a SyzygyPath option", () => {
    const optionsWithoutSyzygy: UciOptionConfig[] = [
        spin("Threads", 1),
        spin("Hash", 16),
        spin("MultiPV", 1),
    ];
    const settings = [
        { name: "Threads", value: 4 },
        { name: "Hash", value: 64 },
        { name: "MultiPV", value: 1 },
    ];
    const result = backfillRequiredSettings(settings, optionsWithoutSyzygy, "/tablebases");
    expect(result).toBeNull();
});

describe("resolveConfiguredEngine", () => {
    it("keeps a configured engine selected even while it is unloaded", () => {
        // Regression: the coach settings tab used to resolve its saved engine id
        // against loaded engines only. When the chosen engine was toggled off
        // (Engines page / analysis panel) and another engine was loaded, the id
        // resolved to null, EnginesSelect's auto-select effect fired, and the
        // user's persisted choice was silently overwritten.
        const engines = [
            localEngine("sf", { loaded: false }),
            localEngine("lc0", { loaded: true }),
        ];
        expect(resolveConfiguredEngine("sf", engines)?.id).toBe("sf");
    });

    it("returns null when nothing is configured", () => {
        expect(resolveConfiguredEngine(null, [localEngine("sf")])).toBeNull();
    });

    it("returns null when the configured engine no longer exists", () => {
        expect(resolveConfiguredEngine("deleted", [localEngine("sf")])).toBeNull();
    });

    it("does not match a remote engine that happens to share the id", () => {
        const remote = {
            type: "lichess",
            id: "sf",
            name: "sf",
            url: "",
            variants: [],
        } as unknown as Engine;
        expect(resolveConfiguredEngine("sf", [remote])).toBeNull();
    });

    it("tolerates a missing engine list", () => {
        expect(resolveConfiguredEngine("sf", undefined)).toBeNull();
    });
});
