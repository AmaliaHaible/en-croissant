# Engine Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace each engine's single flat `settings`/`go` config with a list of named, user-editable "variants" (full UCI option bundles + search mode), and switch Create Game, Coach settings, and engine management to picking a saved variant instead of individually configuring threads/hash/skill/personality/etc.

**Architecture:** `LocalEngine`/`RemoteEngine` gain `variants: EngineVariant[]` (min length 1) replacing top-level `settings`/`go`. A `z.preprocess` step migrates old-shape JSON on read (including seeding Rodent II's 10 hardcoded personalities as real variants), so no dual-format runtime code is needed afterward. Every consumer (Create Game, Coach settings, Analysis panel, report generation) resolves a variant by id from `engine.variants`, falling back to `engine.variants[0]` where no explicit picker exists.

**Tech Stack:** React 19, TypeScript, Zod, Jotai (`atomWithStorage`), Mantine UI, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-engine-variants-design.md`

## Global Constraints

- Every `Engine` (local or remote) must have `variants.length >= 1` at all times — enforced by construction (creation/migration always produce at least one variant) and by the delete UI (last variant can't be removed). TypeScript itself won't enforce the length, so every place that reads `engine.variants[0]` relies on this invariant holding.
- Variants are referenced **by id**, never copied inline, at every consumer (Create Game's `OpponentSettings`, Coach's `CoachEngineConfig`) — so editing a variant later is reflected everywhere it's used.
- No UI changes to the Analysis panel (`EngineSelection.tsx` / `tabEngineSettingsFamily`) — only its internal data source changes, from the old top-level `settings`/`go` to `engine.variants[0]`.
- Rodent II's 10 bundled personalities must be preserved with byte-identical option values as seeded variants (verified by unit test against the values in the current `src/utils/presets/rodentII.ts`).
- Verification commands throughout: `pnpm test` (vitest run) and `pnpm lint` (`tsc --noEmit && oxlint`).

---

## Task 1: Engine variant data model & pure helpers

**Files:**
- Create: `src/utils/engineVariants.ts`
- Test: `src/utils/tests/engineVariants.test.ts`

**Interfaces:**
- Produces: `EngineVariant` type `{ id: string; name: string; go: GoMode; settings: EngineSettings }`; `engineVariantSchema` (Zod); `engineSettingsSchema`/`EngineSettings` (moved here, unchanged shape); `goModeSchema` (moved here, unchanged shape); `DEFAULT_GO_MODE: GoMode`; `createVariant(name, settings?, go?): EngineVariant`; `duplicateVariant(variant, name): EngineVariant`; `canDeleteVariant(variantCount): boolean`; `getDefaultVariant<E extends {variants: EngineVariant[]}>(engine): EngineVariant`; `withDefaultVariant<E extends {variants: EngineVariant[]}>(engine, patch): E`. These helpers take a structural `{variants: EngineVariant[]}` type (not `Engine`) so this module has zero dependency on `./engines`, avoiding a circular import (Task 3 makes `./engines` depend on this module).

- [ ] **Step 1: Write the failing tests**

```ts
// src/utils/tests/engineVariants.test.ts
import { expect, test } from "vitest";
import {
    canDeleteVariant,
    createVariant,
    DEFAULT_GO_MODE,
    duplicateVariant,
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

test("getDefaultVariant returns the first variant", () => {
    const a = createVariant("A");
    const b = createVariant("B");
    expect(getDefaultVariant({ variants: [a, b] })).toBe(a);
});

test("withDefaultVariant patches only the first variant, leaving others untouched", () => {
    const a = createVariant("A", [{ name: "Threads", value: 1 }]);
    const b = createVariant("B", [{ name: "Threads", value: 2 }]);
    const result = withDefaultVariant({ variants: [a, b] }, { settings: [{ name: "Threads", value: 8 }] });
    expect(result.variants[0].settings).toEqual([{ name: "Threads", value: 8 }]);
    expect(result.variants[0].id).toBe(a.id);
    expect(result.variants[1]).toBe(b);
});

test("canDeleteVariant is false at exactly one variant, true above that", () => {
    expect(canDeleteVariant(1)).toBe(false);
    expect(canDeleteVariant(2)).toBe(true);
    expect(canDeleteVariant(0)).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/utils/tests/engineVariants.test.ts`
Expected: FAIL — `../engineVariants` module does not exist.

- [ ] **Step 3: Implement `src/utils/engineVariants.ts`**

```ts
import { z } from "zod";
import type { GoMode } from "@/bindings";

export const DEFAULT_GO_MODE: GoMode = { t: "Depth", c: 24 };

export const goModeSchema: z.ZodSchema<GoMode> = z.union([
    z.object({
        t: z.literal("Depth"),
        c: z.number(),
    }),
    z.object({
        t: z.literal("Time"),
        c: z.number(),
    }),
    z.object({
        t: z.literal("Nodes"),
        c: z.number(),
    }),
    z.object({
        t: z.literal("Infinite"),
    }),
]);

export const engineSettingsSchema = z.array(
    z.object({
        name: z.string(),
        value: z.string().or(z.number()).or(z.boolean()).nullable(),
    }),
);

export type EngineSettings = z.infer<typeof engineSettingsSchema>;

export const engineVariantSchema = z.object({
    id: z.string().default(() => crypto.randomUUID()),
    name: z.string(),
    go: goModeSchema.default(DEFAULT_GO_MODE),
    settings: engineSettingsSchema.default([]),
});

export type EngineVariant = z.output<typeof engineVariantSchema>;

type EngineLike = { variants: EngineVariant[] };

/** Creates a new variant with a fresh id. `go` defaults to `DEFAULT_GO_MODE`. */
export function createVariant(
    name: string,
    settings: EngineSettings = [],
    go: GoMode = DEFAULT_GO_MODE,
): EngineVariant {
    return { id: crypto.randomUUID(), name, go, settings };
}

/** Copies a variant's settings/go under a new id and name. */
export function duplicateVariant(variant: EngineVariant, name: string): EngineVariant {
    return { ...variant, id: crypto.randomUUID(), name };
}

/** The implicit default variant used wherever no explicit picker exists (e.g. the Analysis panel). */
export function getDefaultVariant<E extends EngineLike>(engine: E): EngineVariant {
    return engine.variants[0];
}

/** Returns a copy of `engine` with its default (first) variant patched; other variants untouched. */
export function withDefaultVariant<E extends EngineLike>(
    engine: E,
    patch: Partial<Pick<EngineVariant, "go" | "settings">>,
): E {
    const [first, ...rest] = engine.variants;
    return { ...engine, variants: [{ ...first, ...patch }, ...rest] };
}

/** An engine must always keep at least one variant. */
export function canDeleteVariant(variantCount: number): boolean {
    return variantCount > 1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/utils/tests/engineVariants.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/engineVariants.ts src/utils/tests/engineVariants.test.ts
git commit -m "$(cat <<'EOF'
Add engine variant data model and pure helpers

New EngineVariant type/schema plus create/duplicate/getDefault/
withDefault helpers, forming the base for a per-engine variants
system.
EOF
)"
```

---

## Task 2: Migration from old flat settings/go to variants

**Files:**
- Create: `src/utils/engineVariantsMigration.ts`
- Test: `src/utils/tests/engineVariantsMigration.test.ts`

**Interfaces:**
- Consumes: `createVariant`, `DEFAULT_GO_MODE`, `EngineVariant` from `./engineVariants` (Task 1).
- Produces: `migrateEngineRecord(raw: unknown): unknown`, used as a `z.preprocess` step in Task 3.

- [ ] **Step 1: Write the failing tests**

```ts
// src/utils/tests/engineVariantsMigration.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/utils/tests/engineVariantsMigration.test.ts`
Expected: FAIL — `../engineVariantsMigration` module does not exist.

- [ ] **Step 3: Implement `src/utils/engineVariantsMigration.ts`**

```ts
import type { GoMode } from "@/bindings";
import { createVariant, DEFAULT_GO_MODE, type EngineVariant } from "./engineVariants";

// Rodent II's bundled personality files (personalities/<group>/<name>.txt), each a curated list
// of eval-weight/search-limit overrides rather than a single Elo dial. Copied here only to seed
// each Rodent II install's migrated variants once - this is not a live, user-facing preset
// system anymore, so it doesn't need to live in its own module. Book file options are dropped
// since they reference paths relative to Rodent II's own install layout, which may not exist
// alongside the copied binary.
const RODENT_II_PERSONALITIES: { name: string; options: [string, string | number][] }[] = [
    {
        name: "Frank (School)",
        options: [
            ["KingTropism", 100],
            ["OwnMobility", 100],
            ["OppMobility", 100],
            ["Forwardness", 100],
            ["PstStyle", 2],
            ["NpsLimit", 88],
            ["EvalBlur", 36],
            ["SlowMover", 100],
            ["Selectivity", 175],
        ],
    },
    {
        name: "Amy (School)",
        options: [
            ["OwnAttack", 200],
            ["OppAttack", 100],
            ["OwnMobility", 200],
            ["OppMobility", 100],
            ["NpsLimit", 64],
            ["EvalBlur", 48],
            ["SlowMover", 150],
            ["Selectivity", 175],
        ],
    },
    {
        name: "Chris (School)",
        options: [
            ["OwnAttack", 100],
            ["OppAttack", 100],
            ["OwnMobility", 100],
            ["OppMobility", 120],
            ["NpsLimit", 72],
            ["EvalBlur", 48],
            ["SlowMover", 100],
            ["Selectivity", 175],
        ],
    },
    {
        name: "Mark (Club)",
        options: [
            ["OwnAttack", 100],
            ["OppAttack", 120],
            ["OwnMobility", 120],
            ["OppMobility", 100],
            ["NpsLimit", 450],
            ["EvalBlur", 50],
            ["SlowMover", 100],
            ["Selectivity", 175],
        ],
    },
    {
        name: "Dory (School)",
        options: [
            ["OwnAttack", 100],
            ["OppAttack", 150],
            ["OwnMobility", 100],
            ["OppMobility", 150],
            ["MobilityStyle", 1],
            ["NpsLimit", 88],
            ["EvalBlur", 36],
            ["SlowMover", 100],
            ["Selectivity", 175],
        ],
    },
    {
        name: "Ben (School)",
        options: [
            ["OwnAttack", 100],
            ["OppAttack", 100],
            ["OwnMobility", 100],
            ["OppMobility", 100],
            ["NpsLimit", 64],
            ["EvalBlur", 24],
            ["SlowMover", 100],
            ["Selectivity", 175],
        ],
    },
    {
        name: "Arthur (League)",
        options: [
            ["OwnAttack", 120],
            ["OppAttack", 100],
            ["OwnMobility", 100],
            ["OppMobility", 120],
            ["PawnStructure", 120],
            ["Outposts", 120],
            ["MobilityStyle", 1],
            ["NpsLimit", 3000],
            ["EvalBlur", 0],
            ["SlowMover", 120],
            ["Selectivity", 175],
        ],
    },
    {
        name: "Theresa (League)",
        options: [
            ["Material", 90],
            ["OwnAttack", 50],
            ["OppAttack", 70],
            ["OwnMobility", 120],
            ["OppMobility", 100],
            ["PiecePressure", 150],
            ["Lines", 105],
            ["Outposts", 110],
            ["NpsLimit", 5500],
            ["EvalBlur", 0],
            ["SlowMover", 100],
            ["Selectivity", 175],
        ],
    },
    {
        name: "Victor (Masters)",
        options: [
            ["Material", 90],
            ["OwnAttack", 120],
            ["OppAttack", 100],
            ["OwnMobility", 120],
            ["OppMobility", 100],
            ["KingTropism", 50],
            ["Lines", 120],
            ["Forwardness", 50],
            ["PstStyle", 2],
            ["NpsLimit", 28000],
            ["EvalBlur", 0],
            ["SlowMover", 100],
            ["Selectivity", 175],
        ],
    },
    {
        name: "Nancy (Masters)",
        options: [
            ["OwnAttack", 120],
            ["OppAttack", 100],
            ["OwnMobility", 100],
            ["OppMobility", 120],
            ["KnightLikesClosed", 8],
            ["Outposts", 120],
            ["NpsLimit", 30000],
            ["EvalBlur", 0],
            ["SlowMover", 100],
            ["Selectivity", 175],
        ],
    },
];

const RODENT_II_NAME_RE = /rodent\s*ii\b/i;

function mergeSettings(
    base: { name: string; value: string | number | boolean | null }[],
    overrides: [string, string | number][],
): { name: string; value: string | number | boolean | null }[] {
    const overrideNames = new Set(overrides.map(([name]) => name));
    const remaining = base.filter((s) => !overrideNames.has(s.name));
    return [...remaining, ...overrides.map(([name, value]) => ({ name, value }))];
}

/**
 * Upgrades a raw, pre-variants engine record (top-level `settings`/`go`) to the current
 * `variants` shape. Runs as a `z.preprocess` step ahead of `engineSchema` (see engines.ts), so
 * it only needs to handle whatever raw JSON was actually persisted; the schema itself still
 * rejects anything malformed afterward. Idempotent: a record that already has `variants` is
 * returned unchanged, so this keeps working correctly forever without needing a version marker.
 */
export function migrateEngineRecord(raw: unknown): unknown {
    if (typeof raw !== "object" || raw === null) return raw;
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.variants)) return raw;

    const { settings, go, ...rest } = record;
    const baseSettings = Array.isArray(settings)
        ? (settings as { name: string; value: string | number | boolean | null }[])
        : [];
    const baseGo = (go as GoMode | undefined) ?? DEFAULT_GO_MODE;

    const variants: EngineVariant[] = [createVariant("Default", baseSettings, baseGo)];

    const name = typeof record.name === "string" ? record.name : "";
    if (RODENT_II_NAME_RE.test(name)) {
        for (const personality of RODENT_II_PERSONALITIES) {
            variants.push(
                createVariant(personality.name, mergeSettings(baseSettings, personality.options), baseGo),
            );
        }
    }

    return { ...rest, variants };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/utils/tests/engineVariantsMigration.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/engineVariantsMigration.ts src/utils/tests/engineVariantsMigration.test.ts
git commit -m "$(cat <<'EOF'
Add one-time migration from flat engine settings to variants

Upgrades old settings/go records into a single Default variant, and
seeds Rodent II's 10 bundled personalities as real, editable variants
on first read.
EOF
)"
```

---

## Task 3: Wire the new schema and migration into `src/utils/engines.ts`

**Files:**
- Modify: `src/utils/engines.ts`
- Modify: `src/utils/tests/syzygy.test.ts`

**Interfaces:**
- Consumes: everything from Task 1 (`engineVariantSchema`, `EngineVariant`, `getDefaultVariant`, `withDefaultVariant`, `createVariant`, `duplicateVariant`, `canDeleteVariant`, `DEFAULT_GO_MODE`, `engineSettingsSchema`, `EngineSettings`) and Task 2 (`migrateEngineRecord`).
- Produces: `LocalEngine`/`RemoteEngine`/`Engine` now have `variants: EngineVariant[]` instead of `settings`/`go`. Re-exports `EngineSettings`, `engineSettingsSchema`, `EngineVariant`, `createVariant`, `duplicateVariant`, `canDeleteVariant`, `getDefaultVariant`, `withDefaultVariant`, `DEFAULT_GO_MODE` from `./engineVariants`, so every existing `import ... from "@/utils/engines"` across the codebase keeps working without a source-wide import-path rewrite.

- [ ] **Step 1: Update `src/utils/engines.ts`**

Replace the whole file:

```ts
import { fetch } from "@tauri-apps/plugin-http";
import type { Platform } from "@tauri-apps/plugin-os";
import useSWR from "swr";
import { z } from "zod";
import { type BestMoves, commands, type EngineOptions, type GoMode } from "@/bindings";
import { engineVariantSchema, getDefaultVariant, withDefaultVariant } from "./engineVariants";
import { migrateEngineRecord } from "./engineVariantsMigration";
import { unwrap } from "./unwrap";

export {
    canDeleteVariant,
    createVariant,
    DEFAULT_GO_MODE,
    duplicateVariant,
    type EngineSettings,
    engineSettingsSchema,
    type EngineVariant,
    getDefaultVariant,
    withDefaultVariant,
} from "./engineVariants";

export const requiredEngineSettings = ["MultiPV", "Threads", "Hash"];

const localEngineSchema = z.object({
    type: z.literal("local"),
    id: z.string().default(() => crypto.randomUUID()),
    name: z.string(),
    version: z.string(),
    path: z.string(),
    image: z.string().nullish(),
    elo: z.number().nullish(),
    downloadSize: z.number().nullish(),
    downloadLink: z.string().nullish(),
    loaded: z.boolean().nullish(),
    enabled: z.boolean().nullish(),
    variants: z.array(engineVariantSchema).min(1),
});

export type LocalEngine = z.output<typeof localEngineSchema>;

const remoteEngineSchema = z.object({
    type: z.enum(["chessdb", "lichess"]),
    id: z.string().default(() => crypto.randomUUID()),
    name: z.string(),
    url: z.string(),
    image: z.string().nullish(),
    loaded: z.boolean().nullish(),
    enabled: z.boolean().nullish(),
    variants: z.array(engineVariantSchema).min(1),
});

export type RemoteEngine = z.output<typeof remoteEngineSchema>;

export const engineSchema = z.preprocess(
    migrateEngineRecord,
    z.union([localEngineSchema, remoteEngineSchema]),
);
export type Engine = z.output<typeof engineSchema>;

export function stopEngine(engine: LocalEngine, tab: string): Promise<void> {
    return commands.stopEngine(engine.id, tab).then((r) => {
        unwrap(r);
    });
}

export function killEngine(engine: LocalEngine, tab: string): Promise<void> {
    return commands.killEngine(engine.id, tab).then((r) => {
        unwrap(r);
    });
}

export function getBestMoves(
    engine: LocalEngine,
    tab: string,
    goMode: GoMode,
    options: EngineOptions,
): Promise<[number, BestMoves[]] | null> {
    return commands
        .getBestMoves(engine.id, engine.path, tab, goMode, options)
        .then((r) => unwrap(r));
}

export function useDefaultEngines(os: Platform | undefined, opened: boolean) {
    const { data, error, isLoading } = useSWR(opened ? os : null, async (os: Platform) => {
        const bmi2: boolean = await commands.isBmi2Compatible();
        const data = await fetch(`https://www.encroissant.org/engines?os=${os}&bmi2=${bmi2}`, {
            method: "GET",
        });
        if (!data.ok) {
            throw new Error("Failed to fetch engines");
        }
        return (await data.json()).filter(
            (e: { os: Platform; bmi2: boolean }) => e.os === os && e.bmi2 === bmi2,
        );
    });
    return {
        defaultEngines: data as LocalEngine[],
        error,
        isLoading,
    };
}

