# Task C report: split live-eval and hint into independently configurable engine sessions

## Addendum: fix round for review findings on 7484471f

Commit: `01b9c3f1` on branch `master`, one commit on top of `7484471f` (not amended).

The review of `7484471f` found the mechanical split itself correct (lifecycle duplication faithful, fallback equivalence for unconfigured users correct, process-key isolation correct, earlier fix-wave's short-circuit/staleness handling survived the move), but flagged 1 Critical and 2 Important issues in the new continuous-hint behavior and in a latent bug the split turned into a reachable path, plus one formatting nit. All four are fixed here.

### 1. CRITICAL — continuous mode never stopped on resignation/timeout/abort (`src/hooks/useCoachHint.ts`)

Root cause: `active = isContinuous ? !isGameOver : requested` used `isGameOver` (`pos?.isEnd() ?? false` — a pure board predicate: checkmate/stalemate/insufficient material/etc.) as the only gate for continuous mode. But `BoardGame.tsx` ends games via `setGameState("gameOver")` in three places that don't touch the board position at all: the `gameOverEvent` listener (line ~781, covers resignation/timeout/backend-reported results) and `handleAbort` (line ~904). In every one of those, `pos.isEnd()` stays `false` forever, so an `Infinite`-go-mode hint session would keep running an unbounded `go infinite` search with nothing left to ever call `stop()` on it — only reaped on tab close or app exit. The same expression also let the search start during `gameState === "settingUp"`, before a game exists, while the Hint button itself is disabled.

Fix: added `const gameState = useAtomValue(currentGameStateAtom);` (imported from `@/state/atoms`) and changed the gate to `active = isContinuous ? gameState === "playing" && !isGameOver : requested`. Confirmed `GameState = "settingUp" | "playing" | "gameOver"` (`src/state/atoms.ts:517`, default `"settingUp"`), so this now correctly excludes both pre-game and every post-game-ending state, not just checkmate-style board endings. `requested`-driven on-demand mode is untouched.

### 2. IMPORTANT — engine/tab switch orphaned the previous process (`src/hooks/useCoachHint.ts` and `src/hooks/useLiveCoachEngine.ts`)

Root cause: in the throttled search effect, `id` is recomputed from the current `engine` every run, and the search branch just overwrote `startedRef.current = { id, tab: activeTab }` with no teardown of whatever the _previous_ `startedRef.current` pointed at. If the configured engine changed (or the resolved engine changed because the engines list changed), the old process became unreachable — not referenced by `startedRef` any more, so unmount cleanup can't find it either. In bounded/on-demand mode it just idles past its search window; in `Infinite` mode it would spin forever.

A second, related bug in the same branch pair: the "stop" branch (`!active || isGameOver`) called `commands.stopEngine(id, activeTab)` using the freshly recomputed `id` — wrong whenever the actually-running process was started under a _different_, now-stale `id` (i.e. exactly the scenario above), meaning the stop call would target a process that was never started and silently no-op while the real one kept running.

Fix, applied identically in both files' throttled-effect callback:

- In the search branch, before overwriting `startedRef.current`: read `prevStarted = startedRef.current`; if `prevStarted` exists and its `id` or `tab` differs from the new one, `commands.killEngine(prevStarted.id, prevStarted.tab).catch(() => {})` before proceeding.
- In the stop branch: read `started = startedRef.current` and call `commands.stopEngine(started.id, started.tab)` (guarded on `started` being non-null) instead of the recomputed `id`/`activeTab`. Since `searchingRef.current` is only ever set `true` alongside `startedRef.current` being set in the same branch, `started` is guaranteed non-null whenever the `searchingRef.current` guard passes, so this always resolves to the actually-running process's identity.

### 3. IMPORTANT — Infinite/PlayersTime live-eval silently stopped classifying moves (`src/hooks/useLiveCoachEngine.ts`)

Root cause: `if (progress < 100) return;` gated all classification on the backend reporting `progress === 100`. Verified in `src-tauri/src/chess.rs:403-416`: `GoMode::PlayersTime(_) => 99.99` and `GoMode::Infinite => 99.99` are hardcoded — those two go-modes never emit `progress === 100` from an intermediate `BestMovesPayload`; the only message that could reach 100 is the final one after an explicit `stop()`, which for an `Infinite` search normally arrives after the listener has already moved to a new position (so it's discarded by the earlier `resultFen !== finalFen` guard). Net effect: configuring live-eval to `Infinite` go-mode (reachable once the not-yet-built settings UI exists) would leave the eval bar working but silently and permanently disable White/Black move-feedback annotation, with no error surfaced anywhere.

Fix: `if (progress < 100 && goMode.t !== "Infinite" && goMode.t !== "PlayersTime") return;` — for those two go-modes, every emitted line is now treated as "complete enough" to attempt classification. Relies on the existing `classifiedFensRef` set (already deduping "already classified" fens before this change) to avoid reclassifying the same fen repeatedly as a long-running search keeps emitting refined intermediate lines. Added an inline comment at the check explaining the backend's 99.99 cap and warning against reverting to a plain `progress < 100` check, per the review's request that this not be silently re-broken later.

### 4. Minor — formatting

Ran `npm run format` (`oxfmt`, per `package.json`) across the repo; it reformatted exactly the two files already being edited (`src/hooks/useCoachHint.ts`, `src/hooks/useLiveCoachEngine.ts`) — collapsing a couple of `return (...)` wraps and one generic-type line wrap that oxfmt wants on one line. No other files were touched by the formatter run. `npm run lint:ci` (which runs `oxfmt --check`) now reports "All matched files use the correct format." for these files.

### Verification (fix round)

Run from repo root, in order:

1. `npx tsc --noEmit` — clean, no output, exit 0.
2. `npm run format` — reformatted `useCoachHint.ts` and `useLiveCoachEngine.ts` only (see above).
3. `npm run lint` — no errors; warning set is the same pre-existing class as before (the two coach hook files still carry the same `JSON.stringify(moves)`-in-deps warnings they had after the original split, at their new line numbers — `useCoachHint.ts:132,143`, `useLiveCoachEngine.ts:160,171` — matching the same long-standing pattern already present in `EvalListener.tsx:157,175` on this branch). No new warning classes anywhere, no new warnings outside the two hook files.
4. `npm run lint:ci` — `tsc --noEmit && oxfmt --check && oxlint`: format check passes ("All matched files use the correct format."), same warning set as (3), no errors.
5. `npx vitest run` — `Test Files 11 passed (11)`, `Tests 84 passed (84)`.

Commit hash: `01b9c3f1`.

### Trace-through confirming the three behavioral fixes

**Continuous mode now actually stops.** With `hintEngineConfigAtom.go = { t: "Infinite" }`: on resignation/timeout (`gameOverEvent` listener, `BoardGame.tsx` ~line 781) or abort (`handleAbort`, ~line 904), `setGameState("gameOver")` fires regardless of board position. `useCoachHint`'s `gameState` (via `currentGameStateAtom`) picks this up on next render, `active` flips to `false` even though `isGameOver` (board predicate) may still be `false`. The throttled effect's stop branch then runs, `searchingRef.current` is `true` (search was running), so it calls `commands.stopEngine(started.id, started.tab)` against the actually-started process. Confirmed no longer gated on `pos.isEnd()` alone. Also confirmed the search cannot start during `gameState === "settingUp"` (default state before `startGame`/first move), since `active` requires `gameState === "playing"`.

**Switching engines no longer orphans a process.** If `hintEngineConfigAtom.engineId` changes while continuous mode is active (or the resolved engine changes because `enginesAtom` changed), the next throttled-effect run computes a new `id` from the new `engine`. `prevStarted = startedRef.current` still holds the old `{id, tab}`; since `prevStarted.id !== id`, `commands.killEngine(prevStarted.id, prevStarted.tab)` fires before `startedRef.current` is overwritten with the new pair — the old process is torn down instead of left dangling. Same logic verified in `useLiveCoachEngine.ts`. Also handles the tab-switch case (`prevStarted.tab !== activeTab`) via the same condition.

**Infinite live-eval now classifies.** With `liveEvalEngineConfigAtom.go = { t: "Infinite" }`, the backend emits `BestMovesPayload` with `progress: 99.99` on every intermediate line (per `chess.rs`). The updated check `progress < 100 && goMode.t !== "Infinite" && goMode.t !== "PlayersTime"` evaluates its second/third operands as `false` for `Infinite`, so the whole condition is `false` and execution proceeds into `classifyMove`/`setNodeAnnotation` on every qualifying update, not just an unreachable final 100%-progress message. `classifiedFensRef` (unchanged) still prevents the same fen from being annotated more than once as the search keeps refining its answer.

All three fixes verified consistent with the review's requested approach; no deviations. Minors 4-6 from the review (GoMode type width, MultiPV-fallback being all-or-nothing, two slightly-stale comments) were left untouched per the "what not to fix" instruction.

Commit: `7484471f` on branch `master` (single commit, as requested).

## 1. What changed

### `src/hooks/useLiveCoachEngine.ts` (existing file, simplified)

- Line 32-34: signature changed from `useLiveCoachEngine(hintActive: boolean): { bestMoveUci: string | null; engine: LocalEngine | null }` to `useLiveCoachEngine(): { engine: LocalEngine | null }`.
- Line 39: `active` now `liveEvalEnabled || whiteFeedbackEnabled || blackFeedbackEnabled` — the `|| hintActive` term is gone.
- Line 36 (import) + line 41: added `liveEvalEngineConfigAtom` import and `const config = useAtomValue(liveEvalEngineConfigAtom);`.
- Line 43-51: engine resolution rewritten — filters loaded local engines, then `loadedLocal.find((e) => e.id === config.engineId) ?? loadedLocal[0] ?? null`. When `config.engineId` is `null` (unconfigured) or points at an engine that's no longer loaded, this falls through to `loadedLocal[0]`, i.e. exactly today's "first loaded local engine" behavior.
- Line 53: `const goMode = config.go;` replaces the removed `LIVE_COACH_GO_MODE` constant.
- Line 54-63: `extraOptions` resolved from `config.settings` — non-empty settings map to `{name, value: value?.toString() ?? ""}` (same pattern as `EvalListener.tsx` line 204-207); empty settings fall back to `[{ name: "MultiPV", value: "2" }]`, the exact literal that was hardcoded inline in the old `getBestMoves` call.
- Removed: the `bestMoveUci` `useState`, the `useEffect` that reset it on `finalFen` change, the `setBestMoveUci(...)` call inside `handleResultRef`, and `bestMoveUci` from the returned object. Nothing else in the classification/caching/annotation logic touched.
- The throttled-effect's `getBestMoves` call now takes `goMode` and `extraOptions` instead of the removed constants, and both are added to the effect's dependency array.
- `GoMode` type import and `useState` import dropped (no longer used in this file).

### `src/hooks/useCoachHint.ts` (new file)

- Signature: `useCoachHint(requested: boolean): { bestMoveUci: string | null; engine: LocalEngine | null }`.
- Reads `hintEngineConfigAtom`; engine resolution identical logic/shape to the live-eval hook above (loaded-local filter, id match, fallback to first loaded).
- `extraOptions` empty-settings fallback is `[{ name: "MultiPV", value: "1" }]` (only the top line is needed for a hint).
- `isContinuous = config.go.t === "Infinite"`; `active = isContinuous ? !isGameOver : requested`.
- Process-key suffix `-coach-hint` (vs. `-live-coach`), so the two hooks can never collide even pointed at the same engine binary/id.
- Carries the `bestMoveUci` state + finalFen-reset effect moved out of `useLiveCoachEngine.ts`, unchanged in spirit: reset to `null` on every `finalFen` change, set from the first line of `bestLines` on a matching result.
- No classification, no `setScore`, no annotation writes — this hook only tracks/returns `bestMoveUci` and `engine`.
- Same event-listener / throttled-search-effect / synchronous-short-circuit-consumption / unmount-kill structure as `useLiveCoachEngine.ts`.

### `src/components/boards/BoardGame.tsx`

- Line 83-84 (imports): added `import { useCoachHint } from "@/hooks/useCoachHint";` above the existing `useLiveCoachEngine` import.
- Line 137-138 (hook call site, was line 137): replaced the single combined call with
  ```ts
  const { engine: liveEvalEngine } = useLiveCoachEngine();
  const { bestMoveUci, engine: hintEngine } = useCoachHint(hintActive);
  ```
- Live-eval chart icon (~line 1196-1204), White feedback icon (~line 1206-1220), Black feedback icon (~line 1221-1235): all three `disabled={!coachEngine}` and their tooltip's `coachEngine ? ... : t("Board.Coach.NoEngine")` fallback changed to `liveEvalEngine`.
- Hint button (~line 1276-1281): `disabled={ !coachEngine || ... }` changed to `disabled={ !hintEngine || ... }`. The rest of the button — `gameState`, turn/player-type checks, the `onClick` three-state circle/arrow/clear cycle, `applyHintShapes`, `hintPending` state and its reveal `useEffect` — untouched.
- `hintActive`/`setHintActive` local state (line 133) unchanged; still passed as `requested` into `useCoachHint`.
- Confirmed via grep: zero remaining references to `coachEngine` anywhere in the file after the edit.

## 2. Shared-code vs. duplication decision

Duplicated the lifecycle skeleton (event listener + throttled search effect + synchronous short-circuit consumption + unmount cleanup + engine resolution) into `useCoachHint.ts` rather than extracting a shared helper.

Reasoning: the brief itself flagged that this lifecycle logic already went through a full review cycle that caught real concurrency/lifecycle bugs, and explicitly said to prefer duplication over an abstraction that adds risk under time pressure. The two hooks' bodies are close but not identical in outcome — live-eval carries `setScore`/`classifyMove`/annotation-caching state that the hint hook has no business touching, and the hint hook has the extra `isContinuous`/`active` branching on `Infinite` go-mode that live-eval doesn't need. A shared "skeleton" would either have to (a) grow parameters/callbacks to accommodate both call sites' different post-processing, which increases the surface area of the already-fragile lifecycle code, or (b) split at an awkward seam that doesn't cleanly separate "shared plumbing" from "per-hook policy." Given the task's explicit steer toward correctness-over-DRY-ness here, I duplicated the proven shape verbatim (adjusted for the hint's simpler payload) instead.

## 3. Verification

Commands run, in order, from the repo root:

1. `npx tsc --noEmit` — clean, no output, exit 0.
2. `npm run lint` (runs `tsc --noEmit && oxlint`) — no errors. New warnings introduced are exactly two per new/changed hook file (`useLiveCoachEngine.ts:164`, `useCoachHint.ts:135` — "complex expression in the dependency array"; `useLiveCoachEngine.ts:153`, `useCoachHint.ts:124` — "missing dependency: 'moves'"), both from the pre-existing `JSON.stringify(moves)` pattern in the dependency array that was already present in the original (unmodified-in-kind) `useLiveCoachEngine.ts` and is the same pattern already flagged in `EvalListener.tsx` (lines 175, 157) on this branch before my changes. No new warning classes, and no warnings anywhere outside the two coach hook files and `BoardGame.tsx` (which shows zero new warnings). Full warning list is otherwise identical to what's already on the branch elsewhere (TournamentCard, ReportModal, DatabaseLoader, etc. — all pre-existing and untouched by this change).
3. `npx vitest run` — `Test Files 11 passed (11)`, `Tests 84 passed (84)`. No new tests added — no new pure-function logic was introduced beyond what `classifyMove` (unchanged) already covers; the extracted `bestMoveUci` tracking in `useCoachHint.ts` is lifecycle plumbing tied to hooks/effects, not a standalone pure helper worth a unit test.

Commit hash: `7484471f`.

## 4. Trace-through (verification step 4)

Read the full diff end to end (`git diff` before commit, reproduced in the commit itself) and traced four scenarios:

**a) Live-eval, user never touched the new atoms.** `liveEvalEngineConfigAtom` defaults to `{ engineId: null, go: { t: "Time", c: 300 }, settings: [] }`. Engine resolution: `loadedLocal.find(e => e.id === null)` never matches (engine ids are non-null strings) → falls back to `loadedLocal[0]`, i.e. first loaded local engine — identical to the old hardcoded `.find(...) ?? null` behavior. `goMode = config.go` = `{ t: "Time", c: 300 }` — identical to the removed `LIVE_COACH_GO_MODE` constant. `extraOptions`: `config.settings.length === 0` → `[{ name: "MultiPV", value: "2" }]` — the exact literal removed from the inline call. Confirmed: byte-for-byte same behavior as before for an unconfigured user.

