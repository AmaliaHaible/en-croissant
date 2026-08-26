import { commands, type UciOptionConfig } from "@/bindings";
import type { EngineSettings } from "@/utils/engines";
import { rodentIIPresets } from "@/utils/presets/rodentII";

export type StrengthPreset = {
    id: string;
    name: string;
    elo: number;
    description?: string;
    options: EngineSettings;
};

export type StrengthDial = {
    kind: "elo" | "skill";
    /** UCI options kept in sync under this one dial (e.g. Maia3's Elo/SelfElo/OppoElo). */
    optionNames: string[];
    limitOptionName: string | null;
    min: number;
    max: number;
};

export type StyleControl = {
    optionName: string;
    choices: string[];
    defaultChoice: string | null;
};

type SpinOption = Extract<UciOptionConfig, { type: "spin" }>;
type ComboOption = Extract<UciOptionConfig, { type: "combo" }>;

const ELO_OPTION_NAMES = ["uci_elo", "elo"];
const LIMIT_OPTION_NAMES = ["uci_limitstrength"];
const SKILL_OPTION_NAMES = ["skill level", "skill"];
const STYLE_OPTION_NAMES = ["personality", "playing style", "style"];

function findSpinOption(options: UciOptionConfig[], names: string[]): SpinOption | undefined {
    return options.find(
        (o): o is SpinOption => o.type === "spin" && names.includes(o.value.name.toLowerCase()),
    );
}

/**
 * Finds other spin options that represent the same Elo dial as `primary` (e.g. Maia3's
 * "SelfElo"/"OppoElo" alongside its "Elo"), so one slider can drive all of them in sync.
 * A sibling qualifies by sharing the exact min/max bounds and having "elo" in its name.
 */
function findSyncedEloOptions(options: UciOptionConfig[], primary: SpinOption): string[] {
    const siblings = options.filter(
        (o): o is SpinOption =>
            o.type === "spin" &&
            o.value.name !== primary.value.name &&
            o.value.min === primary.value.min &&
            o.value.max === primary.value.max &&
            o.value.name.toLowerCase().includes("elo"),
    );
    return [primary.value.name, ...siblings.map((s) => s.value.name)];
}

/**
 * Detects the best available way to limit an engine's playing strength, based on the UCI
 * options it advertises. Prefers a native Elo dial (UCI_Elo + UCI_LimitStrength, as used by
 * Stockfish/Patricia; or a plain "Elo" spin, as used by Maia3, possibly synced with same-range
 * "*Elo*" siblings like SelfElo/OppoElo) and falls back to a generic skill spin (e.g. Komodo's
 * "Skill"). Returns null when the engine exposes neither, meaning only bundled presets (see
 * getPresetsForEngine) can adjust its strength.
 */
export function detectStrengthDial(options: UciOptionConfig[]): StrengthDial | null {
    const elo = findSpinOption(options, ELO_OPTION_NAMES);
    if (elo?.value.min != null && elo.value.max != null) {
        const limit = options.find(
            (o) => o.type === "check" && LIMIT_OPTION_NAMES.includes(o.value.name.toLowerCase()),
        );
        return {
            kind: "elo",
            optionNames: findSyncedEloOptions(options, elo),
            limitOptionName: limit?.value.name ?? null,
            min: Number(elo.value.min),
            max: Number(elo.value.max),
        };
    }

    const skill = findSpinOption(options, SKILL_OPTION_NAMES);
    if (skill?.value.min != null && skill.value.max != null) {
        return {
            kind: "skill",
            optionNames: [skill.value.name],
            limitOptionName: null,
            min: Number(skill.value.min),
            max: Number(skill.value.max),
        };
    }

    return null;
}

/** Applies a dial value on top of a settings list, replacing any previous value for it. */
export function applyDialValue(
    dial: StrengthDial,
    value: number,
    baseSettings: EngineSettings,
): EngineSettings {
    const settings = clearDialOverride(dial, baseSettings);
    for (const name of dial.optionNames) {
        settings.push({ name, value });
    }
    if (dial.limitOptionName) {
        settings.push({ name: dial.limitOptionName, value: value < dial.max });
    }
    return settings;
}

/** Removes a dial's options from a settings list, returning the engine to its own defaults. */
export function clearDialOverride(
    dial: StrengthDial,
    baseSettings: EngineSettings,
): EngineSettings {
    return baseSettings.filter(
        (s) => !dial.optionNames.includes(s.name) && s.name !== dial.limitOptionName,
    );
}

