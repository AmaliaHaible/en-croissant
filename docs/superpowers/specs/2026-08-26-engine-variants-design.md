# Engine Variants — Design

## Summary

Replace each engine's single, flat option set with a list of named,
user-editable **variants** — full option bundles (any UCI option, plus
search mode / `GoMode`) that can be created, edited, duplicated, and
deleted per engine. Create Game, Coach settings (live-eval/hint), and
engine management all switch from picking individual knobs (threads,
hash, skill, elo, personality, search mode) to picking a saved variant.

## Scope

In scope:
- New `variants: EngineVariant[]` field on `Engine` (replacing the
  current top-level `settings`/`go` fields), where
  `EngineVariant = {id, name, go, settings}`.
- One-time migration of `engines.json` from the old shape to the new
  shape, including seeding Rodent II's 10 hardcoded personalities as
  real, editable variants.
- Variant management UI in `EnginesPage.tsx`'s engine detail pane
  (switch between variants, add/rename/duplicate/delete, edit a
  variant's `GoMode` and UCI options via the existing generic option
  renderer).
- Create Game (`OpponentForm.tsx`): replace `EngineStrengthControl`
  (personality/elo/skill/style selects) and the minimal
  `EngineSettingsForm` (Threads/Hash sliders) with a single variant
  `Select`.
- Coach settings (`CoachSettingsTab.tsx`): replace the full
  `EngineSettingsForm` per role with an engine picker + variant
  `Select`, mirroring Create Game.
- Removal of `src/utils/engineStrength.ts`'s dial/style detection and
  preset-registry machinery, `src/utils/presets/rodentII.ts`, and
  `EngineStrengthControl.tsx`, once variants fully replace them.

Out of scope:
- Any UI change to the Analysis panel (`EngineSelection.tsx` /
  `tabEngineSettingsFamily`). It keeps its current per-tab
  override/sync behavior; only its internal data source changes (see
  Architecture).
- Chess rule variants (960, Atomic, King of the Hill, etc.) — unrelated
  to this feature; not touched.
- Reordering variants or explicitly choosing which variant is
  "default" beyond array order (see Architecture).

## Background: what already exists

- `Engine` (`src/utils/engines.ts`) is a Zod-validated
  `LocalEngine | RemoteEngine` union, each carrying one flat
  `settings?: EngineSettings | null` (`{name, value}[]`) and one
  `go?: GoMode | null`, persisted in `enginesAtom`
  (`atomWithStorage<Engine[]>("engines/engines.json", ...)`).
- `requiredEngineSettings = ["MultiPV", "Threads", "Hash"]` are
  auto-populated from UCI defaults whenever missing from an engine's
  settings.
