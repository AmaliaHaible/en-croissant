# Coach settings — fix wave 2 (final combined review)

Commit: **b93cf56d** on `master` (single commit, 8 files, +159 / -28)

All 5 findings addressed. The deferred Minor findings were not touched.

---

## Finding 1 — CRITICAL: opening Settings silently disables "Good move" classification

### What changed

- **`src/utils/coach.ts:8-40`** — new pure, exported helper alongside `classifyMove`:
  - `export type EngineOption = { name: string; value: string }`
  - `export function withMultiPvFloor(settings: EngineSettings, floor = 2): EngineOption[]`
  - It maps the configured settings to the backend's `extraOptions` shape and then
    _merges_ the floor: appends `MultiPV: "2"` when absent, raises it when present
    but below the floor, leaves `MultiPV >= 2` untouched. The comparison is written
    as `!(Number(value) >= floor)` so a `null`/empty/non-numeric value (→ `NaN`) is
    also raised rather than kept.
- **`src/hooks/useLiveCoachEngine.ts:20,52-55`** — the old
  `config.settings.length > 0 ? map(...) : [{MultiPV:2}]` ternary is replaced by
  `const extraOptions = useMemo(() => withMultiPvFloor(config.settings), [config.settings]);`
  plus a comment explaining _why_ it must merge rather than replace.
- **`src/hooks/useCoachHint.ts`** — deliberately **unchanged** in this respect. The
  hint hook keeps its `MultiPV: 1` fallback and gets no floor, as specified.
- **`src/utils/tests/coach.test.ts:165-204`** — 5 new unit tests (see below).

I took the extraction option rather than inlining: `coach.ts` already exists as the
pure-logic module for this feature, `EngineSettings` is imported as a _type only_
(`import type { EngineSettings } from "./engines"`), so no runtime dependency on
`engines.ts` (which pulls in tauri-http/swr) leaks into the test.

### Verification of the specific failure mode

New tests, all passing:

| test                                                           | asserts                                                |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| `withMultiPvFloor adds MultiPV to empty settings`              | `[]` → `[{MultiPV, "2"}]`                              |
| `withMultiPvFloor adds MultiPV when settings don't mention it` | `Threads/Hash` preserved, `MultiPV: "2"` appended      |
| `withMultiPvFloor raises a MultiPV below the floor`            | `MultiPV: 1` → `"2"`, `Threads` preserved and in place |
| `withMultiPvFloor leaves a MultiPV above the floor alone`      | `MultiPV: 3` → `"3"`                                   |
| `withMultiPvFloor raises an unparseable MultiPV to the floor`  | `MultiPV: null` → `"2"`                                |

The failure mode was "any non-empty settings array drops the floor". The 2nd, 3rd
and 5th tests are exactly that case and now assert the floor survives. The 4th test
guards the opposite regression (clamping a deliberate MultiPV 3 back down).

Note the fix for Finding 4 removes the _trigger_ as well as the consequence: with
no loaded local engine, `EnginesSelect` is not rendered at all from the Coach tab,
so its auto-pick effect can't write anything on mount. But the hook-level floor is
what makes it unable to recur, which was the requirement.

Also updated `Settings.Coach.LiveEval.Desc` (`src/translation/en-US.json:545`) —
it previously told the user "MultiPV must be at least 2 …", which is now stale;
it says the value is automatically raised to 2.

---

## Finding 2 — IMPORTANT: hint reveals the first depth-1 result

### What changed (`src/hooks/useCoachHint.ts`)

- **:60-64** — new `isStreaming` flag next to the existing `isContinuous`:
  `goMode.t === "Infinite" || goMode.t === "PlayersTime"`. (`isContinuous`, which
  drives whether the session runs for the whole game, is left exactly as it was;
  `isStreaming` only decides when results may be _published_.)
- **:119-135** — `handleResultRef` now takes `progress` as a third argument and
  returns early on `if (!isStreaming && progress < 100) return;` before calling
  `setBestMoveUci`.
- **:152** — event listener now forwards `payload.progress`.
- **:200-201** — the `getBestMoves` synchronous short-circuit return value now
  destructures `[progress, bestLines]` instead of `[, bestLines]` and forwards it.

`PlayersTime` is included in `isStreaming` (rather than treated as bounded) on
purpose: I checked the backend and it is hard-coded to report `99.99`, never `100`,
exactly like `Infinite` — treating it as bounded would mean a hint that never
appears. It isn't selectable in the coach UI (`GoModeInput` offers only
Time/Depth/Nodes/Infinite), but the config atom is persisted user data, so the
defensive branch costs nothing. The comment in the code says so.

### Verification

Backend confirmation, `src-tauri/src/chess.rs:403-451`:

- intermediate `info` lines compute progress as `elapsed/time`, `depth/depth`,
  `nodes/nodes` for Time/Depth/Nodes, and a hard-coded `99.99` for
  `PlayersTime`/`Infinite`;
