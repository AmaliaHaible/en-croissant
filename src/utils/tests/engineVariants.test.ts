import { expect, test } from "vitest";
import {
    applySettingOverrides,
    canDeleteVariant,
    createVariant,
    DEFAULT_GO_MODE,
    duplicateVariant,
    engineVariantSchema,
    getDefaultVariant,
    withDefaultVariant,
} from "../engineVariants";

test("createVariant fills in a random id and the given name/settings/go", () => {
    const v = createVariant("Aggressive", [{ name: "Threads", value: 4 }], { t: "Depth", c: 10 });
    expect(v.name).toBe("Aggressive");
    expect(v.settings).toEqual([{ name: "Threads", value: 4 }]);
    expect(v.go).toEqual({ t: "Depth", c: 10 });
    expect(typeof v.id).toBe("string");
    expect(v.id.length).toBeGreaterThan(0);
});

test("createVariant defaults to empty settings and DEFAULT_GO_MODE", () => {
    const v = createVariant("Default");
    expect(v.settings).toEqual([]);
    expect(v.go).toEqual(DEFAULT_GO_MODE);
});

test("duplicateVariant copies settings/go but assigns a new id and name", () => {
    const original = createVariant("Aggressive", [{ name: "Threads", value: 4 }]);
    const copy = duplicateVariant(original, "Aggressive (Copy)");
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe("Aggressive (Copy)");
    expect(copy.settings).toEqual(original.settings);
    expect(copy.go).toEqual(original.go);
});

test("duplicateVariant produces settings independent from the source (mutating the copy does not affect the original)", () => {
    const original = createVariant("Original", [{ name: "Threads", value: 1 }]);
    const copy = duplicateVariant(original, "Copy");
    // Simulate the exact mutation pattern setSetting used to perform (before the fix)
    const newSettings = copy.settings.map((s) => (s.name === "Threads" ? { ...s, value: 8 } : s));
    expect(newSettings).toEqual([{ name: "Threads", value: 8 }]);
    expect(original.settings).toEqual([{ name: "Threads", value: 1 }]);
    expect(copy.settings).not.toBe(original.settings);
});

test("getDefaultVariant returns the first variant", () => {
    const a = createVariant("A");
    const b = createVariant("B");
    expect(getDefaultVariant({ variants: [a, b] })).toBe(a);
});

test("withDefaultVariant patches only the first variant, leaving others untouched", () => {
    const a = createVariant("A", [{ name: "Threads", value: 1 }]);
    const b = createVariant("B", [{ name: "Threads", value: 2 }]);
    const result = withDefaultVariant(
        { variants: [a, b] },
        { settings: [{ name: "Threads", value: 8 }] },
    );
    expect(result.variants[0].settings).toEqual([{ name: "Threads", value: 8 }]);
    expect(result.variants[0].id).toBe(a.id);
    expect(result.variants[1]).toBe(b);
});

test("canDeleteVariant is false at exactly one variant, true above that", () => {
    expect(canDeleteVariant(1)).toBe(false);
    expect(canDeleteVariant(2)).toBe(true);
    expect(canDeleteVariant(0)).toBe(false);
});

test("engineVariantSchema defaults importantSettings to an empty array for legacy records", () => {
    const parsed = engineVariantSchema.parse({ name: "Default" });
    expect(parsed.importantSettings).toEqual([]);
});

test("createVariant and duplicateVariant carry an importantSettings array", () => {
    const v = createVariant("A");
    expect(v.importantSettings).toEqual([]);
    v.importantSettings.push("Skill Level");
    const copy = duplicateVariant(v, "A (Copy)");
    expect(copy.importantSettings).toEqual(["Skill Level"]);
    // independent copy
    copy.importantSettings.push("UCI_Elo");
    expect(v.importantSettings).toEqual(["Skill Level"]);
});

test("applySettingOverrides replaces a matching entry by name", () => {
    const base = [
        { name: "Threads", value: 4 },
        { name: "Skill Level", value: 20 },
    ];
    const result = applySettingOverrides(base, [{ name: "Skill Level", value: 5 }]);
    expect(result).toEqual([
        { name: "Threads", value: 4 },
        { name: "Skill Level", value: 5 },
    ]);
    // base is untouched
    expect(base[1].value).toBe(20);
});

test("applySettingOverrides appends an override the variant has no entry for", () => {
    const result = applySettingOverrides(
        [{ name: "Threads", value: 4 }],
        [{ name: "Skill Level", value: 5 }],
    );
    expect(result).toEqual([
        { name: "Threads", value: 4 },
        { name: "Skill Level", value: 5 },
    ]);
});

test("applySettingOverrides with no overrides returns an equal copy", () => {
    const base = [{ name: "Threads", value: 4 }];
    const result = applySettingOverrides(base, []);
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
});