export function applySyzygyPathToEngine(engine: LocalEngine, syzygyPath: string): LocalEngine {
    return {
        ...engine,
        variants: engine.variants.map((variant) => {
            const settings = [...variant.settings];
            const syzygyIndex = settings.findIndex((s) => s.name.toLowerCase() === "syzygypath");
            if (syzygyIndex >= 0) {
                settings[syzygyIndex] = {
                    ...settings[syzygyIndex],
                    value: syzygyPath,
                };
            } else {
                settings.push({
                    name: "SyzygyPath",
                    value: syzygyPath,
                });
            }
            return { ...variant, settings };
        }),
    };
}

export function applySyzygyPathToAllEngines(engines: Engine[], syzygyPath: string): Engine[] {
    return engines.map((engine) => {
        if (engine.type !== "local") return engine;
        return applySyzygyPathToEngine(engine, syzygyPath);
    });
}
```

- [ ] **Step 2: Update `src/utils/tests/syzygy.test.ts`**

```ts
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
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `pnpm test src/utils/tests/syzygy.test.ts`
Expected: PASS (3 tests). Note: the rest of the app won't typecheck yet (many files still reference the old `settings`/`go` fields) — that's expected until Tasks 4-11 land; `pnpm lint` is not run as a gate until Task 11.