- on `UciMessage::BestMove` — i.e. when a bounded search actually terminates — the
  backend emits a final `BestMovesPayload` with `progress: 100.0` carrying
  `last_best_moves`.

So a bounded search _does_ produce exactly one `progress === 100` event with the
final lines, which is the event this gate now waits for; and streaming modes never
would, which is why they're exempted.

---

## Finding 3 — IMPORTANT: on-demand mode becomes "always search"

### What changed (`src/components/boards/BoardGame.tsx:222-232`)

The existing position-change effect (`[currentNode.fen]`) grew from resetting only
`hintPending` to resetting the whole per-position hint request:

```
useEffect(() => {
  setHintPending(false);
  setHintActive(false);
  setHintShownUci(null);
}, [currentNode.fen]);
```

with a comment recording why (`hintActive` staying true is what turns one click
into a whole-game background search).

### Verification

`useCoachHint`'s `active` in bounded mode is `requested`, i.e. `hintActive`. Once
it flips to `false`, the throttled search effect (which lists `active` in its deps)
takes the `!active` branch and calls `stopEngine` on the process it actually
started. So the search is not merely un-restarted, it is stopped.

All three state setters are `useState` setters, so the effect's dependency array is
still statically correct — `npm run lint` reports no new `exhaustive-deps` warning
for it (warning count is identical to baseline, see below).

---

## Finding 4 — IMPORTANT: tab offers engines the hooks refuse

### What changed

- **`src/components/settings/CoachSettingsTab.tsx:25-32`** — the engine list filter
  is now `e.type === "local" && !!e.loaded`, matching both hooks exactly, with a
  comment naming them.
- **`src/components/settings/CoachSettingsTab.tsx:49-56`** — when that list is
  empty, a dimmed `Text` renders instead of the picker:
  _"No loaded engine available. Load at least one local engine in Settings >
  Engines first."_ (`Settings.Coach.NoEngines`, added at
  `src/translation/en-US.json:546`).
- **`src/components/boards/EnginesSelect.tsx:7-25`** — new optional
  `filter?: (engine: LocalEngine) => boolean` prop, applied to the local-engine
  list before dedupe/auto-pick. Necessary because `EnginesSelect` builds its own
  list from `enginesAtom` and would otherwise have kept listing unloaded engines
  in the dropdown regardless of the parent's filtering. The Coach tab passes
  `filter={(e) => !!e.loaded}`.
- `OpponentForm.tsx`, the only other caller, omits the prop and is byte-for-byte
  unaffected (`!filter || filter(e)`).

`CoachEngineSection` gained its own `useTranslation()` call for the new string.

---

## Finding 5 — IMPORTANT: orphaned hint circle when the best move changes

### What changed (`src/components/boards/BoardGame.tsx`)

- **:138-144** — new state `const [hintShownUci, setHintShownUci] = useState<string | null>(null)`
  with a comment explaining the orphaned-shape mechanism.
- **:215-220** — the auto-reveal effect (hint requested before a result existed)
  draws the circle from `bestMoveUci` _and_ freezes it: `setHintShownUci(bestMoveUci)`.
- **:228-232** — cleared on position change (same effect as Finding 3).
- **:1303-1332** — the click handler resolves `const uci = hintShownUci ?? bestMoveUci;`
  once, and every subsequent use (`hintSquares`, the `hasCircle`/`hasArrow` shape
  probes, all three `applyHintShapes` calls) goes through `uci`. The circle and
  arrow branches (re-)freeze `setHintShownUci(uci)`; the clear branch resets it to
  `null` alongside `hintActive`/`hintPending`.

`bestMoveUci` is still the sole source for _populating_ the frozen value — on the
first click and in the pending auto-reveal effect — exactly as specified; it is
simply never re-consulted once a reveal is in progress.

---

## Verification step 4 — trace-throughs

**(a) Settings opened on an unrelated tab, fresh MultiPV=1 engine loaded.**
Mantine's `keepMounted` default still mounts `CoachSettingsTab`; `EnginesSelect`'s
auto-pick still fires and `setEngine` still writes `engine.settings`
(`[{MultiPV, 1}, …]`) into `liveEvalEngineConfigAtom`. `useLiveCoachEngine` then
computes `extraOptions = withMultiPvFloor([{MultiPV,1},…])` → `MultiPV` raised to
`"2"`, everything else preserved. The engine searches 2 lines, `classifyMove`'s
`prevMoves.length > 1` precondition holds, "Good" detection keeps working.
The second trigger described in the finding (the `else` branch re-copying
`engine.settings` on identity change) has the same outcome, and a user's deliberate
`MultiPV: 3` is _not_ clamped (unit-tested).

