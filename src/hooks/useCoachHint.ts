import { parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import equal from "fast-deep-equal";
import { useAtomValue } from "jotai";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type BestMoves, commands, events, type GoMode } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
    activeTabAtom,
    currentGameStateAtom,
    currentPlayersAtom,
    enginesAtom,
    hintEngineConfigAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { getDefaultVariant, type LocalEngine } from "@/utils/engines";
import { useThrottledEffect } from "@/utils/misc";
import { unwrap } from "@/utils/unwrap";

const COACH_HINT_SUFFIX = "-coach-hint";
const DEFAULT_COACH_GO_MODE: GoMode = { t: "Time", c: 300 };

function coachHintId(engineId: string): string {
    return `${engineId}${COACH_HINT_SUFFIX}`;
}

/**
 * Drives the Hint button's engine session, independent of the live-eval/coach
 * feedback session in `useLiveCoachEngine`. Deliberately mirrors that hook's
 * lifecycle plumbing (event listener + throttled search effect + synchronous
 * short-circuit consumption + unmount cleanup) rather than sharing an
 * abstraction with it: that lifecycle already went through a full review
 * cycle that caught real concurrency/lifecycle bugs, so duplicating the
 * proven shape here is lower risk than factoring out a shared helper under
 * time pressure.
 *
 * Two modes, selected purely by the configured go-mode:
 * - Bounded go-mode (Time/Depth/Nodes): on-demand. Only searches while
 *   `requested` is true (i.e. after the Hint button has been clicked).
 * - `{ t: "Infinite" }` go-mode: continuous. Searches for the whole game,
 *   independent of `requested` — Hint just reveals whatever's been found.
 */
