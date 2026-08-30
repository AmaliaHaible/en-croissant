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
    /**
     * Names of UCI options the user flagged as "important" on this variant. These are surfaced
     * as editable controls when the variant is picked for a New Game opponent, so a per-game
     * value (e.g. Skill Level) can be set without editing the saved variant. Stored as names
     * rather than a flag on each `settings` entry so a flagged option survives the
     * "drop entry when it equals the UCI default" pruning in the engine settings editor.
     */
    importantSettings: z.array(z.string()).default([]),
});

export type EngineVariant = z.output<typeof engineVariantSchema>;

type EngineLike = { variants: EngineVariant[] };

/** Creates a new variant with a fresh id. `go` defaults to `DEFAULT_GO_MODE`. */
export function createVariant(
    name: string,
    settings: EngineSettings = [],
    go: GoMode = DEFAULT_GO_MODE,
): EngineVariant {
    return { id: crypto.randomUUID(), name, go, settings, importantSettings: [] };
}

/** Copies a variant's settings/go/importantSettings under a new id and name. */
export function duplicateVariant(variant: EngineVariant, name: string): EngineVariant {
    return {
        ...variant,
        id: crypto.randomUUID(),
        name,
        settings: variant.settings.map((s) => ({ ...s })),
        importantSettings: [...variant.importantSettings],
    };
}

/**
 * Merges per-game overrides onto a variant's saved settings: an override replaces the
 * matching entry by name, or is appended if the variant has no entry for it. Neither input
 * is mutated. Used when starting a New Game so a tweaked "important" setting takes effect
 * for that game only.
 */
export function applySettingOverrides(
    base: EngineSettings,
    overrides: EngineSettings,
): EngineSettings {
    const result = base.map((s) => ({ ...s }));
    for (const override of overrides) {
        const idx = result.findIndex((s) => s.name === override.name);
        if (idx >= 0) {
            result[idx] = { ...override };
        } else {
            result.push({ ...override });
        }
    }
    return result;
}

/**
 * Human-readable "Name=value, Name=value" summary of the effective values of a variant's
 * "important" options (after applying this game's overrides), for recording in the saved PGN
 * so the played configuration is recoverable. Only options that have an explicit value (in the
 * variant or as an override) are listed; ones left at the engine's UCI default are omitted.
 * Returns `null` when there is nothing to record.
 */
export function summarizeImportantSettings(
    variant: Pick<EngineVariant, "settings" | "importantSettings">,
    overrides: EngineSettings,
): string | null {
    if (variant.importantSettings.length === 0) return null;
    const effective = applySettingOverrides(variant.settings, overrides);
    const parts = variant.importantSettings
        .map((name) => {
            const entry = effective.find((s) => s.name === name);
            return entry && entry.value !== null ? `${name}=${entry.value}` : null;
        })
        .filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(", ") : null;
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
