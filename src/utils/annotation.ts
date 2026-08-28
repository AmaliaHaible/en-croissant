import type { MantineColor } from "@mantine/core";

const pieceChars = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘" };

export function addPieceSymbol(move: string): string {
    const pieceChar = pieceChars[move[0] as keyof typeof pieceChars];

    if (typeof pieceChar === "undefined") return move;
    return pieceChar + move.slice(1);
}

export type Annotation =
    | ""
    | "!"
    | "!!"
    | "?"
    | "??"
    | "!?"
    | "?!"
    | "+-"
    | "±"
    | "⩲"
    | "="
    | "∞"
    | "⩱"
    | "∓"
    | "-+"
    | "N"
    | "↑↑"
    | "↑"
    | "→"
    | "⇆"
    | "=∞"
    | "⊕"
    | "∆"
    | "□"
    | "⨀"
    | "⊗"
    | "BM1"
    | "BM2"
    | "BM3"
    | "BM4";

// Marks a variation added by the "always show best moves" report feature, ranked
// by how strong the engine considered the alternative (BM1 = top choice). Not a
// move-quality glyph, so it's kept out of the visible annotation symbol lists and
// only used to pick the best-move arrow color/shade on the board.
export const BEST_MOVE_SUGGESTION_ANNOTATIONS = ["BM1", "BM2", "BM3", "BM4"] as const;

export function isBestMoveSuggestion(
    annotation: string,
): annotation is (typeof BEST_MOVE_SUGGESTION_ANNOTATIONS)[number] {
    return (BEST_MOVE_SUGGESTION_ANNOTATIONS as readonly string[]).includes(annotation);
}

export function getBestMoveSuggestionRank(annotations: Annotation[]): number | null {
    for (const annotation of annotations) {
        const index = (BEST_MOVE_SUGGESTION_ANNOTATIONS as readonly string[]).indexOf(annotation);
        if (index !== -1) return index;
    }
    return null;
}

export const NAG_INFO = new Map<string, Annotation>([
    ["$1", "!"],
    ["$2", "?"],
    ["$3", "!!"],
    ["$4", "??"],
    ["$5", "!?"],
    ["$6", "?!"],
    ["$7", "□"],
    ["$9", "⊗"],
    ["$10", "="],
    ["$13", "∞"],
    ["$14", "⩲"],
    ["$15", "⩱"],
    ["$16", "±"],
    ["$17", "∓"],
    ["$18", "+-"],
    ["$19", "-+"],
    ["$22", "⨀"],
    ["$23", "⨀"],
    ["$32", "↑↑"],
    ["$33", "↑↑"],
    ["$36", "↑"],
    ["$37", "↑"],
    ["$40", "→"],
    ["$41", "→"],
    ["$44", "=∞"],
    ["$45", "=∞"],
    ["$132", "⇆"],
    ["$133", "⇆"],
    ["$138", "⊕"],
    ["$139", "⊕"],
    ["$140", "∆"],
    ["$146", "N"],
    ["$220", "BM1"],
    ["$221", "BM2"],
    ["$222", "BM3"],
    ["$223", "BM4"],
]);

type AnnotationInfo = {
    group?: string;
    name: string;
    translationKey?: string;
    color?: MantineColor;
    nag: number;
};

export const ANNOTATION_INFO: Record<Annotation, AnnotationInfo> = {
    "": { name: "None", color: "gray", nag: 0 },
    "!!": {
        group: "basic",
        name: "Brilliant",
        translationKey: "Brilliant",
        color: "cyan",
        nag: 3,
    },
    "!": {
        group: "basic",
        name: "Good",
        translationKey: "Good",
        color: "teal",
        nag: 1,
    },
    "!?": {
        group: "basic",
        name: "Interesting",
        translationKey: "Interesting",
        color: "lime",
        nag: 5,
    },
    "?!": {
        group: "basic",
        name: "Dubious",
        translationKey: "Dubious",
        color: "yellow",
        nag: 6,
    },
    "?": {
        group: "basic",
        name: "Mistake",
        translationKey: "Mistake",
        color: "orange",
        nag: 2,
    },
    "??": {
        group: "basic",
        name: "Blunder",
        translationKey: "Blunder",
        color: "red",
        nag: 4,
    },
    "+-": {
        group: "advantage",
        name: "White is winning",
        translationKey: "WhiteWinning",
        nag: 18,
    },
    "±": {
        group: "advantage",
        name: "White has a clear advantage",
        translationKey: "WhiteAdvantage",
        nag: 16,
    },
    "⩲": {
        group: "advantage",
        name: "White has a slight advantage",
        translationKey: "WhiteEdge",
        nag: 14,
    },
    "=": {
        group: "advantage",
        name: "Equal position",
        translationKey: "Equal",
        nag: 10,
    },
    "∞": {
        group: "advantage",
        name: "Unclear position",
        translationKey: "Unclear",
        nag: 13,
    },
    "⩱": {
        group: "advantage",
        name: "Black has a slight advantage",
        translationKey: "BlackEdge",
        nag: 15,
    },
    "∓": {
        group: "advantage",
        name: "Black has a clear advantage",
        translationKey: "BlackAdvantage",
        nag: 17,
    },
    "-+": {
        group: "advantage",
        name: "Black is winning",
        translationKey: "BlackWinning",
        nag: 19,
    },
    N: { name: "Novelty", translationKey: "Novelty", nag: 146 },
    "↑↑": { name: "Development", translationKey: "Development", nag: 32 },
    "↑": { name: "Initiative", translationKey: "Initiative", nag: 36 },
    "→": { name: "Attack", translationKey: "Attack", nag: 40 },
    "⇆": { name: "Counterplay", translationKey: "Counterplay", nag: 132 },
    "=∞": {
        name: "With compensation",
        translationKey: "WithCompensation",
        nag: 44,
    },
    "⊕": { name: "Time Trouble", translationKey: "TimeTrouble", nag: 138 },
    "∆": { name: "With the idea", translationKey: "WithIdea", nag: 140 },
    "□": { name: "Only move", translationKey: "OnlyMove", nag: 7 },
    "⨀": { name: "Zugzwang", translationKey: "Zugzwang", nag: 22 },
    "⊗": { name: "Miss", color: "red", nag: 9 },
    BM1: { name: "Best move suggestion (1st)", nag: 220 },
    BM2: { name: "Best move suggestion (2nd)", nag: 221 },
    BM3: { name: "Best move suggestion (3rd)", nag: 222 },
    BM4: { name: "Best move suggestion (4th)", nag: 223 },
};

export function isBasicAnnotation(
    annotation: string,
): annotation is "!" | "!!" | "?" | "??" | "!?" | "?!" {
    return ["!", "!!", "?", "??", "!?", "?!"].includes(annotation);
}
