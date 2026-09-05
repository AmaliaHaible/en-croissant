# Task A: Add Persisted Config Atoms for Live-Eval and Hint Engine Settings

## Changes Made

Added to `src/state/atoms.ts` (after line 223):

1. **New type export**: `CoachEngineConfig`
   - Holds `engineId` (string | null), `go` (GoMode), and `settings` (EngineSettings)
   - Represents an engine configuration override for coach features

2. **New atom export**: `liveEvalEngineConfigAtom`
   - Persisted storage key: `"live-eval-engine-config"`
   - Default value: `{ engineId: null, go: { t: "Time", c: 300 }, settings: [] }`
   - Used to override engine settings for the live eval/classification loop

3. **New atom export**: `hintEngineConfigAtom`
   - Persisted storage key: `"hint-engine-config"`
   - Default value: `{ engineId: null, go: { t: "Time", c: 300 }, settings: [] }`
   - Used to override engine settings for the hint engine

**No new imports were added** — both required types (`GoMode` from `@/bindings` and `EngineSettings` from `@/utils/engines`) were already imported in the file.

## TypeScript Verification

```
$ npx tsc --noEmit
(no output — clean, no errors)
```

## Commit

- **Hash**: `bedf4e70`
- **Message**: "Add persisted config atoms for live-eval and hint engine settings"
- **File changed**: `src/state/atoms.ts` (17 insertions)

## Notes

- Both atoms default to "not configured" state (engineId: null, settings: [])
- This preserves existing hardcoded behavior until a later task wires these atoms into the actual coach code and adds a settings UI
- The go mode defaults to 300 centiseconds (3 seconds) time-based analysis