/**
 * Detects a playstyle option (a UCI combo, e.g. Komodo's "Personality": Aggressive/Defensive/
 * Positional/...), distinct from a strength dial - it changes how an engine plays, not how well.
 */
export function detectStyleControl(options: UciOptionConfig[]): StyleControl | null {
    const combo = options.find(
        (o): o is ComboOption =>
            o.type === "combo" && STYLE_OPTION_NAMES.includes(o.value.name.toLowerCase()),
    );
    if (!combo || combo.value.var.length === 0) {
        return null;
    }
    return {
        optionName: combo.value.name,
        choices: combo.value.var,
        defaultChoice: combo.value.default,
    };
}

/** Sets a style option's value, replacing any previous value for it. */
export function applyStyleValue(
    style: StyleControl,
    value: string,
    baseSettings: EngineSettings,
): EngineSettings {
    const settings = clearStyleValue(style, baseSettings);
    settings.push({ name: style.optionName, value });
    return settings;
}

/** Removes a style option's value from a settings list. */
export function clearStyleValue(style: StyleControl, baseSettings: EngineSettings): EngineSettings {
    return baseSettings.filter((s) => s.name !== style.optionName);
}

/** Merges a preset's options into a settings list, overriding only the names it specifies. */
export function applyPreset(preset: StrengthPreset, baseSettings: EngineSettings): EngineSettings {
    const overrideNames = new Set(preset.options.map((o) => o.name));
    const remaining = baseSettings.filter((s) => !overrideNames.has(s.name));
    return [...remaining, ...preset.options];
}

/** Removes a preset's options from a settings list. */
export function clearPreset(preset: StrengthPreset, baseSettings: EngineSettings): EngineSettings {
    const overrideNames = new Set(preset.options.map((o) => o.name));
    return baseSettings.filter((s) => !overrideNames.has(s.name));
}

/** Finds which preset (if any) is currently fully applied within a settings list. */
export function findActivePreset(
    presets: StrengthPreset[],
    settings: EngineSettings,
): StrengthPreset | null {
    return (
        presets.find((preset) =>
            preset.options.every((opt) =>
                settings.some((s) => s.name === opt.name && s.value === opt.value),
            ),
        ) ?? null
    );
}

const PRESET_REGISTRY: { match: (engineName: string) => boolean; presets: StrengthPreset[] }[] = [
    { match: (name) => /rodent\s*ii\b/i.test(name), presets: rodentIIPresets },
];

/** Returns bundled named strength presets for an engine, matched by its UCI id name, or null. */
export function getPresetsForEngine(engineName: string): StrengthPreset[] | null {
    const entry = PRESET_REGISTRY.find((e) => e.match(engineName));
    return entry ? entry.presets : null;
}

/**
 * Describes any non-default difficulty/skill/playstyle chosen for an engine (via a preset, a
 * strength dial, or a style control), as a short human-readable string suitable for appending
 * to the engine's name - e.g. "Skill 5", "1500 Elo", "Aggressive", or "Beginner (~800 Elo)".
 * Returns null when the engine plays at its own default strength and style.
 */
export async function describeStrengthSuffix(
    engine: { path: string; name: string },
    settings: EngineSettings,
): Promise<string | null> {
    const result = await commands.getEngineConfig(engine.path);
    if (result.status !== "ok") return null;
    const { options } = result.data;

    const parts: string[] = [];

    const presets = getPresetsForEngine(result.data.name || engine.name);
    const activePreset = presets ? findActivePreset(presets, settings) : null;
    if (activePreset) {
        parts.push(`${activePreset.name} (~${activePreset.elo} Elo)`);
    } else {
        const dial = detectStrengthDial(options);
        if (dial) {
            const value = settings.find((s) => dial.optionNames.includes(s.name))?.value;
            if (typeof value === "number" && value < dial.max) {
                parts.push(dial.kind === "elo" ? `${value} Elo` : `Skill ${value}`);
            }
        }
    }

    const style = detectStyleControl(options);
    if (style) {
        const value = settings.find((s) => s.name === style.optionName)?.value;
        if (typeof value === "string" && value !== style.defaultChoice) {
            parts.push(value);
        }
    }

    return parts.length > 0 ? parts.join(", ") : null;
}
