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
