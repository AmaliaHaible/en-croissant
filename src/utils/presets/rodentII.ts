import type { EngineSettings } from "@/utils/engines";
import type { StrengthPreset } from "@/utils/engineStrength";

// Converted from Rodent II's bundled personality files (personalities/<group>/<name>.txt),
// each a curated list of eval-weight/search-limit overrides rather than a single Elo dial.
// Book file options are dropped since they reference paths relative to Rodent II's own
// install layout, which may not exist alongside the copied binary.
function personality(options: [string, string | number][]): EngineSettings {
    return options.map(([name, value]) => ({ name, value }));
}

export const rodentIIPresets: StrengthPreset[] = [
    {
        id: "rodentII-amy",
        name: "Amy (School)",
        elo: 1439,
        description: "Weak, aggressive, slow",
        options: personality([
            ["OwnAttack", 200],
            ["OppAttack", 100],
            ["OwnMobility", 200],
            ["OppMobility", 100],
            ["NpsLimit", 64],
            ["EvalBlur", 48],
            ["SlowMover", 150],
            ["Selectivity", 175],
        ]),
    },
    {
        id: "rodentII-chris",
        name: "Chris (School)",
        elo: 1474,
        description: "Weak, classical piece-square tables and restraint",
        options: personality([
            ["OwnAttack", 100],
            ["OppAttack", 100],
            ["OwnMobility", 100],
            ["OppMobility", 120],
            ["NpsLimit", 72],
            ["EvalBlur", 48],
            ["SlowMover", 100],
            ["Selectivity", 175],
        ]),
    },
    {
        id: "rodentII-ben",
        name: "Ben (School)",
        elo: 1635,
        description: "Weak, balanced, precise evaluation for his strength range",
        options: personality([
            ["OwnAttack", 100],
            ["OppAttack", 100],
            ["OwnMobility", 100],
            ["OppMobility", 100],
            ["NpsLimit", 64],
            ["EvalBlur", 24],
            ["SlowMover", 100],
            ["Selectivity", 175],
        ]),
    },
    {
        id: "rodentII-arthur",
        name: "Arthur (League)",
        elo: 1991,
        description: "Sub-2000 player, likes attack and restraint, slow thinker",
        options: personality([
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
        ]),
    },
    {
        id: "rodentII-nancy",
        name: "Nancy (Masters)",
        elo: 2300,
        description: "Attacking player who likes closed positions",
        options: personality([
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
        ]),
    },
];
