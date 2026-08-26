import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Checkbox,
  Divider,
  FileInput,
  Group,
  Input,
  JsonInput,
  Modal,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Space,
  Stack,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import {
  IconCloud,
  IconCopy,
  IconCpu,
  IconDatabase,
  IconDeviceDesktopAnalytics,
  IconFolder,
  IconPhotoPlus,
  IconPlus,
  IconSearch,
  IconServer,
  IconTrash,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { platform } from "@tauri-apps/plugin-os";
import { open } from "@tauri-apps/plugin-dialog";
import { useAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { match, P } from "ts-pattern";
import { commands } from "@/bindings";
import { notifications } from "@mantine/notifications";
import { resolve } from "@tauri-apps/api/path";
import { copyFile, exists } from "@tauri-apps/plugin-fs";
import { getEnginesDir } from "@/utils/directories";
import { Route } from "@/routes/engines";
import { enginesAtom, storedSyzygyPathAtom } from "@/state/atoms";
import {
  applySyzygyPathToAllEngines,
  type Engine,
  type EngineVariant,
  engineSchema,
  getDefaultVariant,
  type LocalEngine,
  type RemoteEngine,
  requiredEngineSettings,
  withDefaultVariant,
} from "@/utils/engines";
import { formatBytes } from "@/utils/format";
import { useHardwareInfo } from "@/utils/hardware";
import { unwrap } from "@/utils/unwrap";
import ConfirmModal from "../common/ConfirmModal";
import GenericCard from "../common/GenericCard";
import GoModeInput from "../common/GoModeInput";
import LocalImage from "../common/LocalImage";
import OpenFolderButton from "../common/OpenFolderButton";
import LinesSlider from "../panels/analysis/LinesSlider";
import AddEngine from "./AddEngine";
import { VariantManager } from "./VariantManager";

function HardwareConfigBanner() {
  const { hardware, isLoading } = useHardwareInfo();
  if (isLoading || !hardware) return null;

  return (
    <Paper withBorder radius="md" p="sm" mx="md" mb="xs">
      <Group justify="space-between" align="center" wrap="wrap" gap="md">
        <Group gap="xl" wrap="wrap">
          {/* CPU: Cores & Threads */}
          <Group gap="xs" wrap="nowrap">
            <ThemeIcon size="lg" radius="md" variant="light" color="blue">
              <IconCpu size="1.2rem" />
            </ThemeIcon>
            <div>
              <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                CPU ({hardware.physicalCores} Cores / {hardware.logicalCores} Threads)
              </Text>
              <Text size="xs" fw={700} lineClamp={1}>
                {hardware.cpuBrand}
              </Text>
            </div>
          </Group>

          {/* GPU & VRAM */}
          <Group gap="xs" wrap="nowrap">
            <ThemeIcon size="lg" radius="md" variant="light" color="grape">
              <IconDeviceDesktopAnalytics size="1.2rem" />
            </ThemeIcon>
            <div>
              <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                GPU {hardware.vramMb ? `(${formatBytes(hardware.vramMb * 1024 * 1024)} VRAM)` : ""}
              </Text>
              <Text size="xs" fw={700} lineClamp={1}>
                {hardware.gpuBrand}
              </Text>
            </div>
          </Group>

          {/* RAM */}
          <Group gap="xs" wrap="nowrap">
            <ThemeIcon size="lg" radius="md" variant="light" color="teal">
              <IconServer size="1.2rem" />
            </ThemeIcon>
            <div>
              <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                System Memory
              </Text>
              <Text size="xs" fw={700}>
                {formatBytes(hardware.totalMemoryMb * 1024 * 1024)} RAM (
                {formatBytes(hardware.availableMemoryMb * 1024 * 1024)} Free)
              </Text>
            </div>
          </Group>
        </Group>

        {/* Engine Recommendations */}
        <Group gap="xs">
          <Badge size="sm" variant="light" color="blue">
            Recommended: {hardware.recommendedThreads} Threads
          </Badge>
          <Badge size="sm" variant="light" color="teal">
            {hardware.recommendedHashMb} MB Hash
          </Badge>
        </Group>
      </Group>
    </Paper>
  );
}

function GlobalTablebaseSection() {
  const { t } = useTranslation();
  const [syzygyPath, setSyzygyPath] = useAtom(storedSyzygyPathAtom);
  const [engines, setEngines] = useAtom(enginesAtom);
  const syzygyPathSeparator = platform() === "windows" ? ";" : ":";

  const supportedEnginesCount = useMemo(() => {
    return (engines ?? []).filter((e) => e.type === "local").length;
  }, [engines]);

  const selectDirectory = async () => {
    const selected = await open({
      multiple: true,
      directory: true,
    });
    if (!selected) return;
    const directories = Array.isArray(selected) ? selected : [selected];
    const newPath = directories.join(syzygyPathSeparator);
    setSyzygyPath(newPath);
    setEngines(async (prev) => applySyzygyPathToAllEngines(await prev, newPath));
    notifications.show({
      title: "Syzygy Tablebase",
      message: `Tablebase path applied across ${supportedEnginesCount} local engines.`,
    });
  };

  const clearPath = () => {
    setSyzygyPath("");
    setEngines(async (prev) => applySyzygyPathToAllEngines(await prev, ""));
    notifications.show({
      title: "Syzygy Tablebase",
      message: "Global tablebase path cleared.",
    });
  };

  return (
    <Paper withBorder radius="md" p="sm" mx="md" mb="xs">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="md" wrap="nowrap" style={{ overflow: "hidden" }}>
          <ThemeIcon size="lg" radius="md" variant="light" color={syzygyPath ? "teal" : "blue"}>
            <IconDatabase size="1.2rem" />
          </ThemeIcon>
          <div style={{ overflow: "hidden" }}>
            <Group gap="xs">
              <Text fw={600} size="sm">
                Syzygy Endgame Tablebases
              </Text>
              {syzygyPath ? (
                <Badge size="xs" color="teal" variant="light">
                  Active ({supportedEnginesCount} engines)
                </Badge>
              ) : (
                <Badge size="xs" color="gray" variant="light">
                  Not Configured
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" lineClamp={1} title={syzygyPath || undefined}>
              {syzygyPath
                ? syzygyPath
                : "Select a folder containing .rtbw/.rtbz files to enable 3–7 piece endgame tablebases across all supported engines."}
            </Text>
          </div>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button
            size="xs"
            variant={syzygyPath ? "default" : "filled"}
            leftSection={<IconFolder size="0.9rem" />}
            onClick={selectDirectory}
          >
            {syzygyPath
              ? t("Common.Change", { defaultValue: "Change" })
              : t("Common.SelectFolder", { defaultValue: "Select Tablebase Folder" })}
          </Button>
          {syzygyPath && (
            <Tooltip label={t("Common.Clear", { defaultValue: "Clear tablebase path" })}>
              <ActionIcon variant="subtle" color="red" size="input-xs" onClick={clearPath}>
                <IconTrash size="1rem" />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>
    </Paper>
  );
}

export default function EnginesPage() {
  const { t } = useTranslation();

  const [engines, setEngines] = useAtom(enginesAtom);
  const enginesList = useMemo(() => engines ?? [], [engines]);
  const [opened, setOpened] = useState(false);
  const [search, setSearch] = useState("");
  const { selected } = Route.useSearch();
  const navigate = useNavigate();
  const setSelected = (v: number | null) => {
    navigate({ to: "/engines", search: { selected: v ?? undefined } });
  };

  const selectedEngine = selected !== undefined ? enginesList[selected] : null;
  const filteredEngines = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const indexedEngines = enginesList.map((item, index) => ({ item, index }));

    if (!normalizedSearch) {
      return indexedEngines;
    }

    return indexedEngines.filter(({ item }) => {
      const values = [
        item.name,
        item.id,
        item.type,
        item.type === "local" ? item.path : "",
        item.type === "local" ? (item.version ?? "") : "",
        item.type === "local" && item.elo ? item.elo.toString() : "",
      ];

      return values.some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [enginesList, search]);
  const hasSearch = search.trim().length > 0;
  const hasEngines = enginesList.length > 0;

  return (
    <Stack h="100%">
      <AddEngine opened={opened} setOpened={setOpened} />
      <Group align="baseline" py="sm" pl="lg">
        <Title>{t("Engines.Title")}</Title>
        <OpenFolderButton base="Engines" folder="engines" />
      </Group>
      <HardwareConfigBanner />
      <GlobalTablebaseSection />
      <Group grow flex={1} style={{ overflow: "hidden" }} align="start" px="md" pb="md">
        <Paper withBorder style={{ borderWidth: 2 }} h="100%">
          <Stack gap={0} h="100%" style={{ overflow: "hidden" }}>
            <Group p="xs" gap="xs">
              <Input
                size="sm"
                style={{ flexGrow: 1 }}
                leftSection={<IconSearch size="1rem" />}
                placeholder={t("Common.Search")}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
              />
              <Tooltip label={t("Common.AddNew")}>
                <ActionIcon variant="default" size="lg" onClick={() => setOpened(true)}>
                  <IconPlus size="1rem" />
                </ActionIcon>
              </Tooltip>
            </Group>
            <Divider />
            <ScrollArea flex={1}>
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing={{ base: "md", md: "sm" }} p="xs">
                {filteredEngines.map(({ item, index }) => {
                  const stats =
                    item.type === "local"
                      ? [
                          {
                            label: "ELO",
                            value: item.elo ? item.elo.toString() : "??",
                          },
                        ]
                      : [{ label: "Type", value: "Cloud" }];
                  if (item.type === "local" && item.version) {
                    stats.push({
                      label: t("Common.Version"),
                      value: item.version,
                    });
                  }
                  return (
                    <GenericCard
                      id={index}
                      key={item.id}
                      isSelected={selected === index}
                      setSelected={setSelected}
                      error={undefined}
                      Header={<EngineName engine={item} />}
                      stats={stats}
                    />
                  );
                })}
              </SimpleGrid>
            </ScrollArea>
            {filteredEngines.length === 0 && (
              <Center h="100%">
                <Stack align="center" gap="sm">
                  <ThemeIcon size={64} radius="100%" variant="light" color="gray">
                    <IconCpu size={32} />
                  </ThemeIcon>
                  <Text c="dimmed" fw={500} ta="center">
                    {hasSearch ? t("Common.NoResults") : t("Engines.Empty.NoInstalled")}
                  </Text>
                  {!hasSearch && !hasEngines && (
                    <Text c="dimmed" size="sm" ta="center">
                      {t("Engines.Empty.AddHint")}
                    </Text>
                  )}
                </Stack>
              </Center>
            )}
          </Stack>
        </Paper>
        {!selectedEngine || selected === undefined ? (
          <Paper withBorder style={{ borderWidth: 2 }} p="md" h="100%">
            <Center h="100%">
              <Stack align="center" gap="sm">
                <ThemeIcon size={80} radius="100%" variant="light" color="gray">
                  <IconCpu size={40} />
                </ThemeIcon>
                <Text c="dimmed" fw={500} size="lg">
                  {t("Engines.Settings.NoEngine")}
                </Text>
              </Stack>
            </Center>
          </Paper>
        ) : (
          <Paper withBorder style={{ borderWidth: 2 }} p="md" h="100%">
            {selectedEngine.type === "local" ? (
              <EngineSettings key={selected} selected={selected} setSelected={setSelected} />
            ) : (
              <Stack>
                <Divider variant="dashed" label={t("Common.GeneralSettings")} />

                <TextInput
                  w="50%"
                  label={t("Common.Name")}
                  value={selectedEngine.name}
                  onChange={(e) => {
                    setEngines(async (prev) => {
                      const copy = [...(await prev)];
                      copy[selected].name = e.currentTarget.value;
                      return copy;
                    });
                  }}
                />

                <Divider variant="dashed" label={t("Engines.Settings.AdvancedSettings")} />
                <Stack w="50%">
                  <Text fw="bold">{t("Engines.Settings.NumOfLines")}</Text>
                  <LinesSlider
                    value={
                      Number(
                        getDefaultVariant(selectedEngine).settings.find(
                          (setting) => setting.name === "MultiPV",
                        )?.value,
                      ) || 1
                    }
                    setValue={(v) => {
                      setEngines(async (prev) => {
                        const copy = [...(await prev)];
                        const eng = copy[selected] as RemoteEngine;
                        const variant = getDefaultVariant(eng);
                        const settings = [...variant.settings];
                        const setting = settings.find((s) => s.name === "MultiPV");
                        if (setting) {
                          setting.value = v;
                        } else {
                          settings.push({ name: "MultiPV", value: v });
                        }
                        copy[selected] = withDefaultVariant(eng, { settings });
                        return copy;
                      });
                    }}
                  />
                </Stack>

                <Group justify="right">
                  <Button
                    color="red"
                    onClick={() => {
                      setEngines(async (prev) => {
                        const copy = [...(await prev)];
                        copy.splice(selected, 1);
                        return copy;
                      });
                      setSelected(null);
                    }}
                  >
                    {t("Common.Remove")}
                  </Button>
                </Group>
              </Stack>
            )}
          </Paper>
        )}
      </Group>
    </Stack>
  );
}

function EngineSettings({
  selected,
  setSelected,
}: {
  selected: number;
  setSelected: (v: number | null) => void;
}) {
  const { t } = useTranslation();

  const [engines, setEngines] = useAtom(enginesAtom);
  const [globalSyzygyPath] = useAtom(storedSyzygyPathAtom);
  const engine = engines![selected] as LocalEngine;
  const [selectedVariantId, setSelectedVariantId] = useState(engine.variants[0].id);
  const variant = engine.variants.find((v) => v.id === selectedVariantId) ?? engine.variants[0];

  const { data: options } = useSWRImmutable(["engine-config", engine.path], async ([, path]) => {
    return unwrap(await commands.getEngineConfig(path));
  });

  function setEngine(newEngine: LocalEngine) {
    setEngines(async (prev) => {
      const copy = [...(await prev)];
      copy[selected] = newEngine;
      return copy;
    });
  }

  function setVariant(patch: Partial<EngineVariant>) {
    setEngine({
      ...engine,
      variants: engine.variants.map((v) => (v.id === variant.id ? { ...v, ...patch } : v)),
    });
  }

  useEffect(() => {
    if (options) {
      const settings = [...variant.settings];
      const missing = requiredEngineSettings.filter(
        (field) => !settings.find((setting) => setting.name === field),
      );
      for (const field of requiredEngineSettings) {
        if (!settings.find((setting) => setting.name === field)) {
          const option = options.options.find((option) => option.value.name === field);
          if (option && option.type !== "button") {
            settings.push({
              name: field,
              value: option.value.default as string | number | boolean | null,
            });
          }
        }
      }
      const syzygyOption = options.options.find(
        (option) => option.value.name.toLowerCase() === "syzygypath",
      );
      if (
        syzygyOption &&
        globalSyzygyPath &&
        !settings.find((setting) => setting.name.toLowerCase() === "syzygypath")
      ) {
        settings.push({
          name: syzygyOption.value.name,
          value: globalSyzygyPath,
        });
      }
      if (missing.length > 0 || (syzygyOption && globalSyzygyPath)) {
        setVariant({ settings });
      }
    }
  }, [options, globalSyzygyPath, variant.id]);

  const syzygyOption = options?.options.find(
    (option) => option.value.name.toLowerCase() === "syzygypath",
  );
  const currentEngineSyzygyPath = variant.settings.find(
    (s) => s.name.toLowerCase() === "syzygypath",
  )?.value as string | undefined;

  const completeOptions =
    options?.options
      .filter(
        (option) => option.type !== "button" && option.value.name.toLowerCase() !== "syzygypath",
      )
      .map((option) => {
        const setting = variant.settings.find((setting) => setting.name === option.value.name);
        const defaultValue = "default" in option.value ? option.value.default : null;
        return {
          ...option,
          value: {
            ...option.value,
            value: setting?.value !== undefined ? setting.value : defaultValue,
          },
        };
      }) || [];

  function changeImage() {
    open({
      title: "Select image",
      filters: [{ name: "Image", extensions: ["png", "jpeg", "jpg", "svg", "webp"] }],
    }).then(async (res) => {
      if (typeof res === "string") {
        const enginesDir = await getEnginesDir();
        const imageName = res.split(/[/\\]/).pop() || "engine_image.png";
        const destPath = await resolve(enginesDir, imageName);

        if (res !== destPath) {
          try {
            await copyFile(res, destPath);
          } catch (e) {
            console.error("Failed to copy image to engines directory:", e);
          }
        }

        const targetImagePath = (await exists(destPath)) ? destPath : res;
        setEngine({ ...engine, image: targetImagePath });
      }
    });
  }

  function setSetting(
    name: string,
    value: string | number | boolean | null,
    def: string | number | boolean | null,
  ) {
    const newSettings = [...variant.settings];
    const setting = newSettings.find((setting) => setting.name === name);
    if (setting) {
      setting.value = value;
    } else {
      newSettings.push({ name, value });
    }
    if (value !== def || requiredEngineSettings.includes(name)) {
      setVariant({ settings: newSettings });
    } else {
      setVariant({ settings: newSettings.filter((setting) => setting.name !== name) });
    }
  }

  const [deleteModal, toggleDeleteModal] = useToggle();
  const [jsonModal, toggleJSONModal] = useToggle();

  return (
    <ScrollArea h="100%" offsetScrollbars>
      <Stack>
        <Divider variant="dashed" label={t("Common.GeneralSettings")} />
        <Group grow align="start" wrap="nowrap">
          <Stack>
            <Group wrap="nowrap" w="100%">
              <TextInput
                flex={1}
                label={t("Common.Name")}
                value={engine.name}
                onChange={(e) => setEngine({ ...engine, name: e.currentTarget.value })}
              />
              <TextInput
                label={t("Common.Version")}
                w="5rem"
                value={engine.version}
                placeholder="?"
                onChange={(e) => setEngine({ ...engine, version: e.currentTarget.value })}
              />
            </Group>
            <Group grow>
              <NumberInput
                label="ELO"
                value={engine.elo || undefined}
                min={0}
                placeholder={t("Common.Unknown")}
                onChange={(v) =>
                  setEngine({
                    ...engine,
                    elo: typeof v === "number" ? v : undefined,
                  })
                }
              />
            </Group>
          </Stack>
          <Center>
            {engine.image ? (
              <Paper withBorder style={{ cursor: "pointer" }} onClick={changeImage}>
                <LocalImage
                  src={engine.image}
                  alt={engine.name}
                  mah="10rem"
                  maw="100%"
                  fit="contain"
                />
              </Paper>
            ) : (
              <ActionIcon
                size="10rem"
                variant="subtle"
                styles={{
                  root: {
                    border: "1px dashed",
                  },
                }}
                onClick={changeImage}
              >
                <IconPhotoPlus size="2.5rem" />
              </ActionIcon>
            )}
          </Center>
        </Group>

        <Divider variant="dashed" label={t("Engines.Settings.Variant", "Variant")} />
        <VariantManager
          engine={engine}
          selectedVariantId={variant.id}
          setSelectedVariantId={setSelectedVariantId}
          setEngine={setEngine}
        />

        <Divider variant="dashed" label={t("Engines.Settings.SearchSettings")} />
        <GoModeInput goMode={variant.go} setGoMode={(v) => setVariant({ go: v })} />

        {syzygyOption && (
          <>
            <Divider variant="dashed" label="Endgame Tablebases (Syzygy)" />
            <Paper withBorder radius="md" p="sm">
              <Group justify="space-between" align="center" wrap="nowrap">
                <Group gap="sm" wrap="nowrap" style={{ overflow: "hidden" }}>
                  <ThemeIcon
                    size="md"
                    radius="md"
                    variant="light"
                    color={currentEngineSyzygyPath ? "teal" : "gray"}
                  >
                    <IconDatabase size="1rem" />
                  </ThemeIcon>
                  <div style={{ overflow: "hidden" }}>
                    <Text size="sm" fw={600}>
                      Syzygy Endgame Tablebases
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {globalSyzygyPath
                        ? `Using global path: ${globalSyzygyPath}`
                        : "No global tablebase path set (configure in Settings)"}
                    </Text>
                  </div>
                </Group>
                <Switch
                  size="md"
                  checked={Boolean(currentEngineSyzygyPath)}
                  onChange={(e) => {
                    const enabled = e.currentTarget.checked;
                    setSetting(
                      syzygyOption.value.name,
                      enabled ? globalSyzygyPath || "default" : "",
                      "default" in syzygyOption.value
                        ? (syzygyOption.value.default as string | null)
                        : null,
                    );
                  }}
                />
              </Group>
            </Paper>
          </>
        )}

        <Divider variant="dashed" label={t("Engines.Settings.AdvancedSettings")} />
        <SimpleGrid cols={2}>
          {completeOptions
            .filter((option: { type: string }) => option.type !== "check")
            .map((option: any) => {
              return match(option)
                .with({ type: "spin", value: P.select() }, (v: any) => {
                  return (
                    <NumberInput
                      key={v.name}
                      label={v.name}
                      min={Number(v.min)}
                      max={Number(v.max)}
                      value={Number(v.value)}
                      onChange={(e) => setSetting(v.name, e, Number(v.default))}
                    />
                  );
                })
                .with({ type: "combo", value: P.select() }, (v: any) => {
                  return (
                    <Select
                      key={v.name}
                      label={v.name}
                      data={Array.from(new Set(v.var ?? []))}
                      value={v.value}
                      onChange={(e) => setSetting(v.name, e, v.default)}
                    />
                  );
                })
                .with({ type: "string", value: P.select() }, (v: any) => {
                  if (v.name.toLowerCase().includes("file")) {
                    const file = v.value ? new File([v.value], v.value) : null;
                    return (
                      <FileInput
                        key={v.name}
                        clearable
                        label={v.name}
                        value={file}
                        onClick={async () => {
                          const selected = await open({
                            multiple: false,
                          });
                          if (!selected) return;
                          setSetting(v.name, selected as string, v.default);
                        }}
                        onChange={(e) => {
                          if (e === null) {
                            setSetting(v.name, null, v.default);
                          }
                        }}
                      />
                    );
                  }
                  return (
                    <TextInput
                      key={v.name}
                      label={v.name}
                      value={v.value || ""}
                      onChange={(e) => setSetting(v.name, e.currentTarget.value, v.default)}
                    />
                  );
                })
                .otherwise(() => null);
            })}
        </SimpleGrid>
        <SimpleGrid cols={2}>
          {completeOptions
            .filter((option) => option.type === "check")
            .map((o) => {
              return (
                <Checkbox
                  key={o.value.name}
                  label={o.value.name}
                  checked={!!o.value.value}
                  disabled={o.value.name === "UCI_Chess960"}
                  onChange={(e) => {
                    const defVal = "default" in o.value ? (o.value.default as boolean) : false;
                    setSetting(o.value.name, e.currentTarget.checked, defVal);
                  }}
                />
              );
            })}
        </SimpleGrid>

        <Group justify="end">
          <Button variant="default" onClick={() => toggleJSONModal(true)}>
            {t("Engines.Settings.EditJSON")}
          </Button>
          <Button
            variant="default"
            onClick={() =>
              setVariant({
                settings: options?.options
                  .filter((option) => requiredEngineSettings.includes(option.value.name))
                  .filter((option) => option.type !== "button")
                  .map((option) => ({
                    name: option.value.name,
                    value: option.value.default as string | number | boolean | null,
                  })),
              })
            }
          >
            {t("Engines.Settings.Reset")}
          </Button>
          <Button
            leftSection={<IconCopy size="1rem" />}
            variant="default"
            onClick={() => {
              const duplicatedEngine: LocalEngine = {
                ...engine,
                id: crypto.randomUUID(),
                name: `${engine.name} (Copy)`,
              };
              setEngines(async (prev) => {
                const copy = [...(await prev)];
                copy.splice(selected + 1, 0, duplicatedEngine);
                return copy;
              });
              setSelected(selected + 1);
            }}
          >
            {t("Common.Duplicate")}
          </Button>
          <Button color="red" onClick={() => toggleDeleteModal()}>
            {t("Common.Remove")}
          </Button>
        </Group>
        <ConfirmModal
          title={t("Engines.Remove.Title")}
          description={t("Engines.Remove.Message")}
          opened={deleteModal}
          onClose={toggleDeleteModal}
          onConfirm={() => {
            setEngines(async (prev) => (await prev).filter((e) => e.name !== engine.name));
            setSelected(null);
            toggleDeleteModal();
          }}
          confirmLabel={t("Common.Remove")}
        />
      </Stack>
      <JSONModal
        key={engine.name}
        opened={jsonModal}
        toggleOpened={toggleJSONModal}
        engine={engine}
        setEngine={(v) =>
          setEngines(async (prev) => {
            const copy = [...(await prev)];
            copy[selected] = v;
            return copy;
          })
        }
      />
    </ScrollArea>
  );
}

function JSONModal({
  opened,
  toggleOpened,
  engine,
  setEngine,
}: {
  opened: boolean;
  toggleOpened: () => void;
  engine: Engine;
  setEngine: (v: Engine) => void;
}) {
  const { t } = useTranslation();

  const [value, setValue] = useState(JSON.stringify(engine, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal opened={opened} onClose={toggleOpened} title={t("Engines.Settings.EditJSON")} size="xl">
      <JsonInput
        autosize
        value={value}
        onChange={(e) => {
          setValue(e);
          setError(null);
        }}
        error={error}
      />
      <Space h="md" />
      <Button
        onClick={() => {
          const parseRes = engineSchema.safeParse(JSON.parse(value));
          if (parseRes.success) {
            setEngine(parseRes.data);
            setError(null);
            toggleOpened();
          } else {
            setError("Invalid Configuration"); // TODO: show better error message
          }
        }}
      >
        {t("Common.Save")}
      </Button>
    </Modal>
  );
}

function EngineName({ engine }: { engine: Engine }) {
  const { data: fileExists, isLoading } = useSWRImmutable(
    ["file-exists", engine.type === "local" ? engine.path : null],
    async ([, path]) => {
      if (path === null) return false;
      if (engine.type !== "local") return true;
      const res = await commands.fileExists(path);
      return res.status === "ok";
    },
  );

  const hasError = engine.type === "local" && !isLoading && !fileExists;

  return (
    <Group wrap="nowrap">
      {engine.image ? (
        <LocalImage src={engine.image} alt={engine.name} h="2.5rem" fit="contain" flex={0} />
      ) : engine.type !== "local" ? (
        <IconCloud size="2.5rem" />
      ) : (
        <IconCpu size="2.5rem" />
      )}
      <Stack gap={0}>
        <Text fw="bold" lineClamp={1} c={hasError ? "red" : undefined}>
          {engine.name} {hasError ? "(file missing)" : ""}
        </Text>
        <Text size="xs" c="dimmed" style={{ wordWrap: "break-word" }} lineClamp={1}>
          {engine.type === "local" ? engine.path.split(/\/|\\/).slice(-1)[0] : engine.url}
        </Text>
      </Stack>
    </Group>
  );
}
