import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconClock, IconDownload, IconZoomCheck } from "@tabler/icons-react";
import { resolve } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NormalizedGame } from "@/bindings";
import { commands } from "@/bindings";
import {
  activeTabAtom,
  databaseConversionStateAtom,
  enginesAtom,
  excludedOnlinePlayersAtom,
  referenceDbAtom,
  reportSettingsAtom,
  sessionsAtom,
  tabsAtom,
} from "@/state/atoms";
import { backgroundReportKey, backgroundReportsAtom } from "@/state/backgroundReports";
import {
  downloadAccountGames,
  getAccountDbFilename,
  getLinkedAccounts,
  getPlayerGroups,
  getSessionTotalGames,
} from "@/utils/account";
import { runBackgroundReport } from "@/utils/backgroundReport";
import { getDatabases, query_games } from "@/utils/db";
import { getDatabasesDir } from "@/utils/directories";
import type { LocalEngine } from "@/utils/engines";
import { createTab } from "@/utils/tabs";
import classes from "./NewTabHome.module.css";

const RECENT_ONLINE_GAMES_LIMIT = 10;

interface OnlineGameRow {
  game: NormalizedGame;
  databasePath: string;
  analysisLabel: string | null;
}

function parseGameTimestamp(game: NormalizedGame): number {
  if (!game.date) return 0;
  const [year, month, day] = game.date.split(".").map(Number);
  if (!year || !month || !day) return 0;
  if (game.time) {
    const [hour, minute, second] = game.time.split(":").map(Number);
    return Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0);
  }
  return Date.UTC(year, month - 1, day);
}

function gameName(row: OnlineGameRow): string {
  return `${row.game.white} vs ${row.game.black}`;
}

function OnlineGameRowItem({
  row,
  onOpen,
  onGenerateReport,
  reportRunning,
  reportDisabledReason,
}: {
  row: OnlineGameRow;
  onOpen: (row: OnlineGameRow) => void;
  onGenerateReport: (row: OnlineGameRow) => void;
  reportRunning: boolean;
  reportDisabledReason: string | null;
}) {
  const { t } = useTranslation();
  const { game } = row;

  return (
    <UnstyledButton
      onClick={() => onOpen(row)}
      px="sm"
      py={6}
      style={{
        borderRadius: "var(--mantine-radius-sm)",
      }}
      className={classes.recentFileRow}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" truncate fw={500}>
            {game.white} vs {game.black}
          </Text>
          <Badge size="sm" variant="light" color="gray">
            {game.result}
          </Badge>
        </Group>
        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
          {row.analysisLabel ? (
            <Tooltip label={row.analysisLabel}>
              <Badge
                size="sm"
                variant="light"
                color="teal"
                leftSection={<IconZoomCheck size={12} />}
              >
                {t("Home.RecentOnlineGames.Analyzed")}
              </Badge>
            </Tooltip>
          ) : reportRunning ? (
            <Loader size={16} />
          ) : (
            <Tooltip label={reportDisabledReason ?? t("Home.RecentOnlineGames.GenerateReport")}>
              <ActionIcon
                variant="subtle"
                color="gray"
                disabled={reportDisabledReason !== null}
                onClick={(e) => {
                  e.stopPropagation();
                  onGenerateReport(row);
                }}
              >
                <IconZoomCheck size="1rem" />
              </ActionIcon>
            </Tooltip>
          )}
          <IconClock size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
          <Text size="xs" c="dimmed">
            {game.date ?? ""}
          </Text>
        </Group>
      </Group>
    </UnstyledButton>
  );
}

