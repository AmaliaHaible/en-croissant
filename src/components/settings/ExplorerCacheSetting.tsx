import { Button, Group, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { commands } from "@/bindings";
import { formatBytes, formatNumber } from "@/utils/format";
import { unwrap } from "@/utils/unwrap";
import ConfirmModal from "../common/ConfirmModal";

export default function ExplorerCacheSetting() {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const { data, mutate } = useSWR("explorer-cache-stats", async () =>
    unwrap(await commands.explorerCacheStats()),
  );

  const label =
    data && Number(data.entries) > 0
      ? t("Settings.Repertoire.LichessCache.Stats", {
          positions: formatNumber(Number(data.entries)),
          size: formatBytes(data.bytes),
        })
      : t("Settings.Repertoire.LichessCache.Empty");

  return (
    <Group wrap="nowrap" gap="sm">
      <Text fz="sm" c="dimmed" w={180}>
        {label}
      </Text>
      <Button
        variant="default"
        color="red"
        size="xs"
        loading={clearing}
        disabled={!data || Number(data.entries) === 0}
        onClick={() => setConfirmOpen(true)}
      >
        {t("Settings.Repertoire.LichessCache.Clear")}
      </Button>
      <ConfirmModal
        opened={confirmOpen}
        title={t("Settings.Repertoire.LichessCache.Clear")}
        description={t("Settings.Repertoire.LichessCache.ClearConfirm")}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          setConfirmOpen(false);
          setClearing(true);
          try {
            unwrap(await commands.clearExplorerCache());
            await mutate();
          } finally {
            setClearing(false);
          }
        }}
      />
    </Group>
  );
}
