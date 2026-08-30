import { Checkbox, Divider, NumberInput, Select, Stack, TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { commands, type UciOptionConfig } from "@/bindings";
import { type EngineSettings, type LocalEngine } from "@/utils/engines";
import { unwrap } from "@/utils/unwrap";

/**
 * Editable controls for the UCI options a variant's author flagged as "important"
 * (`variant.importantSettings`). Shown in the New Game opponent setup so a per-game value
 * (e.g. Skill Level) can be set without touching the saved variant. Renders nothing when the
 * chosen variant flags no options, or when the engine config can't be read yet.
 *
 * `overrides` holds only the values the user has changed for this game; the displayed value
 * for an untouched option falls back to the variant's saved setting, then the UCI default.
 */
export function ImportantEngineSettings({
  engine,
  variantId,
  overrides,
  setOverrides,
}: {
  engine: LocalEngine;
  variantId: string | null;
  overrides: EngineSettings;
  setOverrides: (next: EngineSettings) => void;
}) {
  const { t } = useTranslation();

  const variant = engine.variants.find((v) => v.id === variantId) ?? engine.variants[0];
  const important = variant?.importantSettings ?? [];

  const { data: config } = useSWRImmutable(
    important.length > 0 ? ["engine-config", engine.path] : null,
    async ([, path]) => unwrap(await commands.getEngineConfig(path)),
  );

  if (important.length === 0 || !config) return null;

  const options = important
    .map((name) => config.options.find((o) => o.value.name === name))
    .filter((o): o is UciOptionConfig => o !== undefined && o.type !== "button");

  if (options.length === 0) return null;

  function currentValue(name: string): string | number | boolean | null | undefined {
    const override = overrides.find((s) => s.name === name);
    if (override) return override.value;
    return variant?.settings.find((s) => s.name === name)?.value;
  }

  function setOverride(name: string, value: string | number | boolean | null) {
    const rest = overrides.filter((s) => s.name !== name);
    setOverrides([...rest, { name, value }]);
  }

  return (
    <Stack gap="xs">
      <Divider variant="dashed" label={t("Board.Opponent.EngineOptions", "Engine options")} />
      {options.map((option) => {
        const name = option.value.name;
        if (option.type === "spin") {
          const value = currentValue(name) ?? option.value.default;
          return (
            <NumberInput
              key={name}
              label={name}
              min={option.value.min != null ? Number(option.value.min) : undefined}
              max={option.value.max != null ? Number(option.value.max) : undefined}
              value={value != null ? Number(value) : undefined}
              onChange={(v) => setOverride(name, typeof v === "number" ? v : Number(v))}
            />
          );
        }
        if (option.type === "check") {
          const value = currentValue(name) ?? option.value.default ?? false;
          return (
            <Checkbox
              key={name}
              label={name}
              checked={Boolean(value)}
              onChange={(e) => setOverride(name, e.currentTarget.checked)}
            />
          );
        }
        if (option.type === "combo") {
          const value = currentValue(name) ?? option.value.default;
          return (
            <Select
              key={name}
              label={name}
              data={Array.from(new Set(option.value.var ?? []))}
              value={value != null ? String(value) : null}
              onChange={(v) => v != null && setOverride(name, v)}
            />
          );
        }
        if (option.type === "string") {
          const value = currentValue(name) ?? option.value.default ?? "";
          return (
            <TextInput
              key={name}
              label={name}
              value={String(value)}
              onChange={(e) => setOverride(name, e.currentTarget.value)}
            />
          );
        }
        return null;
      })}
    </Stack>
  );
}