- Three ad-hoc precedents for "engine + overridden settings, separate
  from the canonical engine record" already exist: `tabEngineSettingsFamily`
  (per-tab Analysis override, with a `synced` flag that re-pulls from
  the engine's own `settings`/`go`), `CoachEngineConfig` (`{engineId,
  go, settings}`, one instance each for live-eval and hint), and
  `OpponentSettings.engineSettings` (per-game-setup override in Create
  Game). None of these are named/reusable/user-facing as a concept.
- `PRESET_REGISTRY` (`src/utils/engineStrength.ts` +
  `src/utils/presets/rodentII.ts`) is the one existing named-preset
  mechanism: 10 hardcoded Rodent II "personalities", matched by
  engine-name regex, not user-editable, usable only from Create Game's
  `EngineStrengthControl`.
- `detectStrengthDial`/`detectStyleControl` (`engineStrength.ts`)
  heuristically find `UCI_Elo`/`Skill`/`Personality`-style UCI options
  by name to drive `EngineStrengthControl`'s sliders/selects.
- `EnginesPage.tsx`'s per-engine `EngineSettings` detail view already
  has a fully generic UCI-option renderer (spin/combo/string/check via
  `ts-pattern`), a `GoModeInput`, a Syzygy-path toggle, Reset,
  Duplicate (whole engine), and an "Edit JSON" escape hatch that
  round-trips the whole `Engine` object through `engineSchema.safeParse`.
- `describeStrengthSuffix` appends a short strength/style label (e.g.
  "Skill 5", "Aggressive") to an engine's PGN-header display name,
  derived from the active preset/dial/style.

## Approach

Fold `settings`+`go` into a list of named variants on the engine
record itself, rather than inventing a separate "variants" store or
keeping the flat fields around as a parallel "default" config. This
keeps exactly one place per engine that owns its option data (matching
how `EnginesPage.tsx` already owns UCI-option editing), and every
consumer (Create Game, Coach, Analysis) becomes "pick an engine, then
reference one of its variants by id" — a strict generalization of the
`CoachEngineConfig` pattern that already exists today, applied
consistently everywhere instead of ad hoc per feature.

Variants are referenced by id, not copied, at every call site (Create
Game's `OpponentSettings`, Coach's `CoachEngineConfig`). This means
editing a variant in `EnginesPage.tsx` after it's already selected
elsewhere transparently updates anywhere that variant is in use — no
stale snapshots to reconcile.

## Architecture & data model

```ts
type EngineVariant = {
  id: string;
  name: string;
  go: GoMode;
  settings: EngineSettings; // unchanged: {name, value}[]
};
```

- `LocalEngine`/`RemoteEngine` drop `settings`/`go`, gain
  `variants: EngineVariant[]` (min length 1, enforced by the Zod
  schema).
- `variants[0]` is the implicit default: used wherever a single
  fallback config is still needed without an explicit picker —
  currently only `tabEngineSettingsFamily`'s "synced" default in the
  Analysis panel. It's an ordinary variant otherwise (renamable,
  editable, deletable as long as it isn't the last one). No explicit
  "is default" flag or reordering UI — array order is the only
  ordering concept, matching the minimal need for it.
- `requiredEngineSettings` auto-population runs per variant, at
  variant-creation/open time (same trigger as today, just scoped one
  level deeper).
- New engines (via `AddEngine.tsx`) are created with a single
  `variants: [{id, name: "Default", go: <existing default>, settings:
  []}]`.

### Migration

Runs once inside the existing `createAsyncZodStorage` read path for
`enginesAtom` in `src/utils/engines.ts`, gated by a schema-version
marker so it only executes against pre-migration data:

1. Any engine with old top-level `settings`/`go` →
   `variants: [{id: <new>, name: "Default", go: <old go ?? default>,
   settings: <old settings ?? []>}]`.
2. Additionally, for any engine matching the existing Rodent II regex
   (`/rodent\s*ii\b/i`), append one variant per `PRESET_REGISTRY`
   entry, reusing the existing `applyPreset` merge logic (base default
   settings + preset's `options`) so values match today's behavior
   exactly. Variant name = preset name (e.g. "Aggressive").
3. `PRESET_REGISTRY`, `src/utils/presets/rodentII.ts`,
   `detectStrengthDial`/`detectStyleControl`/`applyDialValue`/
   `applyStyleValue`/`applyPreset`/`findActivePreset` in
   `engineStrength.ts`, and `EngineStrengthControl.tsx` are deleted
   once migration and Create Game's new UI both land (migration only
   needs the merge logic transiently — inline it into the migration
   function rather than keeping the whole module alive).

### Consumers

- **Create Game** (`OpponentForm.tsx`): `OpponentSettings`'s engine
  branch changes from `{engine, go, engineSettings?}` to `{engine,
  variantId}`. `BoardGame.tsx`'s `toPlayerConfig` resolves
  `engine.variants.find(v => v.id === variantId)` at game-start time.
  The PGN-header suffix becomes the variant's `name` directly (no more
  `describeStrengthSuffix` heuristics).
- **Coach settings** (`CoachSettingsTab.tsx`): `CoachEngineConfig`
  becomes `{engineId: string | null; variantId: string | null}`.
  `useLiveCoachEngine.ts`/`useCoachHint.ts` resolve the variant the
  same way, at use time. `withMultiPvFloor` still applies as a runtime
  patch on top of the resolved variant's settings for the hint engine
  — a floor enforced for that specific search, not persisted into the
  saved variant.
- **Analysis panel** (`tabEngineSettingsFamily`): no UI change. Its
  "synced" default now reads `engine.variants[0]` instead of the old
  top-level `settings`/`go`. Per-tab override and the sync toggle
  behave exactly as before.
- **`EnginesPage.tsx`**: see UI section below.
- **Global Tablebase (Syzygy) section**: currently applies one path
  across all engines' single settings blob; now applies across **all
  variants of all engines**.

## UI

### `EnginesPage.tsx` — engine detail pane

- A variant switcher (tabs, or a `Select` if the list grows) at the
  top of the detail pane, showing each variant's name.
- Actions: **Add** (clones the currently-selected variant as a
  starting point, prompts for a name), **Rename**, **Duplicate**,
  **Delete** (disabled when it's the only remaining variant).
- Below the switcher: the existing `GoModeInput`, Syzygy toggle, and
  generic per-UCI-option renderer, now scoped to the selected variant.
- **Reset**: resets the *selected variant* to `requiredEngineSettings`
  at UCI defaults (same behavior as today, per-variant instead of
  per-engine).
- **Edit JSON** and whole-engine **Duplicate**: unchanged — they
  already operate on/round-trip the full `Engine` object, which now
  transparently includes `variants`.

### Create Game (`OpponentForm.tsx`)

- `EngineStrengthControl` and the minimal `EngineSettingsForm`
  (Threads/Hash) are removed entirely from this form.
- A single variant `Select` appears under the engine picker, populated
  from `engine.variants` (labeled by name), defaulting to `variants[0]`
  whenever the engine selection changes.

### Coach settings (`CoachSettingsTab.tsx`)

- `CoachEngineSection` drops the full `EngineSettingsForm` and shows:
  `EnginesSelect` (unchanged, filtered to loaded local engines) + the
  same variant `Select` component used in Create Game, defaulting to
  `variants[0]` on engine change.

## Edge cases

- **Engine has exactly one variant**: Delete is disabled/hidden for
  it; everything else (rename, edit) works normally.
- **Selected variant deleted while referenced elsewhere** (e.g. a
  Create Game tab or Coach config points at a variant id that no
  longer exists): resolve to `variants[0]` as a fallback, same pattern
  already used for a missing/unloaded engine reference today.
- **Remote engines** (`chessdb`/`lichess`): same `variants` shape
  applies; these have far fewer UCI options in practice, so a
  single-variant default is the common case but not special-cased.
- **Old `engines.json` from before this change**: handled entirely by
  the one-time migration; no dual-format runtime support needed after
  that.

## Testing

- **Unit**: migration function tested against a fixture pre-migration
  `engines.json` (including a Rodent II entry), asserting the upgraded
  shape and that the 10 seeded personality variants' merged settings
  match today's `applyPreset` output for each preset.
- **Type/schema**: `engineSettingsSchema`/`localEngineSchema`/
  `remoteEngineSchema` updates keep `engineSchema.safeParse` (used by
  the JSON-edit modal) working against the new shape; project
  typecheck/build passes.
- **Manual/integration** (dev server):
  1. `EnginesPage`: add/rename/edit/duplicate/delete variants; confirm
     the last-remaining variant can't be deleted.
  2. Create Game: engine selection populates the variant dropdown
     correctly and defaults sensibly; start a game and confirm the
     selected variant's options/go-mode are what's actually sent to
     the engine.
  3. Coach settings: pick engine+variant for both live-eval and hint;
     confirm the hint's MultiPV floor still applies on top.
  4. Analysis panel: engine selection/sync behavior is unchanged from
     a user's perspective.
- No new backend (Rust) behavior — `EngineOption`/`setoption` handling
  is unchanged; only the client-side shape of what gets sent changes.
