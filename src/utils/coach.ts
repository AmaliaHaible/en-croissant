import type { BestMoves } from "@/bindings";
import type { Annotation } from "./annotation";
import type { EngineSettings } from "./engines";
import { getAnnotation } from "./score";
import type { ListNode } from "./treeReducer";

/** UCI option as the backend's `extraOptions` expects it. */
export type EngineOption = { name: string; value: string };

/**
 * Turns configured engine settings into the backend's `extraOptions`, merging in
 * a MultiPV floor instead of replacing the settings wholesale.
 *
 * Move classification needs at least two lines for the position before the move
 * (`getAnnotation` only reports "Good"/"Excellent" when it has more than one
 * previous line to compare against), so live-eval must never search with
 * MultiPV < 2 — no matter what ends up written into the coach config. That
 * matters because settings get copied out of the engine's own UCI defaults
 * (typically `MultiPV: 1`) by the engine picker, sometimes without the user ever
 * visiting the Coach settings tab. Merging keeps every other configured option
 * intact while making the floor impossible to lose.
 *
 * Pure, so it can be unit tested directly.
 */
export function withMultiPvFloor(settings: EngineSettings, floor = 2): EngineOption[] {
    const options: EngineOption[] = settings.map((s) => ({
        name: s.name,
        value: s.value?.toString() ?? "",
    }));
    const multipv = options.find((o) => o.name === "MultiPV");
    if (!multipv) {
        options.push({ name: "MultiPV", value: floor.toString() });
    } else if (!(Number(multipv.value) >= floor)) {
        // `!(x >= floor)` rather than `x < floor` so a non-numeric/empty value
        // (which parses to NaN) is also raised to the floor instead of kept.
        multipv.value = floor.toString();
    }
    return options;
}

export type MoveClassification = {
    /** Tree path of the node the annotation belongs to. */
    path: number[];
    /** Fen of that node, used as the "already classified" key. */
    fen: string;
    annotation: Annotation;
};

export type CoachFeedbackToggles = {
    white: boolean;
    black: boolean;
};

/**
 * Decides whether the last move of the main line deserves an annotation.
 *
 * Pure: takes plain data (the main line as a list, the fresh engine lines for the
 * tip position, and a fen-keyed cache of previously seen engine lines) and returns
 * either the annotation to apply or null. It never touches a store or a hook, so it
 * can be unit tested directly.
 */
export function classifyMove({
    mainLine,
    finalFen,
    bestLines,
    cache,
    feedbackEnabled,
    classifiedFens,
}: {
    mainLine: ListNode[];
    finalFen: string;
    bestLines: BestMoves[];
    cache: ReadonlyMap<string, BestMoves[]>;
    feedbackEnabled: CoachFeedbackToggles;
    classifiedFens?: ReadonlySet<string>;
}): MoveClassification | null {
    if (bestLines.length === 0) return null;

    const tip = mainLine[mainLine.length - 1];
    // Only classify when the analysed position really is the tip of the main line.
    if (!tip || tip.node.fen !== finalFen || !tip.node.move) return null;
    if (classifiedFens?.has(tip.node.fen)) return null;

    const color = tip.node.halfMoves % 2 === 1 ? "white" : "black";
    if (!feedbackEnabled[color]) return null;

    const parentEntry = mainLine[mainLine.length - 2];
    if (!parentEntry) return null;
    const grandparentEntry = mainLine.length >= 3 ? mainLine[mainLine.length - 3] : null;

    const prevMoves = cache.get(parentEntry.node.fen) ?? [];
    const prevScore = prevMoves[0]?.score.value ?? null;
    const prevprevScore = grandparentEntry
        ? (cache.get(grandparentEntry.node.fen)?.[0]?.score.value ?? null)
        : null;

    const annotation = getAnnotation(
        prevprevScore,
        prevScore,
        bestLines[0].score.value,
        color,
        prevMoves,
        false,
        tip.node.san || "",
    );

    if (!annotation) return null;

    return { path: tip.position, fen: tip.node.fen, annotation };
}