export default function RecentOnlineGames() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sessions = useAtomValue(sessionsAtom);
  const excludedPlayers = useAtomValue(excludedOnlinePlayersAtom);
  const [tabs, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const [, setConversionState] = useAtom(databaseConversionStateAtom);
  const engines = useAtomValue(enginesAtom);
  const referenceDb = useAtomValue(referenceDbAtom);
  const reportSettings = useAtomValue(reportSettingsAtom);
  const backgroundReports = useAtomValue(backgroundReportsAtom);

  const [games, setGames] = useState<OnlineGameRow[]>([]);
  const [downloading, setDownloading] = useState(false);

  const includedPlayerGroups = getPlayerGroups(sessions).filter(
    (group) => !excludedPlayers.includes(group.name),
  );

  const reportEngine = useMemo<LocalEngine | undefined>(() => {
    const localEngines = (engines ?? []).filter((e): e is LocalEngine => e.type === "local");
    return localEngines.find((e) => e.id === reportSettings.engine) ?? localEngines[0];
  }, [engines, reportSettings.engine]);

  const loadGames = useCallback(async () => {
    const includedSessions = getPlayerGroups(sessions)
      .filter((group) => !excludedPlayers.includes(group.name))
      .flatMap((group) => group.sessions);
    const accounts = getLinkedAccounts(includedSessions);
    if (accounts.length === 0) {
      setGames([]);
      return;
    }

    const dbDir = await getDatabasesDir();
    const rows = (
      await Promise.all(
        accounts.map(async (account) => {
          const dbPath = await resolve(dbDir, getAccountDbFilename(account));
          if (!(await exists(dbPath))) return [];
          try {
            const result = await query_games(dbPath, {
              options: {
                page: 1,
                pageSize: RECENT_ONLINE_GAMES_LIMIT,
                sort: "date",
                direction: "desc",
                skipCount: true,
              },
            });
            return await Promise.all(
              result.data.map(async (game) => {
                let analysisLabel: string | null = null;
                try {
                  const label = await commands.getGameAnalysisLabel(dbPath, game.id);
                  analysisLabel = label.status === "ok" ? label.data : null;
                } catch {
                  analysisLabel = null;
                }
                return { game, databasePath: dbPath, analysisLabel };
              }),
            );
          } catch {
            return [];
          }
        }),
      )
    ).flat();

    rows.sort((a, b) => parseGameTimestamp(b.game) - parseGameTimestamp(a.game));
    setGames(rows.slice(0, RECENT_ONLINE_GAMES_LIMIT));
  }, [sessions, excludedPlayers]);

  useEffect(() => {
    loadGames();
  }, [loadGames]);

  const openGame = useCallback(
    async (row: OnlineGameRow) => {
      await createTab({
        tab: {
          name: `${row.game.white} - ${row.game.black}`,
          type: "analysis",
        },
        setTabs,
        setActiveTab,
        pgn: row.game.moves,
        headers: row.game,
        gameOrigin: {
          kind: "database",
          database: row.databasePath,
          gameId: row.game.id,
        },
      });
      navigate({ to: "/" });
    },
    [setTabs, setActiveTab, navigate],
  );

  const isGameOpenInTab = useCallback(
    (row: OnlineGameRow) =>
      tabs.some(
        (tab) =>
          tab.gameOrigin.kind === "database" &&
          tab.gameOrigin.database === row.databasePath &&
          tab.gameOrigin.gameId === row.game.id,
      ),
    [tabs],
  );

  const reportDisabledReason = useCallback(
    (row: OnlineGameRow): string | null => {
      if (!reportEngine) return t("Home.RecentOnlineGames.GenerateReport.NoEngine");
      if (isGameOpenInTab(row)) return t("Home.RecentOnlineGames.GenerateReport.Open");
      return null;
    },
    [reportEngine, isGameOpenInTab, t],
  );

  const handleGenerateReport = useCallback(
    async (row: OnlineGameRow) => {
      if (!reportEngine || isGameOpenInTab(row)) return;
      notifications.show({
        title: t("Home.RecentOnlineGames.GenerateReport.Started"),
        message: t("Home.RecentOnlineGames.GenerateReport.StartedMessage", {
          game: gameName(row),
        }),
      });
      try {
        await runBackgroundReport({
          databasePath: row.databasePath,
          game: row.game,
          referenceDb,
          engine: reportEngine,
          settings: reportSettings,
        });
      } catch (e) {
        console.error(e);
        notifications.show({
          title: t("Home.RecentOnlineGames.GenerateReport.Failed"),
          message: t("Home.RecentOnlineGames.GenerateReport.FailedMessage", {
            game: gameName(row),
          }),
          color: "red",
        });
      } finally {
        await loadGames();
      }
    },
    [reportEngine, isGameOpenInTab, referenceDb, reportSettings, loadGames, t],
  );

  const handleDownloadAll = useCallback(async () => {
    const accounts = getLinkedAccounts(sessions);
    if (accounts.length === 0 || downloading) return;

    setDownloading(true);
    try {
      const databases = await getDatabases();
      for (const account of accounts) {
        const filename = getAccountDbFilename(account);
        const database = databases.find((db) => db.filename === filename) ?? null;
        const session = sessions.find(
          (s) =>
            (account.type === "lichess" && s.lichess?.username === account.title) ||
            (account.type === "chesscom" && s.chessCom?.username === account.title),
        );
        const totalGames = session ? getSessionTotalGames(session) : 0;
        try {
          await downloadAccountGames({ account, database, totalGames, setConversionState });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      setDownloading(false);
      await loadGames();
    }
  }, [sessions, downloading, setConversionState, loadGames]);

  return (
    <Card shadow="sm" p="md" radius="md" withBorder>
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="lg">
          {t("Home.RecentOnlineGames.Title")}
        </Text>
        {sessions.length > 0 && (
          <Tooltip label={t("Home.Accounts.DownloadGames")}>
            <ActionIcon
              variant="subtle"
              color="gray"
              loading={downloading}
              disabled={downloading}
              onClick={handleDownloadAll}
            >
              <IconDownload size="1rem" />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      {sessions.length === 0 ? (
        <Stack align="center" justify="center" h={200} gap="xs">
          <IconClock size={48} style={{ opacity: 0.3 }} />
          <Text c="dimmed">{t("Home.RecentOnlineGames.NoAccounts")}</Text>
          <Button variant="light" size="xs" onClick={() => navigate({ to: "/accounts" })}>
            {t("Home.RecentOnlineGames.GoToAccounts")}
          </Button>
        </Stack>
      ) : includedPlayerGroups.length === 0 ? (
        <Stack align="center" justify="center" h={200} gap="xs">
          <IconClock size={48} style={{ opacity: 0.3 }} />
          <Text c="dimmed">{t("Home.RecentOnlineGames.AllPlayersExcluded")}</Text>
          <Button variant="light" size="xs" onClick={() => navigate({ to: "/accounts" })}>
            {t("Home.RecentOnlineGames.GoToAccounts")}
          </Button>
        </Stack>
      ) : games.length === 0 ? (
        <Stack align="center" justify="center" h={200} gap="xs">
          <IconClock size={48} style={{ opacity: 0.3 }} />
          <Text c="dimmed">{t("Home.RecentOnlineGames.NoGames")}</Text>
        </Stack>
      ) : (
        <ScrollArea.Autosize mah={300}>
          <Stack gap={2}>
            {games.map((row) => (
              <OnlineGameRowItem
                key={`${row.databasePath}-${row.game.id}`}
                row={row}
                onOpen={openGame}
                onGenerateReport={handleGenerateReport}
                reportRunning={backgroundReports.has(
                  backgroundReportKey(row.databasePath, row.game.id),
                )}
                reportDisabledReason={reportDisabledReason(row)}
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </Card>
  );
}
