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
    const remaining = base.filter((s) => !overrideNames.has(s.name)).map((s) => ({ ...s }));
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
                createVariant(
                    personality.name,
                    mergeSettings(baseSettings, personality.options),
                    baseGo,
                ),
            );
        }
    }

    return { ...rest, variants };
}