- [ ] **Step 4: Commit**

```bash
git add src/utils/engines.ts src/utils/tests/syzygy.test.ts
git commit -m "$(cat <<'EOF'
Switch Engine schema to variants, migrating old settings/go on read

LocalEngine/RemoteEngine now carry variants: EngineVariant[] instead
of a single settings/go pair. A z.preprocess step transparently
upgrades old-shape engines.json data. applySyzygyPathTo(Engine|
AllEngines) now applies across every variant.
EOF
)"
```

---

## Task 4: Update engine-creation call sites to build a variants array

**Files:**
- Modify: `src/components/engines/EngineForm.tsx`
- Modify: `src/components/engines/AddEngine.tsx`

**Interfaces:**
- Consumes: `createVariant` from `@/utils/engines` (Task 1, re-exported via Task 3).

- [ ] **Step 1: Update `EngineForm.tsx`'s submit handler**

In `src/components/engines/EngineForm.tsx`, update the import and the `onSubmit` call:

```ts
import { createVariant, type LocalEngine, requiredEngineSettings } from "@/utils/engines";
```

```tsx
    <form
      onSubmit={form.onSubmit(async (values) =>
        onSubmit({ ...values, loaded: true, variants: [createVariant("Default", settings || [])] }),
      )}
    >
```

- [ ] **Step 2: Update `AddEngine.tsx`'s initial form values and cloud-engine creation**

In `src/components/engines/AddEngine.tsx`:

```ts
import { createVariant, type LocalEngine, type RemoteEngine } from "@/utils/engines";
```

Update `useForm<LocalEngine>`'s `initialValues` to include `variants` (it's a required field now, even though its length isn't checked at the type level — `onSubmit` always overwrites it before the value reaches `enginesAtom`):

```ts
  const form = useForm<LocalEngine>({
    initialValues: {
      type: "local",
      id: crypto.randomUUID(),
      version: "",
      name: "",
      path: "",
      image: "",
      elo: undefined,
      variants: [],
    },
    ...
```

Update `CloudCard`'s click handler:

```tsx
          <Button
            disabled={(engines ?? []).some((e) => e.type === engine.type)}
            fullWidth
            size="xs"
            onClick={() => {
              setEngines(async (prev) => [
                ...(await prev),
                {
                  ...engine,
                  id: crypto.randomUUID(),
                  type: engine.type,
                  loaded: true,
                  variants: [createVariant("Default", [{ name: "MultiPV", value: "1" }])],
                },
              ]);
            }}
          >
```

- [ ] **Step 3: Verify**

Run: `pnpm test`
Expected: PASS (no test covers these files directly, but this confirms nothing else broke)

There is no isolated way to typecheck just these two files yet (many other files still reference the old shape) — full typecheck happens as a gate in Task 11.

- [ ] **Step 4: Commit**

```bash
git add src/components/engines/EngineForm.tsx src/components/engines/AddEngine.tsx
git commit -m "$(cat <<'EOF'
Build a Default variant when creating new engines

Local engine installs and cloud engine (ChessDB/Lichess) additions
now seed a single Default variant instead of top-level settings.
EOF
)"
```

---

## Task 5: Repoint Analysis-panel and report-generation consumers at the default variant

**Files:**
- Modify: `src/state/atoms.ts` (`allEnabledAtom`, `enableAllAtom`, ~lines 731-763)
- Modify: `src/components/panels/analysis/BestMoves.tsx` (~lines 83-115)
- Modify: `src/components/common/DetachedEval.tsx` (~lines 25-44)
- Modify: `src/components/boards/EvalListener.tsx` (~lines 126-133)
- Modify: `src/components/panels/analysis/EngineSettingsForm.tsx` (`SyncSettings`, ~lines 163-201)
- Modify: `src/components/panels/analysis/ReportModal.tsx` (~line 83)

**Interfaces:**
- Consumes: `getDefaultVariant`, `withDefaultVariant` from `@/utils/engines` (Task 1/3).

This task is plumbing-only: it keeps every one of these files' existing behavior exactly the same, just reading/writing the engine's `variants[0]` instead of its old top-level `settings`/`go`. No UI changes.

- [ ] **Step 1: `src/state/atoms.ts`**

```ts
import { type Engine, type EngineSettings, engineSchema, getDefaultVariant } from "@/utils/engines";
```

(this just adds `getDefaultVariant` to the existing import line — `Engine`/`EngineSettings`/`engineSchema` are unchanged and still used elsewhere in this file)

```ts
export const allEnabledAtom = atom((get) => {
    const engines = get(enginesAtom);
    if (!engines) return false;

    const v = engines
        .filter((e) => e.loaded)
        .every((engine) => {
            const atom = tabEngineSettingsFamily({
                tab: get(activeTabAtom)!,
                engineId: engine.id,
                defaultSettings: engine.type === "local" ? getDefaultVariant(engine).settings : undefined,
                defaultGo: getDefaultVariant(engine).go,
            });
            return get(atom).enabled;
        });

    return v;
});

export const enableAllAtom = atom(null, (get, set, value: boolean) => {
    const engines = get(enginesAtom);
    if (!engines) return;

    for (const engine of engines.filter((e) => e.loaded)) {
        const atom = tabEngineSettingsFamily({
            tab: get(activeTabAtom)!,
            engineId: engine.id,
            defaultSettings: engine.type === "local" ? getDefaultVariant(engine).settings : undefined,
            defaultGo: getDefaultVariant(engine).go,
        });
        set(atom, { ...get(atom), enabled: value });
    }
});
```

- [ ] **Step 2: `src/components/panels/analysis/BestMoves.tsx`**

```ts
import { type Engine, getDefaultVariant, withDefaultVariant } from "@/utils/engines";
```

```tsx
  const activeTab = useAtomValue(activeTabAtom);
  const ev = useAtomValue(engineMovesFamily({ engine: engine.id, tab: activeTab! }));
  const progress = useAtomValue(engineProgressFamily({ engine: engine.id, tab: activeTab! }));
  const [, setEngines] = useAtom(enginesAtom);
  const defaultVariant = getDefaultVariant(engine);
  const [settings, setSettings2] = useAtom(
    tabEngineSettingsFamily({
      engineId: engine.id,
      defaultSettings: defaultVariant.settings,
      defaultGo: defaultVariant.go,
      tab: activeTab!,
    }),
  );

  useEffect(() => {
    if (settings.synced) {
      setSettings2((prev) => ({
        ...prev,
        go: defaultVariant.go,
        settings: defaultVariant.settings,
      }));
    }
  }, [defaultVariant.settings, defaultVariant.go, settings.synced, setSettings2]);

  const setSettings = useCallback(
    (fn: (prev: Settings) => Settings) => {
      const newSettings = fn(settings);
      setSettings2(newSettings);
      if (newSettings.synced) {
        setEngines(async (prev) =>
          (await prev).map((o) =>
            o.id === engine.id
              ? withDefaultVariant(o, { settings: newSettings.settings, go: newSettings.go })
              : o,
          ),
        );
      }
    },
    [engine, settings, setSettings2, setEngines],
  );
```

- [ ] **Step 3: `src/components/common/DetachedEval.tsx`**

This file currently imports only `import type { EngineSettings } from "@/utils/engines";` — add `getDefaultVariant` to it:

```ts
import { type EngineSettings, getDefaultVariant } from "@/utils/engines";
```

```tsx
function DetachedEval() {
  const [detachedEngineId, setDetachedEngineId] = useAtom(currentDetachedEngineAtom);
  const engines = useAtomValue(enginesAtom);

  if (!detachedEngineId || !engines) return null;

  const engine = engines.find((e) => e.id === detachedEngineId);
  if (!engine || !engine.loaded) {
    return null;
  }
  const defaultVariant = getDefaultVariant(engine);

  return (
    <DetachedEvalInner
      engineId={detachedEngineId}
      engineName={engine.name}
      defaultSettings={defaultVariant.settings}
      defaultGo={defaultVariant.go}
      onClose={() => setDetachedEngineId(null)}
    />
  );
}
```

- [ ] **Step 4: `src/components/boards/EvalListener.tsx`**

