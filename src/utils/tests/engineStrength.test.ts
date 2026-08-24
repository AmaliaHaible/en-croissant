import { expect, test } from "vitest";
import type { UciOptionConfig } from "@/bindings";
import type { EngineSettings } from "@/utils/engines";
import {
    applyDialValue,
    applyPreset,
    clearDialOverride,
    detectStrengthDial,
    findActivePreset,
    getPresetsForEngine,
} from "@/utils/engineStrength";

function spin(
    name: string,
    min: bigint | null,
    max: bigint | null,
    def: bigint | null = null,
): UciOptionConfig {
    return { type: "spin", value: { name, default: def, min, max } };
}

function check(name: string, def: boolean | null = false): UciOptionConfig {
    return { type: "check", value: { name, default: def } };
}

const stockfishOptions: UciOptionConfig[] = [
    spin("Threads", BigInt(1), BigInt(1024), BigInt(1)),
    spin("Hash", BigInt(1), BigInt(33554432), BigInt(16)),
    check("UCI_LimitStrength", false),
    spin("UCI_Elo", BigInt(1320), BigInt(3190), BigInt(1320)),
    spin("Skill Level", BigInt(0), BigInt(20), BigInt(20)),
];

const komodoOptions: UciOptionConfig[] = [
    spin("Threads", BigInt(1), BigInt(128), BigInt(1)),
    spin("Skill", BigInt(0), BigInt(25), BigInt(25)),
];

const rodentOptions: UciOptionConfig[] = [
    spin("Hash", BigInt(1), BigInt(4096), BigInt(16)),
    check("OwnBook", true),
];

test("detects a UCI_Elo dial and prefers it over Skill Level", () => {
    const dial = detectStrengthDial(stockfishOptions);
    expect(dial).toEqual({
        kind: "elo",
        optionName: "UCI_Elo",
        limitOptionName: "UCI_LimitStrength",
        min: 1320,
        max: 3190,
    });
});

test("falls back to a skill dial when no Elo option is present", () => {
    const dial = detectStrengthDial(komodoOptions);
    expect(dial).toEqual({
        kind: "skill",
        optionName: "Skill",
        limitOptionName: null,
        min: 0,
        max: 25,
    });
});

test("returns null when the engine has no strength-limiting option", () => {
    expect(detectStrengthDial(rodentOptions)).toBeNull();
});

test("applyDialValue sets the option and enables the limiter below max", () => {
    const dial = detectStrengthDial(stockfishOptions)!;
    const base: EngineSettings = [{ name: "Threads", value: 4 }];
    const result = applyDialValue(dial, 1800, base);
    expect(result).toContainEqual({ name: "Threads", value: 4 });
    expect(result).toContainEqual({ name: "UCI_Elo", value: 1800 });
    expect(result).toContainEqual({ name: "UCI_LimitStrength", value: true });
});

test("applyDialValue disables the limiter at max strength", () => {
    const dial = detectStrengthDial(stockfishOptions)!;
    const result = applyDialValue(dial, 3190, []);
    expect(result).toContainEqual({ name: "UCI_LimitStrength", value: false });
});

test("applyDialValue replaces a previously applied dial value instead of duplicating it", () => {
    const dial = detectStrengthDial(stockfishOptions)!;
    const once = applyDialValue(dial, 1800, []);
    const twice = applyDialValue(dial, 2000, once);
    expect(twice.filter((o) => o.name === "UCI_Elo")).toHaveLength(1);
    expect(twice).toContainEqual({ name: "UCI_Elo", value: 2000 });
});

test("clearDialOverride removes the dial's options and leaves everything else", () => {
    const dial = detectStrengthDial(stockfishOptions)!;
    const withDial = applyDialValue(dial, 1800, [{ name: "Threads", value: 4 }]);
    expect(clearDialOverride(dial, withDial)).toEqual([{ name: "Threads", value: 4 }]);
});

test("applyPreset overrides only the settings the preset specifies", () => {
    const preset = {
        id: "test-preset",
        name: "Test",
        elo: 1500,
        options: [
            { name: "NpsLimit", value: 64 },
            { name: "Contempt", value: 0 },
        ],
    };
    const base: EngineSettings = [
        { name: "Hash", value: 16 },
        { name: "NpsLimit", value: 999999 },
    ];
    const result = applyPreset(preset, base);
    expect(result).toContainEqual({ name: "Hash", value: 16 });
    expect(result).toContainEqual({ name: "NpsLimit", value: 64 });
    expect(result).toContainEqual({ name: "Contempt", value: 0 });
    expect(result.filter((o) => o.name === "NpsLimit")).toHaveLength(1);
});

test("getPresetsForEngine matches Rodent II case-insensitively", () => {
    expect(getPresetsForEngine("Rodent II 0.9.64")).not.toBeNull();
    expect(getPresetsForEngine("rodentII")).not.toBeNull();
});

test("getPresetsForEngine returns null for engines with no bundled presets", () => {
    expect(getPresetsForEngine("Stockfish 18")).toBeNull();
});

test("findActivePreset identifies a fully-applied preset and ignores partial matches", () => {
    const presets = [
        { id: "a", name: "A", elo: 1400, options: [{ name: "NpsLimit", value: 64 }] },
        { id: "b", name: "B", elo: 1900, options: [{ name: "NpsLimit", value: 3000 }] },
    ];
    expect(findActivePreset(presets, [{ name: "NpsLimit", value: 3000 }])).toEqual(presets[1]);
    expect(findActivePreset(presets, [{ name: "NpsLimit", value: 12 }])).toBeNull();
    expect(findActivePreset(presets, [])).toBeNull();
});
