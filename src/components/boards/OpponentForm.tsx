import {
  Center,
  Divider,
  Group,
  InputWrapper,
  SegmentedControl,
  Stack,
  TextInput,
} from "@mantine/core";
import { IconCpu, IconUser } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { EngineVariantSelect } from "@/components/common/EngineVariantSelect";
import { ImportantEngineSettings } from "@/components/common/ImportantEngineSettings";
import TimeInput, { type TimeType } from "@/components/common/TimeInput";
import type { TimeControlField } from "@/utils/clock";
import type { EngineSettings, LocalEngine } from "@/utils/engines";
import { EnginesSelect } from "./EnginesSelect";

export type OpponentSettings =
  | {
      type: "human";
      timeControl?: TimeControlField;
      name?: string;
      timeUnit?: TimeType;
      incrementUnit?: TimeType;
    }
  | {
      type: "engine";
      timeControl?: TimeControlField;
      engine: LocalEngine | null;
      variantId: string | null;
      /** Per-game overrides for the variant's "important" UCI options. Reset on engine/variant change. */
      settingOverrides?: EngineSettings;
      timeUnit?: TimeType;
      incrementUnit?: TimeType;
    };

export const DEFAULT_TIME_CONTROL: TimeControlField = {
  seconds: 180_000,
  increment: 2_000,
};

export function OpponentForm({
  sameTimeControl,
  opponent,
  setOpponent,
  setOtherOpponent,
}: {
  sameTimeControl: boolean;
  opponent: OpponentSettings;
  setOpponent: React.Dispatch<React.SetStateAction<OpponentSettings>>;
  setOtherOpponent: React.Dispatch<React.SetStateAction<OpponentSettings>>;
}) {
  const { t } = useTranslation();

  function updateType(type: "engine" | "human") {
    if (type === "human") {
      setOpponent((prev) => ({
        ...prev,
        type: "human",
        name: "Player",
      }));
    } else {
      setOpponent((prev) => ({
        ...prev,
        type: "engine",
        engine: null,
        variantId: null,
      }));
    }
  }

  return (
    <Stack flex={1}>
      <SegmentedControl
        data={[
          {
            value: "human",
            label: (
              <Center style={{ gap: 10 }}>
                <IconUser size={16} />
                <span>{t("Board.Opponent.Human")}</span>
              </Center>
            ),
          },
          {
            value: "engine",
            label: (
              <Center style={{ gap: 10 }}>
                <IconCpu size={16} />
                <span>{t("Common.Engine")}</span>
              </Center>
            ),
          },
        ]}
        value={opponent.type}
        onChange={(v) => updateType(v as "human" | "engine")}
      />

      {opponent.type === "human" && (
        <TextInput
          value={opponent.name ?? ""}
          onChange={(e) => setOpponent((prev) => ({ ...prev, name: e.target.value }))}
        />
      )}

      {opponent.type === "engine" && (
        <EnginesSelect
          engine={opponent.engine}
          setEngine={(engine) =>
            setOpponent((prev) => ({
              ...prev,
              engine,
              variantId: engine?.variants[0]?.id ?? null,
              settingOverrides: [],
            }))
          }
        />
      )}

      {opponent.type === "engine" && opponent.engine && (
        <EngineVariantSelect
          engine={opponent.engine}
          variantId={opponent.variantId}
          setVariantId={(variantId) =>
            setOpponent((prev) =>
              prev.type === "engine" ? { ...prev, variantId, settingOverrides: [] } : prev,
            )
          }
        />
      )}

      {opponent.type === "engine" && opponent.engine && (
        <ImportantEngineSettings
          engine={opponent.engine}
          variantId={opponent.variantId}
          overrides={opponent.settingOverrides ?? []}
          setOverrides={(next) =>
            setOpponent((prev) =>
              prev.type === "engine" ? { ...prev, settingOverrides: next } : prev,
            )
          }
        />
      )}

      <Divider variant="dashed" label={t("Board.Opponent.TimeSettings")} />
      <SegmentedControl
        data={[
          { value: "time", label: t("GoMode.Time") },
          { value: "unlimited", label: t("Board.Opponent.Unlimited") },
        ]}
        value={opponent.timeControl ? "time" : "unlimited"}
        onChange={(v) => {
          setOpponent((prev) => ({
            ...prev,
            timeControl: v === "time" ? DEFAULT_TIME_CONTROL : undefined,
          }));
          if (sameTimeControl) {
            setOtherOpponent((prev) => ({
              ...prev,
              timeControl: v === "time" ? DEFAULT_TIME_CONTROL : undefined,
            }));
          }
        }}
      />
      <Group grow wrap="nowrap">
        {opponent.timeControl && (
          <>
            <InputWrapper label={t("GoMode.Time")}>
              <TimeInput
                defaultType="m"
                type={opponent.timeUnit}
                onTypeChange={(t) => {
                  setOpponent((prev) => ({ ...prev, timeUnit: t }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({ ...prev, timeUnit: t }));
                  }
                }}
                value={opponent.timeControl.seconds}
                setValue={(v) => {
                  setOpponent((prev) => ({
                    ...prev,
                    timeControl: {
                      seconds: v.t === "Time" ? v.c : 0,
                      increment: prev.timeControl?.increment ?? 0,
                    },
                  }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({
                      ...prev,
                      timeControl: {
                        seconds: v.t === "Time" ? v.c : 0,
                        increment: prev.timeControl?.increment ?? 0,
                      },
                    }));
                  }
                }}
              />
            </InputWrapper>
            <InputWrapper label={t("Board.Opponent.Increment")}>
              <TimeInput
                defaultType="s"
                type={opponent.incrementUnit}
                onTypeChange={(t) => {
                  setOpponent((prev) => ({ ...prev, incrementUnit: t }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({ ...prev, incrementUnit: t }));
                  }
                }}
                value={opponent.timeControl.increment ?? 0}
                setValue={(v) => {
                  setOpponent((prev) => ({
                    ...prev,
                    timeControl: {
                      seconds: prev.timeControl?.seconds ?? 0,
                      increment: v.t === "Time" ? v.c : 0,
                    },
                  }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({
                      ...prev,
                      timeControl: {
                        seconds: prev.timeControl?.seconds ?? 0,
                        increment: v.t === "Time" ? v.c : 0,
                      },
                    }));
                  }
                }}
              />
            </InputWrapper>
          </>
        )}
      </Group>
    </Stack>
  );
}
