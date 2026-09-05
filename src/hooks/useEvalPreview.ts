import { type Color, makeUci, type NormalMove, parseSquare } from "chessops";
import equal from "fast-deep-equal";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { type BestMoves, commands, events, type GoMode, type Score } from "@/bindings";
import { activeTabAtom, enginesAtom, evalPreviewEngineConfigAtom } from "@/state/atoms";
import { positionFromFen } from "@/utils/chessops";
import { getDefaultVariant, type LocalEngine } from "@/utils/engines";
import { useThrottledEffect } from "@/utils/misc";
import { unwrap } from "@/utils/unwrap";

const EVAL_PREVIEW_SUFFIX = "-eval-preview";
const DEFAULT_EVAL_PREVIEW_GO_MODE: GoMode = { t: "Time", c: 300 };
const HOVER_DEBOUNCE_MS = 150;

export type HoveredMove = { orig: string; dest: string } | null;

// The backend always normalizes engine scores to White's perspective before
// sending them to the frontend (see `invert_score` in chess.rs), regardless of
// whose turn it is at the analyzed position. So a hovered move's score only
// needs flipping when the mover is Black - White's is already correct as-is.
function negateScore(score: Score): Score {
    return {
        value: { type: score.value.type, value: -score.value.value } as Score["value"],
        wdl: score.wdl ? [score.wdl[2], score.wdl[1], score.wdl[0]] : null,
    };
}

export function useEvalPreview(
    enabled: boolean,
    hover: HoveredMove,
    currentFen: string,
    rootFen: string,
    moves: string[],
): { square: string; score: Score } | null {
    const config = useAtomValue(evalPreviewEngineConfigAtom);
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
                ? (engine.variants.find((v) => v.id === config.variantId) ??
                  getDefaultVariant(engine))
                : null,
        [engine, config.variantId],
    );
    const goMode = variant?.go ?? DEFAULT_EVAL_PREVIEW_GO_MODE;
    const extraOptions = useMemo(
        () =>
            (variant?.settings ?? []).map((s) => ({
                name: s.name,
                value: s.value?.toString() ?? "",
            })),
        [variant],
    );

    const activeTab = useAtomValue(activeTabAtom);

    // The candidate move's uci + resulting move list from root, or null when
    // nothing is being hovered. Assumes queen promotion, same as auto-promote.
    const preview = useMemo(() => {
        if (!hover) return null;
        const [pos] = positionFromFen(currentFen);
        if (!pos) return null;
        const from = parseSquare(hover.orig);
        const to = parseSquare(hover.dest);
        if (from === undefined || to === undefined) return null;
        const piece = pos.board.get(from);
        const promotion =
            piece?.role === "pawn" && (hover.dest[1] === "8" || hover.dest[1] === "1")
                ? ("queen" as const)
                : undefined;
        const move: NormalMove = { from, to, promotion };
        const uci = makeUci(move);
        return { uci, moves: [...moves, uci], square: hover.dest, mover: pos.turn as Color };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hover?.orig, hover?.dest, currentFen, JSON.stringify(moves)]);

    const [result, setResult] = useState<{ square: string; score: Score } | null>(null);
    const active = enabled && !!preview && !!engine && !!activeTab;

    useEffect(() => {
        if (!active) setResult(null);
    }, [active]);

    // Shared handling of engine output, used both by the event listener and by
    // `get_best_moves`' synchronous short-circuit return value. Refreshed after
    // every render so it always checks against the current hover target.
    const handleResultRef = useRef<
        (resultFen: string, resultMoves: string[], bestLines: BestMoves[]) => void
    >(() => {});
    useEffect(() => {
        handleResultRef.current = (resultFen, resultMoves, bestLines) => {
            // Late answer for a hover we've since left.
            if (bestLines.length === 0 || !preview) return;
            if (resultFen !== rootFen || !equal(resultMoves, preview.moves)) return;
            const score =
                preview.mover === "black" ? negateScore(bestLines[0].score) : bestLines[0].score;
            setResult({ square: preview.square, score });
        };
    });

    useEffect(() => {
        if (!active || !engine || !activeTab) return;
        const id = `${engine.id}${EVAL_PREVIEW_SUFFIX}`;

        const unlisten = events.bestMovesPayload.listen(({ payload }) => {
            if (payload.engine !== id || payload.tab !== activeTab) return;
            handleResultRef.current(payload.fen, payload.moves, payload.bestLines);
        });

        return () => {
            unlisten.then((f) => f());
        };
    }, [active, engine, activeTab]);

    const startedRef = useRef<{ id: string; tab: string } | null>(null);

    useThrottledEffect(
        () => {
            if (!engine || !activeTab) return;
            const id = `${engine.id}${EVAL_PREVIEW_SUFFIX}`;

            if (!active || !preview) {
                const started = startedRef.current;
                if (started) {
                    startedRef.current = null;
                    commands.stopEngine(started.id, started.tab).then((r) => unwrap(r));
                }
                return;
            }

            const prevStarted = startedRef.current;
            if (prevStarted && (prevStarted.id !== id || prevStarted.tab !== activeTab)) {
                commands.killEngine(prevStarted.id, prevStarted.tab).catch(() => {});
            }
            startedRef.current = { id, tab: activeTab };

            const targetMoves = preview.moves;
            commands
                .getBestMoves(id, engine.path, activeTab, goMode, {
                    fen: rootFen,
                    moves: targetMoves,
                    extraOptions,
                })
                .then((r) => {
                    const res = unwrap(r);
                    if (!res) return;
                    handleResultRef.current(rootFen, targetMoves, res[1]);
                });
        },
        HOVER_DEBOUNCE_MS,
        [active, engine, activeTab, rootFen, preview?.uci, goMode, extraOptions],
    );

    // Unmounting (leaving the board) tears the process down entirely.
    useEffect(() => {
        return () => {
            const started = startedRef.current;
            if (!started) return;
            startedRef.current = null;
            commands.killEngine(started.id, started.tab).catch(() => {});
        };
    }, []);

    return result;
}

export default useEvalPreview;