**(b) Hint configured to Time / 8000 ms, click Hint.**
`hintActive` → true → bounded mode → search starts. Intermediate `info`-derived
payloads carry `progress = elapsed/8000*100 < 100` and are now dropped before
`setBestMoveUci`. `bestMoveUci` stays `null`, so the click handler set
`hintPending = true` and nothing is drawn yet. At ~8 s the engine emits `bestmove`,
the backend emits its `progress: 100.0` payload with `last_best_moves`, the gate
passes, `bestMoveUci` is set, and the `hintPending` effect (which is written as
"nothing yet → return", so it tolerates any delay) draws the circle and freezes
`hintShownUci`. The 8-second budget is honored. Infinite mode is untouched: every
improvement is still published.

**(c) Click Hint once, then play several more moves.**
Move played → `currentNode.fen` changes → the effect sets `hintActive = false`
(plus `hintPending`/`hintShownUci` to their empty values). `useCoachHint`'s
`active` (= `requested` in bounded mode) goes false, its throttled effect takes the
stop branch and calls `stopEngine(started.id, started.tab)`. No search runs on the
new position, or on any later one, until Hint is clicked again. Within a single
position the circle→arrow→clear cycle is unaffected: it depends on
`hintShownUci`/`currentNode.shapes`, not on `hintActive`.

**(d) Coach tab, engine not loaded.**
It can no longer be picked — the dropdown is built from loaded local engines only
(both in the tab and inside `EnginesSelect` via the new `filter` prop). If a
previously-selected engine gets unloaded, `selectedEngine` resolves to `null` and
`EnginesSelect` auto-picks the first loaded engine — which is precisely the engine
the hooks would fall back to, so the UI and the runtime now agree instead of
diverging silently. With no loaded local engine at all, the picker is replaced by
the explanatory `Settings.Coach.NoEngines` sentence pointing at Settings > Engines.

**(e) Continuous mode, top move changes between click 1 and click 2.**
Click 1: `uci = bestMoveUci = e2e4`, circle drawn on e2, `hintShownUci = "e2e4"`.
Search improves, `bestMoveUci` becomes `d2d4`. Click 2: `uci = hintShownUci = "e2e4"`
(the live value is not consulted), `hasCircle` matches the e2 circle, so the branch
taken is the arrow one and `applyHintShapes("e2e4","arrow")` replaces that exact
shape (its `otherShapes` filter also keys off `from = e2`). One shape on the board,
clean transition, nothing orphaned. Click 3 clears it and resets `hintShownUci`, so
a subsequent click starts a fresh reveal from the then-current `bestMoveUci`.

---

## Verification steps 1–3 (commands and output)

```
$ npx tsc --noEmit
(no output — clean)
```

```
$ npm run lint          # = tsc --noEmit && oxlint
… 53 warnings
```

Baseline check: I stashed the change set and re-ran `npm run lint` on the pristine
tree — also **53** warnings. Same count, and no warning is attributed to any line I
added (the four `useCoachHint`/`useLiveCoachEngine` `exhaustive-deps` warnings
listed are the pre-existing `JSON.stringify(moves)` / missing-`moves` ones from the
earlier commits, unchanged).

```
$ npx vitest run
 Test Files  11 passed (11)
      Tests  89 passed (89)
```

```
$ npx vitest run src/utils/tests/coach.test.ts --reporter=verbose
 ✓ … 7 pre-existing classifyMove tests
 ✓ withMultiPvFloor adds MultiPV to empty settings
 ✓ withMultiPvFloor adds MultiPV when settings don't mention it
 ✓ withMultiPvFloor raises a MultiPV below the floor
 ✓ withMultiPvFloor leaves a MultiPV above the floor alone
 ✓ withMultiPvFloor raises an unparseable MultiPV to the floor
      Tests  12 passed (12)
```

### Note on formatting churn

An `oxfmt` pass reformatted a handful of pre-existing lines outside my changes
(`src/state/atoms.ts`, two docs markdown files, and four unrelated JSX blocks in
`BoardGame.tsx`). All of that was reverted so the commit contains only the five
fixes; `git status` after the commit is clean apart from this untracked report.

## Files touched

- `src/utils/coach.ts` (+35)
- `src/utils/tests/coach.test.ts` (+42)
- `src/hooks/useLiveCoachEngine.ts`
- `src/hooks/useCoachHint.ts`
- `src/components/boards/BoardGame.tsx`
- `src/components/boards/EnginesSelect.tsx`
- `src/components/settings/CoachSettingsTab.tsx`
- `src/translation/en-US.json`

## Residual concerns

- The root cause of Finding 1 (Mantine `Tabs` `keepMounted` + `EnginesSelect`'s
  auto-pick writing engine defaults into a persisted config on mount) is _contained_
  rather than removed: live-eval is now immune via the floor, and the Coach tab no
  longer renders the picker when nothing is loaded, but a mount-time write to the
  two coach config atoms is still possible in principle. `keepMounted={false}` on
  `SettingsPage`'s `Tabs` would remove it outright — out of scope for this round.
- Nothing about the two new hooks is covered by integration tests; the gating
  behaviour in Findings 2/3/5 was verified by reading the backend progress code and
  tracing state, not by executing the app.
