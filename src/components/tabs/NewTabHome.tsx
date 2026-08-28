import {
  Badge,
  Box,
  Button,
  Card,
  Group,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { useAtom, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useState } from "react";
import {
  activeTabAtom,
  addRecentFileAtom,
  currentTabAtom,
  deckAtomFamily,
  type RecentFile,
  recentFilesAtom,
  tabFamily,
  tabsAtom,
} from "@/state/atoms";
import { getCollectionDir } from "@/utils/collections";
import { parseFenInput, resolveGameLink } from "@/utils/importGame";
import { detectPasteType } from "@/utils/pasteImport";
import type { Tab } from "@/utils/tabs";
import { createTab } from "@/utils/tabs";
import { defaultTree, getGameName } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";
import CreateRepertoireModal from "./CreateRepertoireModal";
import ImportModal from "./ImportModal";
import classes from "./NewTabHome.module.css";
import {
  IconChess,
  IconClock,
  IconFileImport,
  IconPuzzle,
  IconTarget,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useLoaderData, useNavigate } from "@tanstack/react-router";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { getStats } from "@/components/files/opening";
import { parsePGN } from "@/utils/chess";
import { createFile } from "@/utils/files";
import Chessboard from "../icons/Chessboard";
import { FileIcon } from "@/components/files/FileIcon";

dayjs.extend(relativeTime);

function RecentFileDuePositions({ file }: { file: string }) {
  const [deck] = useAtom(
    deckAtomFamily({
      file,
      game: 0,
    }),
  );

  const stats = getStats(deck.positions);

  if (stats.due + stats.unseen === 0) return null;

  return (
    <Badge size="sm" variant="light" color="orange" leftSection={<IconTarget size="0.75rem" />}>
      {stats.due + stats.unseen} due
    </Badge>
  );
}

function RecentFileRow({ file, onOpen }: { file: RecentFile; onOpen: (file: RecentFile) => void }) {
  const displayName = file.name.replace(/\.pgn$/i, "");

  return (
    <UnstyledButton
      onClick={() => onOpen(file)}
      px="sm"
      py={6}
      style={{
        borderRadius: "var(--mantine-radius-sm)",
      }}
      className={classes.recentFileRow}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Box style={{ flexShrink: 0, color: "var(--mantine-color-dimmed)" }}>
            <FileIcon type={file.type} size={20} />
          </Box>
          <Text size="sm" truncate fw={500}>
            {displayName}
          </Text>
          {file.type === "repertoire" && <RecentFileDuePositions file={file.path} />}
        </Group>
        <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
          <Tooltip label={dayjs(file.lastOpened).format("YYYY-MM-DD HH:mm")}>
            <Group gap={4} wrap="nowrap">
              <IconClock size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
              <Text size="xs" c="dimmed">
                {dayjs(file.lastOpened).fromNow()}
              </Text>
            </Group>
          </Tooltip>
        </Group>
      </Group>
    </UnstyledButton>
  );
}

export default function NewTabHome({ id }: { id: string }) {
  const { t } = useTranslation();

  const [openModal, setOpenModal] = useState(false);
  const [openRepertoireModal, setOpenRepertoireModal] = useState(false);
  const [, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const [, setCurrentTab] = useAtom(currentTabAtom);
  const { documentDir } = useLoaderData({ from: "/" });

  const [recentFiles, setRecentFiles] = useAtom(recentFilesAtom);
  const store = useStore();
  const navigate = useNavigate();

  useEffect(() => {
    const checkFiles = async () => {
      const newRecentFiles = await Promise.all(
        recentFiles.map(async (file) => {
          const exists = await commands.fileExists(file.path);
          if (exists.status === "error" || !exists.data) {
            return null;
          }
          return file;
        }),
      );
      const filtered = newRecentFiles.filter((f) => f !== null) as RecentFile[];
      if (filtered.length !== recentFiles.length) {
        setRecentFiles(filtered);
      }
    };
    checkFiles();
  }, []);

  const openRecentFile = useCallback(
    async (file: RecentFile) => {
      const pgn = unwrap(await commands.readGames(file.path, 0, 0));
      const tabId = await createTab({
        tab: {
          name: file.name,
          type: "analysis",
        },
        setTabs,
        setActiveTab,
        pgn: pgn[0] || "",
        gameOrigin: {
          kind: "file",
          gameNumber: 0,
          file: {
            type: "file",
            name: file.name,
            path: file.path,
            numGames: 1,
            metadata: {
              type: file.type,
              tags: [],
              displayName: file.name,
              createdAt: Date.now(),
            },
            lastModified: Math.floor(Date.now() / 1000),
          },
        },
      });
      if (file.type === "repertoire") {
        store.set(tabFamily(tabId), "practice");
      }
      store.set(addRecentFileAtom, {
        name: file.name,
        path: file.path,
        type: file.type,
      });
      navigate({ to: "/" });
    },
    [setTabs, setActiveTab, store, navigate],
  );

  const handlePasteImport = useCallback(async () => {
    let text: string;
    try {
      text = (await readText()) ?? "";
    } catch {
      notifications.show({
        title: t("Import.Paste.Failed", "Paste Failed"),
        message: t("Import.Paste.ClipboardUnavailable", "Could not read the clipboard."),
        color: "red",
      });
      return;
    }

    if (!text.trim()) {
      notifications.show({
        title: t("Import.Paste.Failed", "Paste Failed"),
        message: t("Import.Paste.ClipboardEmpty", "Clipboard is empty."),
        color: "red",
      });
      return;
    }

    const type = detectPasteType(text);

    if (type === "fen") {
      const result = parseFenInput(text);
      if (!result.ok) {
        notifications.show({
          title: t("Import.Paste.Failed", "Paste Failed"),
          message: t("Import.Paste.InvalidFen", "Clipboard text is not a valid FEN."),
          color: "red",
        });
        return;
      }
      setCurrentTab((prev) => {
        const tree = defaultTree(result.parsedFen);
        tree.headers.fen = result.parsedFen;
        sessionStorage.setItem(prev.value, JSON.stringify({ version: 0, state: tree }));
        return {
          ...prev,
          name: t("Home.Card.AnalysisBoard.Title"),
          gameOrigin: { kind: "none" },
          type: "analysis",
        };
      });
      return;
    }

    let pgn = text;
    if (type === "link") {
      const resolved = await resolveGameLink(text.trim());
      if (!resolved) {
        notifications.show({
          title: t("Import.Paste.Failed", "Paste Failed"),
          message: t("Import.Paste.LinkUnrecognized", "Could not fetch the game from that link."),
          color: "red",
        });
        return;
      }
      pgn = resolved;
    }

    let tree: Awaited<ReturnType<typeof parsePGN>>;
    try {
      tree = await parsePGN(pgn);
    } catch {
      // parsePGN already surfaces its own error notification
      return;
    }

    setCurrentTab((prev) => {
      sessionStorage.setItem(prev.value, JSON.stringify({ version: 0, state: tree }));
      return {
        ...prev,
        name: getGameName(tree.headers),
        gameOrigin: { kind: "none" },
        type: "analysis",
      };
    });

    try {
      const dir = await getCollectionDir(documentDir, "imported");
      const white = (tree.headers.white || "White").replace(/[^a-zA-Z0-9_-]/g, "_");
      const black = (tree.headers.black || "Black").replace(/[^a-zA-Z0-9_-]/g, "_");
      const timestamp = dayjs().format("YYYY-MM-DD_HH-mm-ss-SSS");
      await createFile({
        filename: `${white}_vs_${black}_${timestamp}`,
        filetype: "game",
        pgn,
        dir,
      });
    } catch {
      // best-effort save into the collection; the game is already open regardless
    }
  }, [documentDir, setCurrentTab, t]);

  const cards = [
    {
      icon: <IconChess size={60} />,
      title: t("Home.Card.PlayChess.Title"),
      description: t("Home.Card.PlayChess.Desc"),
      label: t("Home.Card.PlayChess.Button"),
      onClick: () => {
        setTabs((prev: Tab[]) => {
          const tab = prev.find((t) => t.value === id);
          if (!tab) return prev;
          tab.name = t("Home.NewGame");
          tab.type = "play";
          return [...prev];
        });
      },
    },
    {
      icon: <Chessboard size={60} />,
      title: t("Home.Card.AnalysisBoard.Title"),
      description: t("Home.Card.AnalysisBoard.Desc"),
      label: t("Home.Card.AnalysisBoard.Button"),
      onClick: () => {
        setTabs((prev: Tab[]) => {
          const tab = prev.find((t) => t.value === id);
          if (!tab) return prev;
          tab.name = t("Home.Card.AnalysisBoard.Title");
          tab.type = "analysis";
          return [...prev];
        });
      },
    },
    {
      icon: <IconTargetArrow size={60} />,
      title: t("Home.Card.NewRepertoire.Title"),
      description: t("Home.Card.NewRepertoire.Desc"),
      label: t("Home.Card.NewRepertoire.Button"),
      onClick: () => {
        setOpenRepertoireModal(true);
      },
    },
    {
      icon: <IconFileImport size={60} />,
      title: t("Home.Card.ImportGame.Title"),
      description: t("Home.Card.ImportGame.Desc"),
      label: t("Home.Card.ImportGame.Button"),
      onClick: () => {
        setOpenModal(true);
      },
      secondaryLabel: t("Home.Card.ImportGame.PasteButton", "Paste"),
      onSecondaryClick: handlePasteImport,
    },
    {
      icon: <IconPuzzle size={60} />,
      title: t("Home.Card.Puzzle.Title"),
      description: t("Home.Card.Puzzle.Desc"),
      label: t("Home.Card.Puzzle.Button"),
      onClick: () => {
        setTabs((prev) => {
          const tab = prev.find((t) => t.value === id);
          if (!tab) return prev;
          tab.name = t("Home.PuzzleTraining");
          tab.type = "puzzles";
          return [...prev];
        });
      },
    },
  ];

  return (
    <>
      <ImportModal
        openModal={openModal}
        setOpenModal={setOpenModal}
        setTabs={setTabs}
        setActiveTab={setActiveTab}
      />
      <CreateRepertoireModal opened={openRepertoireModal} setOpened={setOpenRepertoireModal} />
      <Stack gap="lg" pt="sm">
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }}>
          {cards.map((card) => (
            <Card shadow="sm" p="lg" radius="md" withBorder key={card.title}>
              <Stack align="center" h="100%" justify="space-between">
                {card.icon}

                <Box style={{ textAlign: "center" }}>
                  <Text fw={500}>{card.title}</Text>
                  <Text size="sm" c="dimmed">
                    {card.description}
                  </Text>
                </Box>

                {card.onSecondaryClick ? (
                  <Group grow w="100%" mt="md" gap="xs">
                    <Button variant="light" radius="md" onClick={card.onClick}>
                      {card.label}
                    </Button>
                    <Button variant="light" radius="md" onClick={card.onSecondaryClick}>
                      {card.secondaryLabel}
                    </Button>
                  </Group>
                ) : (
                  <Button variant="light" fullWidth mt="md" radius="md" onClick={card.onClick}>
                    {card.label}
                  </Button>
                )}
              </Stack>
            </Card>
          ))}
        </SimpleGrid>

        <Card shadow="sm" p="md" radius="md" withBorder>
          <Text fw={600} size="lg" mb="xs">
            {t("Home.RecentFiles.Title")}
          </Text>
          {recentFiles.length === 0 ? (
            <Stack align="center" justify="center" h={200} gap="xs">
              <IconClock size={48} style={{ opacity: 0.3 }} />
              <Text c="dimmed">{t("Home.RecentFiles.NoRecentFiles")}</Text>
            </Stack>
          ) : (
            <ScrollArea.Autosize mah={300}>
              <Stack gap={2}>
                {recentFiles.map((file) => (
                  <RecentFileRow key={file.path} file={file} onOpen={openRecentFile} />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Card>
      </Stack>
    </>
  );
}
