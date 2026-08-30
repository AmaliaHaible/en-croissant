import { fetch } from "@tauri-apps/plugin-http";
import type { Platform } from "@tauri-apps/plugin-os";
import useSWR from "swr";
import { z } from "zod";
import {
    type BestMoves,
    commands,
    type EngineOptions,
    type GoMode,
    type UciOptionConfig,
} from "@/bindings";
import { type EngineSettings, engineVariantSchema } from "./engineVariants";
import { migrateEngineRecord } from "./engineVariantsMigration";
import { unwrap } from "./unwrap";

export {
    applySettingOverrides,
    canDeleteVariant,
    createVariant,
    DEFAULT_GO_MODE,
    duplicateVariant,
    type EngineSettings,
    engineSettingsSchema,
    type EngineVariant,
    getDefaultVariant,
    summarizeImportantSettings,
    withDefaultVariant,
} from "./engineVariants";

export const requiredEngineSettings = ["MultiPV", "Threads", "Hash"];

/**
 * Per the UCI spec, an engine's `UCI_Elo` only takes effect while `UCI_LimitStrength` is
 * enabled. Returns true when the engine advertises that toggle and it is currently off, so
 * the option editor can disable the (otherwise inert) Elo field. Engines that don't expose a
 * `UCI_LimitStrength` option are never gated. Matching is case-insensitive on the option name.
 */
export function isEloFieldInert(options: UciOptionConfig[], settings: EngineSettings): boolean {
    const limit = options.find(
        (o) => o.type === "check" && o.value.name.toLowerCase() === "uci_limitstrength",
    );
    if (limit?.type !== "check") return false;
    const override = settings.find((s) => s.name.toLowerCase() === "uci_limitstrength");
    const current = override?.value ?? limit.value.default;
    return !current;
}

/**
 * Backfills a variant's settings with UCI defaults for any required field it's missing, and
 * with the global Syzygy tablebase path if the engine supports it and none is set yet. Returns
 * `null` when nothing needs to change, so callers can skip writing back to the engine record
 * entirely - critical because a spurious write here can race with (and silently undo) a
 * concurrent variant mutation like delete/duplicate elsewhere in the same render cycle.
 */
export function backfillRequiredSettings(
    variantSettings: EngineSettings,
    uciOptions: UciOptionConfig[],
    globalSyzygyPath: string,
): EngineSettings | null {
    const settings = [...variantSettings];
    let changed = false;

    for (const field of requiredEngineSettings) {
        if (!settings.find((setting) => setting.name === field)) {
            const option = uciOptions.find((option) => option.value.name === field);
            if (option && option.type !== "button") {
                settings.push({
                    name: field,
                    value: option.value.default as string | number | boolean | null,
                });
                changed = true;
            }
        }
    }

    const syzygyOption = uciOptions.find(
        (option) => option.value.name.toLowerCase() === "syzygypath",
    );
    if (
        syzygyOption &&
        globalSyzygyPath &&
        !settings.find((setting) => setting.name.toLowerCase() === "syzygypath")
    ) {
        settings.push({ name: syzygyOption.value.name, value: globalSyzygyPath });
        changed = true;
    }

    return changed ? settings : null;
}

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

/**
 * Resolves a persisted engine selection (a bare engine id, e.g. the coach's
 * `hint-engine-config` / `live-eval-engine-config`) against the current engine
 * list.
 *
 * Resolves against *every* local engine, not just loaded ones: an engine that
 * merely isn't loaded right now is still the user's choice. The coach settings
 * dropdown only offers loaded engines, so if this collapsed an
 * unloaded-but-configured selection to `null`, `EnginesSelect`'s
 * auto-select-first-engine effect would mistake it for "no choice made" and
 * overwrite the stored id with whatever engine happens to be loaded.
 *
 * Returns `null` only when nothing is configured or the configured engine no
 * longer exists at all (deleted) — the cases where auto-selecting a default is
 * genuinely the right thing to do.
 */
export function resolveConfiguredEngine(
    engineId: string | null | undefined,
    engines: Engine[] | null | undefined,
): LocalEngine | null {
    if (!engineId) return null;
    return (
        (engines ?? []).find((e): e is LocalEngine => e.type === "local" && e.id === engineId) ??
        null
    );
}

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