export function useCoachHint(requested: boolean): {
    bestMoveUci: string | null;
    engine: LocalEngine | null;
} {
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
                ? (engine.variants.find((v) => v.id === config.variantId) ??
                  getDefaultVariant(engine))
                : null,
        [engine, config.variantId],
    );

    const goMode = variant?.go ?? DEFAULT_COACH_GO_MODE;
    const isContinuous = goMode.t === "Infinite";
    // Go-modes whose searches never terminate on their own, and therefore never
    // report progress===100: their results have to be published as they improve
    // or they'd never be published at all. (`PlayersTime` isn't offered by the
    // coach settings UI, but the config is persisted user data, so don't assume.)
    const isStreaming = goMode.t === "Infinite" || goMode.t === "PlayersTime";
    const extraOptions = useMemo(() => {
        const settings = variant?.settings ?? [];
        return settings.length > 0
            ? settings.map((s) => ({ name: s.name, value: s.value?.toString() ?? "" }))
            : [{ name: "MultiPV", value: "1" }];
    }, [variant]);

    const activeTab = useAtomValue(activeTabAtom);
    const store = useContext(TreeStateContext)!;
    const fen = useStore(store, (s) => s.root.fen);
    const moves = useStore(
        store,
        useShallow((s) => getVariationLine(s.root, s.position)),
    );

    const [pos] = positionFromFen(fen);
    if (pos) {
        for (const uci of moves) {
            const move = parseUci(uci);
            if (!move) break;
            pos.play(move);
        }
    }
    const isGameOver = pos?.isEnd() ?? false;
    const finalFen = useMemo(() => (pos ? makeFen(pos.toSetup()) : fen), [pos, fen]);

    // `isGameOver` is a pure board predicate (checkmate/stalemate/etc.) — it says
    // nothing about resignation, timeout, or abort, which end the game via
    // `currentGameStateAtom` while the board position is still very much "in
    // progress". Continuous mode must track the app's actual game state, or an
    // Infinite search never gets told to stop after those endings (and would
    // also start during "settingUp", before a game even exists).
    const gameState = useAtomValue(currentGameStateAtom);
    // Continuous mode is only useful while a human is on move: it's their hint
    // to ask for. Gating on this (rather than just `gameState === "playing"`)
    // also means the search naturally starts when their turn starts and stops
    // the moment they move, instead of running for the engine's turn too, and
    // it's `false` for the whole game whenever neither side is human — i.e.
    // engine-vs-engine games never spin up a hint session at all.
    const players = useAtomValue(currentPlayersAtom);
    const isHumanTurn =
        pos?.turn === "white"
            ? players.white.type === "human"
            : pos?.turn === "black"
              ? players.black.type === "human"
              : false;
    const active = isContinuous ? gameState === "playing" && !isGameOver && isHumanTurn : requested;

    const [bestMoveUci, setBestMoveUci] = useState<string | null>(null);
    // The engine process we last asked to search, so it can still be stopped or
    // killed after `engine`/`activeTab` changed or became null.
    const startedRef = useRef<{ id: string; tab: string } | null>(null);
    const searchingRef = useRef(false);

    // The best move belongs to exactly one position: drop it as soon as the
    // position changes so a hint can never reveal a stale move.
    useEffect(() => {
        setBestMoveUci(null);
    }, [finalFen]);

    // Shared handling of engine output, used both by the event listener and by
    // `get_best_moves`' synchronous short-circuit return value. Kept in a ref that
    // is refreshed after every render so neither effect needs it as a dependency.
    const handleResultRef = useRef<
        (resultFen: string, bestLines: BestMoves[], progress: number) => void
    >(() => {});
    useEffect(() => {
        handleResultRef.current = (resultFen, bestLines, progress) => {
            // Late answer for a position we already left.
            if (bestLines.length === 0 || resultFen !== finalFen) return;
            // A bounded search (Time/Depth/Nodes) emits intermediate lines from
            // its very first, shallow iteration onwards — publishing those would
            // reveal a ~20ms answer and never update it again, making the
            // configured search budget meaningless. Wait for completion instead.
            // Streaming go-modes never report progress===100 (the backend caps
            // them at 99.99 until an explicit stop), so for those keep
            // publishing every improvement — which is the point of that mode.
            if (!isStreaming && progress < 100) return;
            setBestMoveUci(bestLines[0].uciMoves[0] ?? null);
        };
    });

    useEffect(() => {
        if (!active || !engine || !activeTab) return;
        const listenerId = coachHintId(engine.id);

        const unlisten = events.bestMovesPayload.listen(({ payload }) => {
            if (
                payload.engine !== listenerId ||
                payload.tab !== activeTab ||
                payload.fen !== fen ||
                !equal(payload.moves, moves)
            ) {
                return;
            }

            handleResultRef.current(finalFen, payload.bestLines, payload.progress);
        });

        return () => {
            unlisten.then((f) => f());
        };
    }, [active, engine, activeTab, fen, JSON.stringify(moves), finalFen]);

    useThrottledEffect(
        () => {
            if (!engine || !activeTab) return;
            const id = coachHintId(engine.id);

            if (!active || isGameOver) {
                if (searchingRef.current) {
                    searchingRef.current = false;
                    // Stop the process that's actually running, not `id`: if the
                    // configured engine changed since the search was started, `id`
                    // (recomputed from the current `engine`) no longer matches it.
                    const started = startedRef.current;
                    if (started) {
                        commands.stopEngine(started.id, started.tab).then((r) => unwrap(r));
                    }
                }
                return;
            }

            const requestFen = finalFen;
            // The engine (or tab) resolved to something new since the last search
            // was started: that old process is no longer referenced by anything
            // below, so it would otherwise be orphaned. Kill it before moving on.
            const prevStarted = startedRef.current;
            if (prevStarted && (prevStarted.id !== id || prevStarted.tab !== activeTab)) {
                commands.killEngine(prevStarted.id, prevStarted.tab).catch(() => {});
            }
            searchingRef.current = true;
            startedRef.current = { id, tab: activeTab };
            commands
                .getBestMoves(id, engine.path, activeTab, goMode, {
                    fen,
                    moves,
                    extraOptions,
                })
                .then((r) => {
                    // A matching search is already running: the backend answers
                    // directly and emits no event, so consume the result here.
                    const result = unwrap(r);
                    if (!result) return;
                    const [progress, bestLines] = result;
                    handleResultRef.current(requestFen, bestLines, progress);
                });
        },
        50,
        [
            active,
            engine,
            activeTab,
            fen,
            JSON.stringify(moves),
            finalFen,
            isGameOver,
            goMode,
            extraOptions,
        ],
    );

    // Leaving the play tab unmounts this hook: tear the process down entirely.
    useEffect(() => {
        return () => {
            const started = startedRef.current;
            if (!started) return;
            startedRef.current = null;
            searchingRef.current = false;
            commands.killEngine(started.id, started.tab).catch(() => {});
        };
    }, []);

    return { bestMoveUci, engine };
}

export default useCoachHint;