This file currently imports `type Engine`, `type LocalEngine`, `getBestMoves as localGetBestMoves`, and `stopEngine` from `@/utils/engines` (all still used elsewhere in the file) — add `getDefaultVariant` to that same import block:

```ts
import {
  type Engine,
  type LocalEngine,
  getBestMoves as localGetBestMoves,
  getDefaultVariant,
  stopEngine,
} from "@/utils/engines";
```

```tsx
  const [, setEngineVariation] = useAtom(engineMovesFamily({ engine: engine.id, tab: activeTab! }));
  const defaultVariant = getDefaultVariant(engine);
  const [settings] = useAtom(
    tabEngineSettingsFamily({
      engineId: engine.id,
      defaultSettings: defaultVariant.settings,
      defaultGo: defaultVariant.go,
      tab: activeTab!,
    }),
  );
```

- [ ] **Step 5: `src/components/panels/analysis/EngineSettingsForm.tsx`**

```ts
import { type Engine, type EngineSettings, getDefaultVariant, killEngine } from "@/utils/engines";
```

```tsx
function SyncSettings({
  engine,
  settings,
  setSettings,
}: {
  engine: string;
  settings: Settings;
  setSettings: (fn: (prev: Settings) => Settings) => void;
}) {
  const { t } = useTranslation();

  const engines = useAtomValue(enginesAtom);
  const engineDefault = useMemo(
    () => (engines ?? []).find((o) => o.name === engine)!,
    [engines, engine],
  );

  return (
    <Checkbox
      label={t("Board.Analysis.SyncGlobally")}
      checked={settings.synced}
      onChange={(e) => {
        if (e.currentTarget.checked) {
          const variant = getDefaultVariant(engineDefault);
          setSettings((prev) => ({
            ...prev,
            go: variant.go,
            settings: variant.settings,
            synced: true,
          }));
        } else {
          setSettings((prev) => ({
            ...prev,
            synced: false,
          }));
        }
      }}
    />
  );
}
```

- [ ] **Step 6: `src/components/panels/analysis/ReportModal.tsx`**

```ts
import { getDefaultVariant, type LocalEngine } from "@/utils/engines";
```

```tsx
    const engine = localEngines.find((e) => e.id === form.values.engine);
    const engineSettings = (engine ? getDefaultVariant(engine).settings : []).map((s) => ({
      ...s,
      value: s.value?.toString() ?? "",
    }));
```

- [ ] **Step 7: Verify**

Run: `pnpm test`
Expected: PASS (all existing tests still pass; these files have no dedicated unit tests, so this is a smoke check)

- [ ] **Step 8: Commit**

```bash
git add src/state/atoms.ts src/components/panels/analysis/BestMoves.tsx \
  src/components/common/DetachedEval.tsx src/components/boards/EvalListener.tsx \
  src/components/panels/analysis/EngineSettingsForm.tsx src/components/panels/analysis/ReportModal.tsx
git commit -m "$(cat <<'EOF'
Repoint Analysis panel and report generation at the default variant

Plumbing only: everywhere that used to read/write an engine's
top-level settings/go now uses its default (first) variant instead,
via getDefaultVariant/withDefaultVariant. No UI changes.
EOF
)"
```

---

## Task 6: Reusable `EngineVariantSelect` component

**Files:**
- Create: `src/components/common/EngineVariantSelect.tsx`

**Interfaces:**
- Consumes: `LocalEngine` type from `@/utils/engines`.
- Produces: `EngineVariantSelect({ engine, variantId, setVariantId })` — used by Create Game (Task 10) and Coach settings (Task 9).

- [ ] **Step 1: Implement the component**

```tsx
import { Select } from "@mantine/core";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { LocalEngine } from "@/utils/engines";

/**
 * Picks one of an engine's saved variants. Self-heals like EnginesSelect: if the given
 * variantId doesn't belong to the current engine (missing, deleted, or engine just changed),
 * it snaps to that engine's first (default) variant instead of rendering an invalid selection.
 */
export function EngineVariantSelect({
  engine,
  variantId,
  setVariantId,
}: {
  engine: LocalEngine | null;
  variantId: string | null;
  setVariantId: (id: string) => void;
}) {
  const { t } = useTranslation();
  const variants = engine?.variants ?? [];

  useEffect(() => {
    if (variants.length === 0) return;
    if (!variantId || !variants.some((v) => v.id === variantId)) {
      setVariantId(variants[0].id);
    }
  }, [variants, variantId, setVariantId]);

  if (!engine) return null;

  return (
    <Select
      label={t("Board.Opponent.Variant", "Variant")}
      allowDeselect={false}
      data={variants.map((v) => ({ value: v.id, label: v.name }))}
      value={variantId ?? variants[0]?.id ?? ""}
      onChange={(v) => {
        if (v) setVariantId(v);
      }}
    />
  );
}
```

- [ ] **Step 2: Verify**