**b) Hint, user never touched the new atoms, on-demand.** `hintEngineConfigAtom` defaults identically (`engineId: null`, `go: { t: "Time", c: 300 }`, `settings: []`). `isContinuous = config.go.t === "Infinite"` → `false` (it's `"Time"`). `active = requested` (i.e. `hintActive`, driven by the Hint button click as before). Engine resolution falls back to first loaded local engine, same as (a). `goMode` = 300ms Time, matching old hardcoded hint behavior. `extraOptions` falls back to `MultiPV: 1` — this is a deliberate, spec-called-out change from the old shared session's `MultiPV: 2` (the hint only ever consumed the top line anyway; the brief explicitly asks for this cheaper default), not a regression. On-demand click-driven search timing/engine/go-mode otherwise match today exactly.

**c) Infinite hint go-mode starts independent of any click.** If a user (via the not-yet-built settings UI) sets `hintEngineConfigAtom.go = { t: "Infinite" }`: `isContinuous = true`, so `active = !isGameOver`, entirely independent of `requested`/`hintActive`. As soon as `engine && activeTab` are available and the game isn't over, the throttled effect (`useCoachHint.ts` lines ~127-166) starts the search on mount/position-change — the same throttled-effect-restarts-on-position-change pattern `EvalListener.tsx` already runs in production for its own `Infinite`-mode engines. The Hint button's `onClick` in `BoardGame.tsx` is unchanged: it sets `hintActive` (now irrelevant to whether the engine is running, since `active` no longer depends on it in continuous mode) and, since `bestMoveUci` is very likely already populated from the background search by the time of a click, reveals it immediately without going through the `hintPending` wait path. Confirmed this matches the spec's "Hint just reveals whatever's currently found."

**d) Unmount / process-key isolation.** Both hooks kill only their own last-started `{id, tab}` on unmount (`useLiveCoachEngine.ts` lines ~211-219, `useCoachHint.ts` lines ~178-186), and use disjoint suffixes (`-live-coach` vs. `-coach-hint`), so even when both configs point at the identical engine `id`, the two backend processes are addressed by different composite ids and can't collide, double-kill, or cross-consume each other's `bestMovesPayload` events (each listener filters on `payload.engine !== listenerId`, which now encodes the distinct suffix).

All four traces check out against the spec. No discrepancies found.
