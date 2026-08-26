import { expect, test } from "vitest";
import { migrateEngineRecord } from "../engineVariantsMigration";

test("upgrades an old-shape engine record into a single Default variant", () => {
    const raw = {
        type: "local",
        id: "1",
        name: "Stockfish",
        version: "17",
        path: "/usr/bin/stockfish",
        settings: [{ name: "Threads", value: 4 }],
        go: { t: "Depth", c: 20 },
    };
    const migrated = migrateEngineRecord(raw) as any;
    expect(migrated.settings).toBeUndefined();
    expect(migrated.go).toBeUndefined();
    expect(migrated.variants).toHaveLength(1);
    expect(migrated.variants[0]).toMatchObject({
        name: "Default",
        go: { t: "Depth", c: 20 },
        settings: [{ name: "Threads", value: 4 }],
    });
    expect(typeof migrated.variants[0].id).toBe("string");
});

test("defaults go and settings when the old record had neither", () => {
    const migrated = migrateEngineRecord({
        type: "local",
        id: "2",
        name: "X",
        version: "",
        path: "",
    }) as any;
    expect(migrated.variants[0].go).toEqual({ t: "Depth", c: 24 });
    expect(migrated.variants[0].settings).toEqual([]);
});

test("seeds the 10 Rodent II personalities as extra variants, matched case-insensitively", () => {
    const migrated = migrateEngineRecord({
        type: "local",
        id: "3",
        name: "Rodent II 0.9.64",
        version: "0.9.64",
        path: "/usr/bin/rodentii",
        settings: [{ name: "Hash", value: 64 }],
    }) as any;
    expect(migrated.variants).toHaveLength(11); // Default + 10 personalities
    const names = migrated.variants.map((v: any) => v.name);
    expect(names).toContain("Victor (Masters)");
    expect(names).toContain("Frank (School)");

    const victor = migrated.variants.find((v: any) => v.name === "Victor (Masters)");
    // Base settings not touched by the personality are preserved...
    expect(victor.settings).toContainEqual({ name: "Hash", value: 64 });
    // ...and the personality's own values match src/utils/presets/rodentII.ts exactly.
    expect(victor.settings).toContainEqual({ name: "NpsLimit", value: 28000 });
    expect(victor.settings).toContainEqual({ name: "Material", value: 90 });
    expect(victor.settings).toContainEqual({ name: "Selectivity", value: 175 });
});

test("does not seed personalities for a non-Rodent-II engine", () => {
    const migrated = migrateEngineRecord({
        type: "local",
        id: "4",
        name: "Rodent 5",
        version: "",
        path: "",
    }) as any;
    expect(migrated.variants).toHaveLength(1);

    const migrated2 = migrateEngineRecord({
        type: "local",
        id: "5",
        name: "Rodent IV",
        version: "",
        path: "",
    }) as any;
    expect(migrated2.variants).toHaveLength(1);
});

test("is idempotent for records that already have variants", () => {
    const already = {
        type: "local",
        id: "6",
        name: "X",
        version: "",
        path: "",
        variants: [{ id: "v1", name: "Default", go: { t: "Depth", c: 24 }, settings: [] }],
    };
    expect(migrateEngineRecord(already)).toBe(already);
});

test("passes through non-object input unchanged", () => {
    expect(migrateEngineRecord(null)).toBeNull();
    expect(migrateEngineRecord("oops")).toBe("oops");
    expect(migrateEngineRecord(undefined)).toBeUndefined();
});