Run: `pnpm test`
Expected: PASS (no dedicated test — this repo has no React component test infra; it's exercised by manual verification once wired into Create Game/Coach settings in Tasks 9-10)

- [ ] **Step 3: Commit**

```bash
git add src/components/common/EngineVariantSelect.tsx
git commit -m "$(cat <<'EOF'
Add reusable EngineVariantSelect dropdown

Shared variant picker for an engine, used by both Create Game and
Coach settings.
EOF
)"
```

---

## Task 7: `VariantManager` component for engine management

**Files:**
- Create: `src/components/engines/VariantManager.tsx`

**Interfaces:**
- Consumes: `canDeleteVariant`, `duplicateVariant`, `EngineVariant`, `LocalEngine` from `@/utils/engines`; `ConfirmModal` from `../common/ConfirmModal`.
- Produces: `VariantManager({ engine, selectedVariantId, setSelectedVariantId, setEngine })` — used inside `EnginesPage.tsx`'s per-engine detail pane (Task 8).

- [ ] **Step 1: Implement the component**

```tsx
import { ActionIcon, Button, Group, Modal, Select, Stack, TextInput, Tooltip } from "@mantine/core";
import { IconCopy, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  canDeleteVariant,
  duplicateVariant,
  type EngineVariant,
  type LocalEngine,
} from "@/utils/engines";
import ConfirmModal from "../common/ConfirmModal";

function NamePromptModal({
  opened,
  title,
  initialName,
  onClose,
  onSubmit,
}: {
  opened: boolean;
  title: string;
  initialName: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const { t } = useTranslation();

  return (
    <Modal opened={opened} onClose={onClose} title={title}>
      <Stack>
        <TextInput value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <Group justify="end">
          <Button
            disabled={!name.trim()}
            onClick={() => {
              onSubmit(name.trim());
              onClose();
            }}
          >
            {t("Common.Save")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function VariantManager({
  engine,
  selectedVariantId,
  setSelectedVariantId,
  setEngine,
}: {
  engine: LocalEngine;
  selectedVariantId: string;
  setSelectedVariantId: (id: string) => void;
  setEngine: (engine: LocalEngine) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const variants = engine.variants;
  const selected = variants.find((v) => v.id === selectedVariantId) ?? variants[0];

  function replaceVariant(id: string, next: EngineVariant) {
    setEngine({
      ...engine,
      variants: variants.map((v) => (v.id === id ? next : v)),
    });
  }

  return (
    <>
      <Group align="end" wrap="nowrap">
        <Select
          flex={1}
          label={t("Engines.Settings.Variant", "Variant")}
          allowDeselect={false}
          data={variants.map((v) => ({ value: v.id, label: v.name }))}
          value={selected.id}
          onChange={(v) => v && setSelectedVariantId(v)}
        />
        <Tooltip label={t("Common.AddNew")}>
          <ActionIcon variant="default" size="lg" onClick={() => setAdding(true)}>
            <IconPlus size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Engines.Settings.RenameVariant", "Rename")}>
          <ActionIcon variant="default" size="lg" onClick={() => setRenaming(true)}>
            <IconPencil size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Common.Duplicate")}>
          <ActionIcon
            variant="default"
            size="lg"
            onClick={() => {
              const copy = duplicateVariant(selected, `${selected.name} (Copy)`);
              setEngine({ ...engine, variants: [...variants, copy] });
              setSelectedVariantId(copy.id);
            }}
          >
            <IconCopy size="1rem" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={t("Common.Remove")}>
          <ActionIcon
            variant="default"
            color="red"
            size="lg"
            disabled={!canDeleteVariant(variants.length)}
            onClick={() => setDeleting(true)}
          >
            <IconTrash size="1rem" />
          </ActionIcon>
        </Tooltip>
      </Group>

      <NamePromptModal
        opened={adding}
        title={t("Common.AddNew")}
        initialName={t("Engines.Settings.NewVariant", "New Variant")}
        onClose={() => setAdding(false)}
        onSubmit={(name) => {
          const copy = duplicateVariant(selected, name);
          setEngine({ ...engine, variants: [...variants, copy] });
          setSelectedVariantId(copy.id);
        }}
      />

      <NamePromptModal
        opened={renaming}
        title={t("Engines.Settings.RenameVariant", "Rename")}
        initialName={selected.name}
        onClose={() => setRenaming(false)}
        onSubmit={(name) => replaceVariant(selected.id, { ...selected, name })}
      />

      <ConfirmModal
        title={t("Common.Remove")}
        description={t("Engines.Settings.RemoveVariant", "Remove this variant?")}
        opened={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => {
          const remaining = variants.filter((v) => v.id !== selected.id);
          setEngine({ ...engine, variants: remaining });
          setSelectedVariantId(remaining[0].id);
          setDeleting(false);
        }}
        confirmLabel={t("Common.Remove")}
      />
    </>
  );
}
```

- [ ] **Step 2: Verify**

Run: `pnpm test`
Expected: PASS (no dedicated test; exercised by manual verification once wired into `EnginesPage.tsx` in Task 8)

- [ ] **Step 3: Commit**

```bash
git add src/components/engines/VariantManager.tsx
git commit -m "$(cat <<'EOF'
Add VariantManager: add/rename/duplicate/delete UI for engine variants
EOF
)"
```

---

## Task 8: Wire variant editing into `EnginesPage.tsx`

**Files:**
- Modify: `src/components/engines/EnginesPage.tsx`

**Interfaces:**
- Consumes: `VariantManager` (Task 7), `getDefaultVariant`/`withDefaultVariant`/`EngineVariant`/`RemoteEngine` (Task 1/3).

- [ ] **Step 1: Add `key={selected}` so variant selection resets per engine**

The `EngineSettings` component (rendered for local engines) is not currently remounted when the user picks a different engine in the left grid, since no `key` ties it to `selected`. Add one so its new `selectedVariantId` state (added below) always starts at that engine's first variant:

```tsx
            {selectedEngine.type === "local" ? (
              <EngineSettings key={selected} selected={selected} setSelected={setSelected} />
            ) : (
```

- [ ] **Step 2: Update imports**

```ts
import {
  applySyzygyPathToAllEngines,
  type Engine,
  type EngineVariant,
  engineSchema,
  getDefaultVariant,
  type LocalEngine,
  type RemoteEngine,
  requiredEngineSettings,
  withDefaultVariant,
} from "@/utils/engines";
import { VariantManager } from "./VariantManager";
```

(`VariantManager` is a named export from Task 7, so this must be a named import, not a default one.)

- [ ] **Step 3: Update the remote-engine detail pane's MultiPV editor (~lines 384-410)**

```tsx
              <Stack>
                <Divider variant="dashed" label={t("Common.GeneralSettings")} />

                <TextInput
                  w="50%"
                  label={t("Common.Name")}
                  value={selectedEngine.name}
                  onChange={(e) => {
                    setEngines(async (prev) => {
                      const copy = [...(await prev)];
                      copy[selected].name = e.currentTarget.value;
                      return copy;
                    });
                  }}
                />

                <Divider variant="dashed" label={t("Engines.Settings.AdvancedSettings")} />
                <Stack w="50%">
                  <Text fw="bold">{t("Engines.Settings.NumOfLines")}</Text>
                  <LinesSlider
                    value={
                      Number(
                        getDefaultVariant(selectedEngine).settings.find(
                          (setting) => setting.name === "MultiPV",
                        )?.value,
                      ) || 1
                    }
                    setValue={(v) => {
                      setEngines(async (prev) => {
                        const copy = [...(await prev)];
                        const eng = copy[selected] as RemoteEngine;
                        const variant = getDefaultVariant(eng);
                        const settings = [...variant.settings];
                        const setting = settings.find((s) => s.name === "MultiPV");
                        if (setting) {
                          setting.value = v;
                        } else {
                          settings.push({ name: "MultiPV", value: v });
                        }
                        copy[selected] = withDefaultVariant(eng, { settings });
                        return copy;
                      });
                    }}
                  />
                </Stack>
```

(The rest of that branch — the Remove button — is unchanged.)

- [ ] **Step 4: Rewrite the `EngineSettings` function to be variant-scoped**

Replace the whole `EngineSettings` function body:

```tsx
function EngineSettings({
  selected,
  setSelected,
}: {
  selected: number;
  setSelected: (v: number | null) => void;
}) {
  const { t } = useTranslation();

  const [engines, setEngines] = useAtom(enginesAtom);
  const [globalSyzygyPath] = useAtom(storedSyzygyPathAtom);
  const engine = engines![selected] as LocalEngine;
  const [selectedVariantId, setSelectedVariantId] = useState(engine.variants[0].id);
  const variant = engine.variants.find((v) => v.id === selectedVariantId) ?? engine.variants[0];

  const { data: options } = useSWRImmutable(["engine-config", engine.path], async ([, path]) => {
    return unwrap(await commands.getEngineConfig(path));
  });

  function setEngine(newEngine: LocalEngine) {
    setEngines(async (prev) => {
      const copy = [...(await prev)];
      copy[selected] = newEngine;
      return copy;
    });
  }

  function setVariant(patch: Partial<EngineVariant>) {
    setEngine({
      ...engine,
      variants: engine.variants.map((v) => (v.id === variant.id ? { ...v, ...patch } : v)),
    });
  }

  useEffect(() => {
    if (options) {
      const settings = [...variant.settings];
      const missing = requiredEngineSettings.filter(
        (field) => !settings.find((setting) => setting.name === field),
      );
      for (const field of requiredEngineSettings) {
        if (!settings.find((setting) => setting.name === field)) {
          const option = options.options.find((option) => option.value.name === field);
          if (option && option.type !== "button") {
            settings.push({
              name: field,
              value: option.value.default as string | number | boolean | null,
            });
          }
        }
      }
      const syzygyOption = options.options.find(
        (option) => option.value.name.toLowerCase() === "syzygypath",
      );
      if (
        syzygyOption &&
        globalSyzygyPath &&
        !settings.find((setting) => setting.name.toLowerCase() === "syzygypath")
      ) {
        settings.push({
          name: syzygyOption.value.name,
          value: globalSyzygyPath,
        });
      }
      if (missing.length > 0 || (syzygyOption && globalSyzygyPath)) {
        setVariant({ settings });
      }
    }
  }, [options, globalSyzygyPath, variant.id]);

  const syzygyOption = options?.options.find(
    (option) => option.value.name.toLowerCase() === "syzygypath",
  );
  const currentEngineSyzygyPath = variant.settings.find(
    (s) => s.name.toLowerCase() === "syzygypath",
  )?.value as string | undefined;

  const completeOptions =
    options?.options
      .filter(
        (option) => option.type !== "button" && option.value.name.toLowerCase() !== "syzygypath",
      )
      .map((option) => {
        const setting = variant.settings.find((setting) => setting.name === option.value.name);
        const defaultValue = "default" in option.value ? option.value.default : null;
        return {
          ...option,
          value: {
            ...option.value,
            value: setting?.value !== undefined ? setting.value : defaultValue,
          },
        };
      }) || [];

  function changeImage() {
    open({
      title: "Select image",
      filters: [{ name: "Image", extensions: ["png", "jpeg", "jpg", "svg", "webp"] }],
    }).then(async (res) => {
      if (typeof res === "string") {
        const enginesDir = await getEnginesDir();
        const imageName = res.split(/[/\\]/).pop() || "engine_image.png";
        const destPath = await resolve(enginesDir, imageName);

        if (res !== destPath) {
          try {
            await copyFile(res, destPath);
          } catch (e) {
            console.error("Failed to copy image to engines directory:", e);
          }
        }

        const targetImagePath = (await exists(destPath)) ? destPath : res;
        setEngine({ ...engine, image: targetImagePath });
      }
    });
  }

  function setSetting(
    name: string,
    value: string | number | boolean | null,
    def: string | number | boolean | null,
  ) {
    const newSettings = [...variant.settings];
    const setting = newSettings.find((setting) => setting.name === name);
    if (setting) {
      setting.value = value;
    } else {
      newSettings.push({ name, value });
    }
    if (value !== def || requiredEngineSettings.includes(name)) {
      setVariant({ settings: newSettings });
    } else {
      setVariant({ settings: newSettings.filter((setting) => setting.name !== name) });
    }
  }

  const [deleteModal, toggleDeleteModal] = useToggle();
  const [jsonModal, toggleJSONModal] = useToggle();

  return (
    <ScrollArea h="100%" offsetScrollbars>
      <Stack>
        <Divider variant="dashed" label={t("Common.GeneralSettings")} />
        <Group grow align="start" wrap="nowrap">
          <Stack>
            <Group wrap="nowrap" w="100%">
              <TextInput
                flex={1}
                label={t("Common.Name")}
                value={engine.name}
                onChange={(e) => setEngine({ ...engine, name: e.currentTarget.value })}
              />
              <TextInput
                label={t("Common.Version")}
                w="5rem"
                value={engine.version}
                placeholder="?"
                onChange={(e) => setEngine({ ...engine, version: e.currentTarget.value })}
              />
            </Group>
            <Group grow>
              <NumberInput
                label="ELO"
                value={engine.elo || undefined}
                min={0}
                placeholder={t("Common.Unknown")}
                onChange={(v) =>
                  setEngine({
                    ...engine,
                    elo: typeof v === "number" ? v : undefined,
                  })
                }
              />
            </Group>
          </Stack>
          <Center>
            {engine.image ? (
              <Paper withBorder style={{ cursor: "pointer" }} onClick={changeImage}>
                <LocalImage
                  src={engine.image}
                  alt={engine.name}
                  mah="10rem"
                  maw="100%"
                  fit="contain"
                />
              </Paper>
            ) : (
              <ActionIcon
                size="10rem"
                variant="subtle"
                styles={{
                  root: {
                    border: "1px dashed",
                  },
                }}
                onClick={changeImage}
              >
                <IconPhotoPlus size="2.5rem" />
              </ActionIcon>
            )}
          </Center>
        </Group>

        <Divider variant="dashed" label={t("Engines.Settings.Variant", "Variant")} />
        <VariantManager
          engine={engine}
          selectedVariantId={variant.id}
          setSelectedVariantId={setSelectedVariantId}
          setEngine={setEngine}
        />

        <Divider variant="dashed" label={t("Engines.Settings.SearchSettings")} />
        <GoModeInput goMode={variant.go} setGoMode={(v) => setVariant({ go: v })} />

        {syzygyOption && (
          <>
            <Divider variant="dashed" label="Endgame Tablebases (Syzygy)" />
            <Paper withBorder radius="md" p="sm">
              <Group justify="space-between" align="center" wrap="nowrap">
                <Group gap="sm" wrap="nowrap" style={{ overflow: "hidden" }}>
                  <ThemeIcon
                    size="md"
                    radius="md"
                    variant="light"
                    color={currentEngineSyzygyPath ? "teal" : "gray"}
                  >
                    <IconDatabase size="1rem" />
                  </ThemeIcon>
                  <div style={{ overflow: "hidden" }}>
                    <Text size="sm" fw={600}>
                      Syzygy Endgame Tablebases
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {globalSyzygyPath
                        ? `Using global path: ${globalSyzygyPath}`
                        : "No global tablebase path set (configure in Settings)"}
                    </Text>
                  </div>
                </Group>
                <Switch
                  size="md"
                  checked={Boolean(currentEngineSyzygyPath)}
                  onChange={(e) => {
                    const enabled = e.currentTarget.checked;
                    setSetting(
                      syzygyOption.value.name,
                      enabled ? globalSyzygyPath || "default" : "",
                      "default" in syzygyOption.value
                        ? (syzygyOption.value.default as string | null)
                        : null,
                    );
                  }}
                />
              </Group>
            </Paper>
          </>
        )}

        <Divider variant="dashed" label={t("Engines.Settings.AdvancedSettings")} />
        <SimpleGrid cols={2}>
          {completeOptions
            .filter((option: { type: string }) => option.type !== "check")
            .map((option: any) => {
              return match(option)
                .with({ type: "spin", value: P.select() }, (v: any) => {
                  return (
                    <NumberInput
                      key={v.name}
                      label={v.name}
                      min={Number(v.min)}
                      max={Number(v.max)}
                      value={Number(v.value)}
                      onChange={(e) => setSetting(v.name, e, Number(v.default))}
                    />
                  );
                })
                .with({ type: "combo", value: P.select() }, (v: any) => {
                  return (
                    <Select
                      key={v.name}
                      label={v.name}
                      data={Array.from(new Set(v.var ?? []))}
                      value={v.value}
                      onChange={(e) => setSetting(v.name, e, v.default)}
                    />
                  );
                })
                .with({ type: "string", value: P.select() }, (v: any) => {
                  if (v.name.toLowerCase().includes("file")) {
                    const file = v.value ? new File([v.value], v.value) : null;
                    return (
                      <FileInput
                        key={v.name}
                        clearable
                        label={v.name}
                        value={file}
                        onClick={async () => {
                          const selected = await open({
                            multiple: false,
                          });
                          if (!selected) return;
                          setSetting(v.name, selected as string, v.default);
                        }}
                        onChange={(e) => {
                          if (e === null) {
                            setSetting(v.name, null, v.default);
                          }
                        }}
                      />
                    );
                  }
                  return (
                    <TextInput
                      key={v.name}
                      label={v.name}
                      value={v.value || ""}
                      onChange={(e) => setSetting(v.name, e.currentTarget.value, v.default)}
                    />
                  );
                })
                .otherwise(() => null);
            })}
        </SimpleGrid>
        <SimpleGrid cols={2}>
          {completeOptions
            .filter((option) => option.type === "check")
            .map((o) => {
              return (
                <Checkbox
                  key={o.value.name}
                  label={o.value.name}
                  checked={!!o.value.value}
                  disabled={o.value.name === "UCI_Chess960"}
                  onChange={(e) => {
                    const defVal = "default" in o.value ? (o.value.default as boolean) : false;
                    setSetting(o.value.name, e.currentTarget.checked, defVal);
                  }}
                />
              );
            })}
        </SimpleGrid>

        <Group justify="end">
          <Button variant="default" onClick={() => toggleJSONModal(true)}>
            {t("Engines.Settings.EditJSON")}
          </Button>
          <Button
            variant="default"
            onClick={() =>
              setVariant({
                settings: options?.options
                  .filter((option) => requiredEngineSettings.includes(option.value.name))
                  .filter((option) => option.type !== "button")
                  .map((option) => ({
                    name: option.value.name,
                    value: option.value.default as string | number | boolean | null,
                  })),
              })
            }
          >
            {t("Engines.Settings.Reset")}
          </Button>
          <Button
            leftSection={<IconCopy size="1rem" />}
            variant="default"
            onClick={() => {
              const duplicatedEngine: LocalEngine = {
                ...engine,
                id: crypto.randomUUID(),
                name: `${engine.name} (Copy)`,
              };
              setEngines(async (prev) => {
                const copy = [...(await prev)];
                copy.splice(selected + 1, 0, duplicatedEngine);
                return copy;
              });
              setSelected(selected + 1);
            }}
          >
            {t("Common.Duplicate")}
          </Button>
          <Button color="red" onClick={() => toggleDeleteModal()}>
            {t("Common.Remove")}
          </Button>
        </Group>
        <ConfirmModal
          title={t("Engines.Remove.Title")}
          description={t("Engines.Remove.Message")}
          opened={deleteModal}
          onClose={toggleDeleteModal}
          onConfirm={() => {
            setEngines(async (prev) => (await prev).filter((e) => e.name !== engine.name));
            setSelected(null);
            toggleDeleteModal();
          }}
          confirmLabel={t("Common.Remove")}
        />
      </Stack>
      <JSONModal
        key={engine.name}
        opened={jsonModal}
        toggleOpened={toggleJSONModal}
        engine={engine}
        setEngine={(v) =>
          setEngines(async (prev) => {
            const copy = [...(await prev)];
            copy[selected] = v;
            return copy;
          })
        }
      />
    </ScrollArea>
  );
}
```

(`JSONModal` is unchanged — it already round-trips the whole `Engine` object through `engineSchema.safeParse`, so it transparently gains `variants`.)

- [ ] **Step 2: Manual verification (dev server)**

Run: `pnpm dev:tauri`

1. Open Engines page, select a local engine.
2. Add a variant, confirm it appears in the dropdown and is auto-selected.
3. Edit a UCI option on the new variant, switch back to "Default", confirm the option value differs between the two (proving they're independently stored).
4. Rename the new variant, confirm the name updates in the dropdown.
5. Duplicate a variant, confirm a "(Copy)" appears and both retain the same settings.
6. Delete a variant, confirm it's removed and the switcher lands on a remaining one.
7. With only one variant left, confirm the Delete icon is disabled.
8. Click "Reset" — confirm it resets only the selected variant's advanced options, not other variants.
9. For a remote (ChessDB/Lichess) engine, confirm its lightweight MultiPV slider still works.
10. Use "Edit JSON", confirm the `variants` array round-trips correctly.

- [ ] **Step 3: Commit**

```bash
git add src/components/engines/EnginesPage.tsx
git commit -m "$(cat <<'EOF'
Scope EnginesPage's option editor to the selected variant

Adds a VariantManager switcher above the existing GoMode/Syzygy/UCI-
option editor, so every field there now edits one named variant
instead of the engine's single settings blob.
EOF
)"
```

---

## Task 9: Coach settings switch to picking a variant

**Files:**
- Modify: `src/state/atoms.ts` (`CoachEngineConfig`, `liveEvalEngineConfigAtom`, `hintEngineConfigAtom`)
- Modify: `src/hooks/useLiveCoachEngine.ts`
- Modify: `src/hooks/useCoachHint.ts`
- Modify: `src/components/settings/CoachSettingsTab.tsx`

**Interfaces:**
- Consumes: `getDefaultVariant` from `@/utils/engines` (Task 1/3); `EngineVariantSelect` from `@/components/common/EngineVariantSelect` (Task 6).
- Produces: `CoachEngineConfig = { engineId: string | null; variantId: string | null }` (drops `go`/`settings`).

- [ ] **Step 1: Update `CoachEngineConfig` and its atoms in `src/state/atoms.ts`**

```ts
export type CoachEngineConfig = {
    engineId: string | null;
    variantId: string | null;
};

export const liveEvalEngineConfigAtom = atomWithStorage<CoachEngineConfig>(
    "live-eval-engine-config",
    { engineId: null, variantId: null },
);

export const hintEngineConfigAtom = atomWithStorage<CoachEngineConfig>(
    "hint-engine-config",
    { engineId: null, variantId: null },
);
```

(If the old atom keys' persisted values on disk still have `go`/`settings` fields from before this change, `atomWithStorage` will just carry those unused extra keys forward in localStorage until next write — harmless, since nothing reads them anymore.)

- [ ] **Step 2: Update `src/hooks/useLiveCoachEngine.ts`**

This file already imports `{ type BestMoves, commands, events }` from `@/bindings` and `type LocalEngine` from `@/utils/engines` — extend both of those existing import statements rather than adding new ones:

```ts
import { type BestMoves, commands, events, type GoMode } from "@/bindings";
```

```ts
import { getDefaultVariant, type LocalEngine } from "@/utils/engines";

const DEFAULT_COACH_GO_MODE: GoMode = { t: "Time", c: 300 };
```

```ts
    const config = useAtomValue(liveEvalEngineConfigAtom);

    const engines = useAtomValue(enginesAtom);
    const engine = useMemo(() => {
        const loadedLocal = (engines ?? []).filter(
            (e): e is LocalEngine => e.type === "local" && !!e.loaded,
        );
        return loadedLocal.find((e) => e.id === config.engineId) ?? loadedLocal[0] ?? null;
    }, [engines, config.engineId]);

    const variant = useMemo(
        () =>
            engine
                ? (engine.variants.find((v) => v.id === config.variantId) ?? getDefaultVariant(engine))
                : null,
        [engine, config.variantId],
    );

    const goMode = variant?.go ?? DEFAULT_COACH_GO_MODE;
    // Merge the MultiPV floor into whatever is configured rather than only using
    // it when nothing is configured: any UI write of the engine's own UCI
    // defaults (MultiPV 1 for a stock Stockfish) would otherwise silently and
    // permanently disable "Good" move detection. See `withMultiPvFloor`.
    const extraOptions = useMemo(
        () => withMultiPvFloor(variant?.settings ?? []),
        [variant],
    );
```

(The rest of the hook is unchanged — `goMode` and `extraOptions` are consumed downstream exactly as before.)

- [ ] **Step 3: Update `src/hooks/useCoachHint.ts`**

This file already imports `{ type BestMoves, commands, events }` from `@/bindings` and `type LocalEngine` from `@/utils/engines` — extend both of those existing import statements rather than adding new ones:

```ts
import { type BestMoves, commands, events, type GoMode } from "@/bindings";
```

```ts
import { getDefaultVariant, type LocalEngine } from "@/utils/engines";

const DEFAULT_COACH_GO_MODE: GoMode = { t: "Time", c: 300 };
```

```ts
    const config = useAtomValue(hintEngineConfigAtom);

    const engines = useAtomValue(enginesAtom);
    const engine = useMemo(() => {
        const loadedLocal = (engines ?? []).filter(
            (e): e is LocalEngine => e.type === "local" && !!e.loaded,
        );
        return loadedLocal.find((e) => e.id === config.engineId) ?? loadedLocal[0] ?? null;
    }, [engines, config.engineId]);

    const variant = useMemo(
        () =>
            engine
                ? (engine.variants.find((v) => v.id === config.variantId) ?? getDefaultVariant(engine))
                : null,
        [engine, config.variantId],
    );

    const goMode = variant?.go ?? DEFAULT_COACH_GO_MODE;
    const isContinuous = goMode.t === "Infinite";
    const isStreaming = goMode.t === "Infinite" || goMode.t === "PlayersTime";
    const extraOptions = useMemo(() => {
        const settings = variant?.settings ?? [];
        return settings.length > 0
            ? settings.map((s) => ({ name: s.name, value: s.value?.toString() ?? "" }))
            : [{ name: "MultiPV", value: "1" }];
    }, [variant]);
```

- [ ] **Step 4: Rewrite `src/components/settings/CoachSettingsTab.tsx`**

```tsx
import { Stack, Text } from "@mantine/core";
import { useAtom, useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { EnginesSelect } from "@/components/boards/EnginesSelect";
import { EngineVariantSelect } from "@/components/common/EngineVariantSelect";
import {
  type CoachEngineConfig,
  enginesAtom,
  hintEngineConfigAtom,
  liveEvalEngineConfigAtom,
} from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";

function CoachEngineSection({
  configAtom,
  title,
  description,
}: {
  configAtom: typeof liveEvalEngineConfigAtom | typeof hintEngineConfigAtom;
  title: string;
  description: string;
}) {
  const { t } = useTranslation();
  const [config, setConfig] = useAtom(configAtom);
  const allEngines = useAtomValue(enginesAtom);
  // Must match what `useLiveCoachEngine`/`useCoachHint` accept: they only ever
  // use loaded local engines and silently fall back to the first loaded one
  // otherwise, so offering unloaded engines here would let the user "select" an
  // engine the coach never actually runs.
  const localEngines = (allEngines ?? []).filter(
    (e): e is LocalEngine => e.type === "local" && !!e.loaded,
  );
  const selectedEngine = localEngines.find((e) => e.id === config.engineId) ?? null;

  const setEngine = (engine: LocalEngine | null) => {
    setConfig((prev: CoachEngineConfig) => ({
      ...prev,
      engineId: engine?.id ?? null,
      variantId: engine?.variants[0]?.id ?? null,
    }));
  };

  const setVariantId = (variantId: string) => {
    setConfig((prev) => ({ ...prev, variantId }));
  };

  return (
    <Stack gap="xs">
      <Text fw={500}>{title}</Text>
      <Text size="xs" c="dimmed">
        {description}
      </Text>
      {localEngines.length === 0 ? (
        <Text size="xs" c="dimmed">
          {t("Settings.Coach.NoEngines")}
        </Text>
      ) : (
        <EnginesSelect engine={selectedEngine} setEngine={setEngine} filter={(e) => !!e.loaded} />
      )}
      {selectedEngine && (
        <EngineVariantSelect
          engine={selectedEngine}
          variantId={config.variantId}
          setVariantId={setVariantId}
        />
      )}
    </Stack>
  );
}

export default function CoachSettingsTab() {
  const { t } = useTranslation();

  return (
    <Stack>
      <CoachEngineSection
        configAtom={liveEvalEngineConfigAtom}
        title={t("Settings.Coach.LiveEval")}
        description={t("Settings.Coach.LiveEval.Desc")}
      />
      <CoachEngineSection
        configAtom={hintEngineConfigAtom}
        title={t("Settings.Coach.Hint")}
        description={t("Settings.Coach.Hint.Desc")}
      />
    </Stack>
  );
}
```

- [ ] **Step 5: Manual verification (dev server)**

Run: `pnpm dev:tauri`

1. Open Settings → Coach tab. Pick an engine for Live Eval, confirm the Variant dropdown appears and defaults to "Default".
2. Switch to a non-default variant, start a game, enable live eval, confirm the eval bar still updates.
3. Do the same for the Hint role, request a hint mid-game, confirm it still returns a move (proving `withMultiPvFloor`'s floor is still applied on top of the chosen variant).

- [ ] **Step 6: Commit**

```bash
git add src/state/atoms.ts src/hooks/useLiveCoachEngine.ts src/hooks/useCoachHint.ts \
  src/components/settings/CoachSettingsTab.tsx
git commit -m "$(cat <<'EOF'
Switch Coach settings to picking a saved variant

Live-eval and hint engine configs now reference {engineId, variantId}
instead of carrying their own go/settings, reusing EngineVariantSelect.
EOF
)"
```

---

## Task 10: Create Game switches to a variant dropdown

**Files:**
- Modify: `src/components/boards/OpponentForm.tsx`
- Modify: `src/components/boards/BoardGame.tsx`

**Interfaces:**
- Consumes: `EngineVariantSelect` (Task 6), `getDefaultVariant` (Task 1/3).
- Produces: `OpponentSettings`'s engine branch becomes `{ type: "engine"; timeControl?; engine: LocalEngine | null; variantId: string | null; timeUnit?; incrementUnit? }`.

- [ ] **Step 1: Rewrite `src/components/boards/OpponentForm.tsx`**

```tsx
import { Center, Divider, Group, InputWrapper, SegmentedControl, Stack, TextInput } from "@mantine/core";
import { IconCpu, IconUser } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { EngineVariantSelect } from "@/components/common/EngineVariantSelect";
import TimeInput, { type TimeType } from "@/components/common/TimeInput";
import type { TimeControlField } from "@/utils/clock";
import type { LocalEngine } from "@/utils/engines";
import { EnginesSelect } from "./EnginesSelect";

export type OpponentSettings =
  | {
      type: "human";
      timeControl?: TimeControlField;
      name?: string;
      timeUnit?: TimeType;
      incrementUnit?: TimeType;
    }
  | {
      type: "engine";
      timeControl?: TimeControlField;
      engine: LocalEngine | null;
      variantId: string | null;
      timeUnit?: TimeType;
      incrementUnit?: TimeType;
    };

export const DEFAULT_TIME_CONTROL: TimeControlField = {
  seconds: 180_000,
  increment: 2_000,
};

export function OpponentForm({
  sameTimeControl,
  opponent,
  setOpponent,
  setOtherOpponent,
}: {
  sameTimeControl: boolean;
  opponent: OpponentSettings;
  setOpponent: React.Dispatch<React.SetStateAction<OpponentSettings>>;
  setOtherOpponent: React.Dispatch<React.SetStateAction<OpponentSettings>>;
}) {
  const { t } = useTranslation();

  function updateType(type: "engine" | "human") {
    if (type === "human") {
      setOpponent((prev) => ({
        ...prev,
        type: "human",
        name: "Player",
      }));
    } else {
      setOpponent((prev) => ({
        ...prev,
        type: "engine",
        engine: null,
        variantId: null,
      }));
    }
  }

  return (
    <Stack flex={1}>
      <SegmentedControl
        data={[
          {
            value: "human",
            label: (
              <Center style={{ gap: 10 }}>
                <IconUser size={16} />
                <span>{t("Board.Opponent.Human")}</span>
              </Center>
            ),
          },
          {
            value: "engine",
            label: (
              <Center style={{ gap: 10 }}>
                <IconCpu size={16} />
                <span>{t("Common.Engine")}</span>
              </Center>
            ),
          },
        ]}
        value={opponent.type}
        onChange={(v) => updateType(v as "human" | "engine")}
      />

      {opponent.type === "human" && (
        <TextInput
          value={opponent.name ?? ""}
          onChange={(e) => setOpponent((prev) => ({ ...prev, name: e.target.value }))}
        />
      )}

      {opponent.type === "engine" && (
        <EnginesSelect
          engine={opponent.engine}
          setEngine={(engine) =>
            setOpponent((prev) => ({
              ...prev,
              engine,
              variantId: engine?.variants[0]?.id ?? null,
            }))
          }
        />
      )}

      {opponent.type === "engine" && opponent.engine && (
        <EngineVariantSelect
          engine={opponent.engine}
          variantId={opponent.variantId}
          setVariantId={(variantId) =>
            setOpponent((prev) => (prev.type === "engine" ? { ...prev, variantId } : prev))
          }
        />
      )}

      <Divider variant="dashed" label={t("Board.Opponent.TimeSettings")} />
      <SegmentedControl
        data={[
          { value: "time", label: t("GoMode.Time") },
          { value: "unlimited", label: t("Board.Opponent.Unlimited") },
        ]}
        value={opponent.timeControl ? "time" : "unlimited"}
        onChange={(v) => {
          setOpponent((prev) => ({
            ...prev,
            timeControl: v === "time" ? DEFAULT_TIME_CONTROL : undefined,
          }));
          if (sameTimeControl) {
            setOtherOpponent((prev) => ({
              ...prev,
              timeControl: v === "time" ? DEFAULT_TIME_CONTROL : undefined,
            }));
          }
        }}
      />
      <Group grow wrap="nowrap">
        {opponent.timeControl && (
          <>
            <InputWrapper label={t("GoMode.Time")}>
              <TimeInput
                defaultType="m"
                type={opponent.timeUnit}
                onTypeChange={(t) => {
                  setOpponent((prev) => ({ ...prev, timeUnit: t }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({ ...prev, timeUnit: t }));
                  }
                }}
                value={opponent.timeControl.seconds}
                setValue={(v) => {
                  setOpponent((prev) => ({
                    ...prev,
                    timeControl: {
                      seconds: v.t === "Time" ? v.c : 0,
                      increment: prev.timeControl?.increment ?? 0,
                    },
                  }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({
                      ...prev,
                      timeControl: {
                        seconds: v.t === "Time" ? v.c : 0,
                        increment: prev.timeControl?.increment ?? 0,
                      },
                    }));
                  }
                }}
              />
            </InputWrapper>
            <InputWrapper label={t("Board.Opponent.Increment")}>
              <TimeInput
                defaultType="s"
                type={opponent.incrementUnit}
                onTypeChange={(t) => {
                  setOpponent((prev) => ({ ...prev, incrementUnit: t }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({ ...prev, incrementUnit: t }));
                  }
                }}
                value={opponent.timeControl.increment ?? 0}
                setValue={(v) => {
                  setOpponent((prev) => ({
                    ...prev,
                    timeControl: {
                      seconds: prev.timeControl?.seconds ?? 0,
                      increment: v.t === "Time" ? v.c : 0,
                    },
                  }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({
                      ...prev,
                      timeControl: {
                        seconds: prev.timeControl?.seconds ?? 0,
                        increment: v.t === "Time" ? v.c : 0,
                      },
                    }));
                  }
                }}
              />
            </InputWrapper>
          </>
        )}
      </Group>
    </Stack>
  );
}
```

(The `{opponent.type === "engine" && (<Stack>...GoModeInput...EngineSettingsForm...</Stack>)}` block that used to follow the time-control section is removed entirely: search behavior now comes from the selected variant's `go`, and threads/hash/MultiPV/personality all come from the variant's settings — there's nothing left for that block to show.)

- [ ] **Step 2: Update `toPlayerConfig` in `src/components/boards/BoardGame.tsx`**

Remove the now-unused import:

```ts
import { getDefaultVariant } from "@/utils/engines";
```

(remove `import { describeStrengthSuffix } from "@/utils/engineStrength";`)

```ts
  async function toPlayerConfig(settings: OpponentSettings): Promise<PlayerConfig> {
    if (settings.type === "human") {
      return {
        type: "human",
        name: settings.name ?? "Player",
      };
    }
    const engine = settings.engine;
    const baseName = engine?.name ?? "Engine";
    const variant = engine
      ? (engine.variants.find((v) => v.id === settings.variantId) ?? getDefaultVariant(engine))
      : null;
    const engineOptions = (variant?.settings ?? []).filter((s) => s.name !== "MultiPV");

    // The chosen variant isn't otherwise visible in the saved PGN, so fold its name into the
    // White/Black headers - but only when it isn't the engine's own default variant, matching
    // the old "no suffix at full strength" behavior.
    const isDefaultVariant = engine && variant ? variant.id === getDefaultVariant(engine).id : true;
    const name = engine && variant && !isDefaultVariant ? `${baseName} (${variant.name})` : baseName;

    return {
      type: "engine",
      name,
      path: engine?.path ?? "",
      options: engineOptions.map((s) => ({
        name: s.name,
        value: s.value?.toString() ?? "",
      })),
      go: settings.timeControl ? null : (variant?.go ?? null),
    };
  }
```

- [ ] **Step 3: Manual verification (dev server)**

Run: `pnpm dev:tauri`

1. Open Create Game, choose Engine for one side.
2. Confirm the variant dropdown appears (no personality/skill/threads/hash controls) and defaults to "Default".
3. Switch to a non-default variant (e.g. a duplicated one with different Threads/Hash), start the game.
4. Confirm the game starts and the engine plays (indirect confirmation the options were sent) — check engine logs panel if needed to see the actual `setoption` calls include the variant's values.
5. Check the saved PGN/game header shows the variant's name suffix when a non-default variant was used, and no suffix when "Default" was used.
6. Confirm the standalone GoMode/Threads/Hash controls that used to appear under "Engine Settings" in Create Game are gone.

- [ ] **Step 4: Commit**

```bash
git add src/components/boards/OpponentForm.tsx src/components/boards/BoardGame.tsx
git commit -m "$(cat <<'EOF'
Replace Create Game's difficulty/threads/hash controls with a variant picker

OpponentSettings' engine branch now references a saved variant by id
instead of an inline go/engineSettings override. toPlayerConfig
resolves options/go from that variant and uses its name for the PGN
header suffix.
EOF
)"
```

---

## Task 11: Delete the superseded preset/strength-control code

**Files:**
- Delete: `src/components/boards/EngineStrengthControl.tsx`
- Delete: `src/utils/engineStrength.ts`
- Delete: `src/utils/tests/engineStrength.test.ts`
- Delete: `src/utils/presets/rodentII.ts`

By this point nothing imports from any of these four files (Task 10 removed the last `EngineStrengthControl`/`describeStrengthSuffix` usages; Task 2 copied the Rodent II data it needs into `engineVariantsMigration.ts`).

- [ ] **Step 1: Confirm nothing still references them**

Run:
```bash
grep -rn "engineStrength\|EngineStrengthControl\|presets/rodentII" src --include=*.ts --include=*.tsx
```
Expected: no output (or only matches inside the four files about to be deleted).

- [ ] **Step 2: Delete the files**

```bash
git rm src/components/boards/EngineStrengthControl.tsx \
  src/utils/engineStrength.ts \
  src/utils/tests/engineStrength.test.ts \
  src/utils/presets/rodentII.ts
```

- [ ] **Step 3: Full verification**

Run: `pnpm lint`
Expected: PASS — `tsc --noEmit` clean, `oxlint` clean. This is the first point in the plan where the whole project is guaranteed to typecheck end-to-end, since every remaining reference to the old `settings`/`go` engine shape has now been removed.

Run: `pnpm test`
Expected: PASS — all unit tests green, including the new `engineVariants`/`engineVariantsMigration`/updated `syzygy` tests from Tasks 1-3.

If `pnpm lint` surfaces any remaining reference to the old shape (e.g. a call site missed during Tasks 4-10), fix it here before proceeding — don't leave dangling type errors for a later task.

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
Remove the superseded engine-strength preset system

EngineStrengthControl, engineStrength.ts's dial/style/preset
detection, and the hardcoded Rodent II preset registry are now fully
replaced by the engine variants system.
EOF
)"
```

---

## Task 12: Final end-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated suite one more time**

```bash
pnpm lint
pnpm test
```
Expected: both PASS.

- [ ] **Step 2: Manual pass on a fresh dev build**

Run: `pnpm dev:tauri`

Walk the full checklist from the spec's Testing section:
1. `EnginesPage`: add/rename/edit/duplicate/delete variants on at least two different engines (including one with many UCI options, e.g. Stockfish, and if available, Rodent II — confirm its 10 personalities appear as real variants with the expected option values and are independently editable).
2. Create Game: engine selection populates the variant dropdown correctly and defaults sensibly for both White and Black; start a game with each side on a different variant and confirm both engines play using their own configured options (check the Engine Logs panel for the `setoption` calls if you want direct confirmation).
3. Coach settings: pick engine+variant for both Live Eval and Hint roles independently; confirm the hint still returns a move (MultiPV floor still applied) and live eval still populates the eval bar.
4. Analysis panel: confirm engine add/enable, thread/hash/MultiPV sliders, and "Sync globally" all behave exactly as before (no visible change expected here).
5. If you have an old `engines.json` backup from before this change (or can hand-construct one matching the pre-migration shape), place it in the engines directory and confirm the app starts up cleanly with each old engine now showing a single "Default" variant carrying its old settings.

- [ ] **Step 3: Report results to the user**

Summarize what was tested and any issues found. If everything passes, the feature is complete — no further commit needed for this task (it produces no code changes, only verification).
