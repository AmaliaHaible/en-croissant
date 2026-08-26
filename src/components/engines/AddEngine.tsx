import { Box, Button, Group, Modal, Paper, SimpleGrid, Tabs, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { IconCloud, IconCpu } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { enginesAtom } from "@/state/atoms";
import { createVariant, type LocalEngine, type RemoteEngine } from "@/utils/engines";
import EngineForm from "./EngineForm";

export default function AddEngine({
  opened,
  setOpened,
}: {
  opened: boolean;
  setOpened: (opened: boolean) => void;
}) {
  const { t } = useTranslation();

  const [allEngines, setEngines] = useAtom(enginesAtom);
  const engines = (allEngines ?? []).filter((e): e is LocalEngine => e.type === "local");

  const form = useForm<LocalEngine>({
    initialValues: {
      type: "local",
      id: crypto.randomUUID(),
      version: "",
      name: "",
      path: "",
      image: "",
      elo: undefined,
      variants: [],
    },

    validate: {
      name: (value) => {
        if (!value) return t("Common.RequireName");
        if (engines.find((e) => e.name === value)) return t("Common.NameAlreadyUsed");
      },
      path: (value) => {
        if (!value) return t("Common.RequirePath");
      },
    },
  });

  return (
    <Modal
      opened={opened}
      onClose={() => setOpened(false)}
      title={t("Engines.Add.Title", { defaultValue: "Add Engine" })}
      size="lg"
    >
      <Tabs defaultValue="local">
        <Tabs.List>
          <Tabs.Tab value="local" leftSection={<IconCpu size="1rem" />}>
            {t("Common.Local", { defaultValue: "Local Engine" })}
          </Tabs.Tab>
          <Tabs.Tab value="cloud" leftSection={<IconCloud size="1rem" />}>
            {t("Engines.Add.Cloud", { defaultValue: "Cloud Engine" })}
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="local" pt="md">
          <EngineForm
            submitLabel={t("Common.Add", { defaultValue: "Add Engine" })}
            form={form}
            onSubmit={(values: LocalEngine) => {
              setEngines(async (prev) => [...(await prev), values]);
              setOpened(false);
            }}
          />
        </Tabs.Panel>

        <Tabs.Panel value="cloud" pt="md">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <CloudCard
              engine={{
                id: crypto.randomUUID(),
                name: "ChessDB",
                type: "chessdb",
                url: "https://chessdb.cn",
              }}
            />
            <CloudCard
              engine={{
                id: crypto.randomUUID(),
                name: "Lichess Cloud",
                type: "lichess",
                url: "https://lichess.org",
              }}
            />
          </SimpleGrid>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

function CloudCard({ engine }: { engine: RemoteEngine }) {
  const { t } = useTranslation();
  const [engines, setEngines] = useAtom(enginesAtom);

  return (
    <Paper withBorder radius="md" p="sm" key={engine.name}>
      <Group wrap="nowrap" gap="xs">
        <Box flex={1}>
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            Cloud Engine
          </Text>
          <Text fw="bold" size="sm">
            {engine.name}
          </Text>
          <Text size="xs" c="dimmed" mb="xs">
            {engine.url}
          </Text>
          <Button
            disabled={(engines ?? []).some((e) => e.type === engine.type)}
            fullWidth
            size="xs"
            onClick={() => {
              setEngines(async (prev) => [
                ...(await prev),
                {
                  ...engine,
                  id: crypto.randomUUID(),
                  type: engine.type,
                  loaded: true,
                  variants: [createVariant("Default", [{ name: "MultiPV", value: "1" }])],
                },
              ]);
            }}
          >
            {t("Common.Add", { defaultValue: "Add" })}
          </Button>
        </Box>
      </Group>
    </Paper>
  );
}
