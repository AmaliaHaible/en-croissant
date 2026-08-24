import { Divider, Group, Select, Slider, Stack, Text } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { commands } from "@/bindings";
import {
  applyDialValue,
  applyPreset,
  applyStyleValue,
  clearDialOverride,
  clearPreset,
  detectStrengthDial,
  detectStyleControl,
  findActivePreset,
  getPresetsForEngine,
  type StrengthDial,
  type StyleControl,
} from "@/utils/engineStrength";
import type { EngineSettings, LocalEngine } from "@/utils/engines";
import { unwrap } from "@/utils/unwrap";

function tierLabel(
  dial: StrengthDial,
  value: number,
  t: (key: string, fallback: string) => string,
) {
  if (value >= dial.max) return t("Board.Opponent.FullStrength", "Full strength");
  const pct = (value - dial.min) / (dial.max - dial.min || 1);
  if (pct < 0.2) return t("Board.Opponent.TierBeginner", "Beginner");
  if (pct < 0.4) return t("Board.Opponent.TierCasual", "Casual");
  if (pct < 0.6) return t("Board.Opponent.TierClub", "Club");
  if (pct < 0.8) return t("Board.Opponent.TierExpert", "Expert");
  return t("Board.Opponent.TierMaster", "Master");
}

function DialControl({
  dial,
  settings,
  setSettings,
}: {
  dial: StrengthDial;
  settings: EngineSettings;
  setSettings: (fn: (prev: EngineSettings) => EngineSettings) => void;
}) {
  const { t } = useTranslation();
  const currentValue =
    (settings.find((s) => s.name === dial.optionName)?.value as number | undefined) ?? dial.max;
  const [tempValue, setTempValue] = useState(currentValue);

  useEffect(() => {
    setTempValue(currentValue);
  }, [currentValue]);

  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text size="sm" fw="bold">
          {dial.kind === "elo"
            ? t("Board.Opponent.Elo", "Elo")
            : t("Board.Opponent.SkillLevel", "Skill level")}
        </Text>
        <Text size="sm" c="dimmed">
          {tierLabel(dial, tempValue, t)}
        </Text>
      </Group>
      <Slider
        min={dial.min}
        max={dial.max}
        value={tempValue}
        onChange={setTempValue}
        onChangeEnd={(v) =>
          setSettings((prev) =>
            v >= dial.max ? clearDialOverride(dial, prev) : applyDialValue(dial, v, prev),
          )
        }
        label={(v) => (dial.kind === "elo" ? `${v}` : `${v} / ${dial.max}`)}
        marks={[
          { value: dial.min, label: `${dial.min}` },
          { value: dial.max, label: `${dial.max}` },
        ]}
      />
    </Stack>
  );
}

function StyleControlSelect({
  style,
  settings,
  setSettings,
}: {
  style: StyleControl;
  settings: EngineSettings;
  setSettings: (fn: (prev: EngineSettings) => EngineSettings) => void;
}) {
  const { t } = useTranslation();
  const current =
    (settings.find((s) => s.name === style.optionName)?.value as string | undefined) ??
    style.defaultChoice ??
    style.choices[0];

  return (
    <Select
      label={t("Board.Opponent.Style", "Style")}
      allowDeselect={false}
      data={style.choices}
      value={current}
      onChange={(value) => {
        if (!value) return;
        setSettings((prev) => applyStyleValue(style, value, prev));
      }}
    />
  );
}

export function EngineStrengthControl({
  engine,
  settings,
  setSettings,
}: {
  engine: LocalEngine;
  settings: EngineSettings;
  setSettings: (fn: (prev: EngineSettings) => EngineSettings) => void;
}) {
  const { t } = useTranslation();
  const { data: config } = useSWRImmutable(["engine-config", engine.path], async ([, path]) =>
    unwrap(await commands.getEngineConfig(path)),
  );

  const dial = useMemo(() => (config ? detectStrengthDial(config.options) : null), [config]);
  const style = useMemo(() => (config ? detectStyleControl(config.options) : null), [config]);
  const presets = useMemo(
    () => getPresetsForEngine(config?.name ?? engine.name),
    [config, engine.name],
  );

  if (!dial && !style && !presets) {
    return null;
  }

  return (
    <Stack gap="xs">
      <Divider variant="dashed" label={t("Board.Opponent.Difficulty", "Difficulty")} />
      {presets && (
        <Select
          label={t("Board.Opponent.Personality", "Personality")}
          allowDeselect={false}
          data={[
            { value: "full", label: t("Board.Opponent.FullStrength", "Full strength") },
            ...presets.map((preset) => ({
              value: preset.id,
              label: `${preset.name} (~${preset.elo})`,
            })),
          ]}
          value={findActivePreset(presets, settings)?.id ?? "full"}
          onChange={(value) => {
            const chosen = presets.find((preset) => preset.id === value) ?? null;
            setSettings((prev) => {
              const cleared = presets.reduce((acc, preset) => clearPreset(preset, acc), prev);
              return chosen ? applyPreset(chosen, cleared) : cleared;
            });
          }}
          renderOption={({ option, checked }) => {
            const description =
              option.value === "full"
                ? t(
                    "Board.Opponent.FullStrengthDesc",
                    "No personality, plays at the engine's own default strength",
                  )
                : (presets.find((preset) => preset.id === option.value)?.description ?? "");
            return (
              <Group flex="1" gap="xs" justify="space-between" wrap="nowrap">
                <Stack gap={0}>
                  <Text size="sm">{option.label}</Text>
                  {description && (
                    <Text size="xs" c="dimmed">
                      {description}
                    </Text>
                  )}
                </Stack>
                {checked && <IconCheck size={16} style={{ flexShrink: 0 }} />}
              </Group>
            );
          }}
        />
      )}
      {dial && <DialControl dial={dial} settings={settings} setSettings={setSettings} />}
      {style && <StyleControlSelect style={style} settings={settings} setSettings={setSettings} />}
    </Stack>
  );
}
