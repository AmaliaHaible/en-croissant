import { Badge, Box, Text, Tooltip } from "@mantine/core";
import {
  IconChevronRight,
  IconEye,
  IconFolder,
  IconFolderOpen,
  IconTarget,
  IconTrash,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { basename, join, sep } from "@tauri-apps/api/path";
import { rename } from "@tauri-apps/plugin-fs";
import clsx from "clsx";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import Fuse from "fuse.js";
import { useAtom, useSetAtom } from "jotai";
import { useContextMenu } from "mantine-contextmenu";
import Draggable, { type DraggableEvent } from "react-draggable";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  useContext,
} from "react";
import { activeTabAtom, deckAtomFamily, tabsAtom, expandedDirectoriesAtom } from "@/state/atoms";
import { openFile } from "@/utils/files";
import classes from "./DirectoryTree.module.css";
import { getDisplayName, type Directory, type FileMetadata } from "./file";
import { getStats } from "./opening";
import { computeRangeSelection, flattenVisibleEntries } from "./selection";
import { FileIcon } from "./FileIcon";

dayjs.extend(relativeTime);

export type SortBy = "name" | "date";
export type SortDirection = "asc" | "desc";

type DragContextType = {
  draggingPath: string | null;
  setDraggingPath: (path: string | null) => void;
  hoverPath: string | null;
  setHoverPath: (path: string | null) => void;
  registerFolder: (path: string, ref: HTMLDivElement | null) => void;
  checkHover: (clientX: number, clientY: number) => void;
  documentDir: string;
};

export const DragContext = createContext<DragContextType | null>(null);

const DRAG_START_THRESHOLD_PX = 8;
const TREE_BASE_PADDING_PX = 8;
const TREE_INDENT_PX = 16;
type Entry = FileMetadata | Directory;
type ShowContextMenu = ReturnType<typeof useContextMenu>["showContextMenu"];

function flattenFiles(files: Entry[]): Entry[] {
  return files.flatMap((f) => (f.type === "directory" ? flattenFiles(f.children) : [f]));
}

function filterTree(files: Entry[], predicate: (file: FileMetadata) => boolean): Entry[] {
  return files
    .map((file) => {
      if (file.type === "file") {
        return predicate(file) ? file : null;
      }

      const children = filterTree(file.children, predicate);
      return children.length > 0 ? { ...file, children } : null;
    })
    .filter((file): file is Entry => file !== null);
}

function getEventPoint(event: DraggableEvent): { x: number; y: number } | null {
  if ("clientX" in event && "clientY" in event) {
    return { x: event.clientX, y: event.clientY };
  }

  if ("touches" in event && event.touches.length > 0) {
    const touch = event.touches[0];
    return { x: touch.clientX, y: touch.clientY };
  }

  return null;
}

function recursiveSort(
  files: Entry[],
  pruneEmpty = false,
  sortBy: SortBy = "name",
  sortDir: SortDirection = "asc",
): Entry[] {
  const dirMultiplier = sortDir === "asc" ? 1 : -1;

  return files
    .map((f) => {
      if (f.type === "file") return f;
      return {
        ...f,
        children: recursiveSort(f.children, pruneEmpty, sortBy, sortDir),
      };
    })
    .filter((f) => f.type === "file" || !pruneEmpty || f.children.length > 0)
    .sort((a, b) => {
      if (a.type === "directory" && b.type === "file") return -1;
      if (a.type === "file" && b.type === "directory") return 1;
      if (a.type === "directory" && b.type === "directory") {
        return a.name.localeCompare(b.name) * dirMultiplier;
      }
      if (sortBy === "date") {
        return (
          ((a as FileMetadata).metadata.createdAt - (b as FileMetadata).metadata.createdAt) *
          dirMultiplier
        );
      }
      return (
        getDisplayName(a as FileMetadata).localeCompare(getDisplayName(b as FileMetadata)) *
        dirMultiplier
      );
    });
}

export default function DirectoryTree({
  files,
  refreshDirectory,
  selectedFile,
  selectedPaths,
  onSelectionChange,
  onRequestDelete,
  search,
  filter,
  sortBy,
  sortDir,
}: {
  files: Entry[] | undefined;
  refreshDirectory: () => Promise<unknown>;
  selectedFile: Entry | null;
  selectedPaths: Set<string>;
  onSelectionChange: (paths: Set<string>, focused: Entry | null) => void;
  onRequestDelete: (file: Entry) => void;
  search: string;
  filter: string;
  sortBy: SortBy;
  sortDir: SortDirection;
}) {
  const [expandedIds] = useAtom(expandedDirectoriesAtom);
  const flattedFiles = useMemo(() => flattenFiles(files ?? []), [files]);
  const fuse = useMemo(
    () =>
      new Fuse(flattedFiles ?? [], {
        keys: ["name"],
      }),
    [flattedFiles],
  );

  const expandedByDefault = !!(search || filter);

  const filteredFiles = useMemo(() => {
    let next = files ?? [];

    if (search) {
      const searchMatches = new Set(fuse.search(search).map((result) => result.item.path));
      next = filterTree(next, (file) => searchMatches.has(file.path));
    }

    if (filter) {
      next = filterTree(next, (file) => file.metadata.type === filter);
    }

    return recursiveSort(next, expandedByDefault, sortBy, sortDir);
  }, [files, search, filter, fuse, expandedByDefault, sortBy, sortDir]);

  const visibleOrder = useMemo(
    () =>
      flattenVisibleEntries(
        filteredFiles,
        (path) => expandedByDefault || expandedIds.includes(path),
      ),
    [filteredFiles, expandedByDefault, expandedIds],
  );

  const anchorRef = useRef<string | null>(null);

  const handleNodeClick = useCallback(
    (node: Entry, event: React.MouseEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const shift = event.shiftKey;

      if (shift && anchorRef.current) {
        const range = computeRangeSelection(visibleOrder, anchorRef.current, node.path);
        onSelectionChange(new Set(range), node);
        return;
      }

      if (ctrl) {
        const next = new Set(selectedPaths);
        if (next.has(node.path)) {
          next.delete(node.path);
        } else {
          next.add(node.path);
        }
        anchorRef.current = node.path;
        onSelectionChange(next, node);
        return;
      }

      anchorRef.current = node.path;
      onSelectionChange(new Set([node.path]), node);
    },
    [selectedPaths, visibleOrder, onSelectionChange],
  );

  return (
    <Box className={classes.tree}>
      <Tree
        files={filteredFiles}
        refreshDirectory={refreshDirectory}
        depth={0}
        selected={selectedFile}
        selectedPaths={selectedPaths}
        onNodeClick={handleNodeClick}
        onSelectionChange={onSelectionChange}
        onRequestDelete={onRequestDelete}
        expandedByDefault={expandedByDefault}
      />
    </Box>
  );
}

function Tree({
  files,
  depth,
  refreshDirectory,
  selected,
  selectedPaths,
  onNodeClick,
  onSelectionChange,
  onRequestDelete,
  expandedByDefault,
}: {
  files: Entry[];
  depth: number;
  refreshDirectory: () => Promise<unknown>;
  selected: Entry | null;
  selectedPaths: Set<string>;
  onNodeClick: (node: Entry, event: React.MouseEvent) => void;
  onSelectionChange: (paths: Set<string>, focused: Entry | null) => void;
  onRequestDelete: (file: Entry) => void;
  expandedByDefault?: boolean;
}) {
  const [expandedIds, setExpandedIds] = useAtom(expandedDirectoriesAtom);
  const navigate = useNavigate();
  const [, setTabs] = useAtom(tabsAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const { showContextMenu } = useContextMenu();

  const handleOpenFile = useCallback(
    async (record: FileMetadata) => {
      await openFile(record, setTabs, setActiveTab);
      void navigate({ to: "/" });
    },
    [setActiveTab, setTabs, navigate],
  );

  const toggleExpand = (path: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setExpandedIds((prev) => {
      const next = [...prev];
      const index = next.indexOf(path);
      if (index >= 0) {
        next.splice(index, 1);
      } else {
        next.push(path);
      }
      return next;
    });
  };

  return (
    <>
      {files.map((node) => {
        const isExpanded = expandedByDefault || expandedIds.includes(node.path);
        const isSelected = selectedPaths.has(node.path);

        return (
          <DirectoryNode
            key={node.path}
            node={node}
            depth={depth}
            isSelected={isSelected}
            selectedFile={selected}
            selectedPaths={selectedPaths}
            isExpanded={isExpanded}
            setExpandedIds={setExpandedIds}
            toggleExpand={(e) => toggleExpand(node.path, e)}
            onNodeClick={onNodeClick}
            onSelectionChange={onSelectionChange}
            handleOpenFile={handleOpenFile}
            onRequestDelete={onRequestDelete}
            refreshDirectory={refreshDirectory}
            showContextMenu={showContextMenu}
          >
            {node.type === "directory" && isExpanded && node.children.length > 0 && (
              <Tree
                files={node.children}
                refreshDirectory={refreshDirectory}
                depth={depth + 1}
                selected={selected}
                selectedPaths={selectedPaths}
                onNodeClick={onNodeClick}
                onSelectionChange={onSelectionChange}
                onRequestDelete={onRequestDelete}
                expandedByDefault={expandedByDefault}
              />
            )}
          </DirectoryNode>
        );
      })}
    </>
  );
}

function DirectoryNode({
  node,
  depth,
  isSelected,
  selectedFile,
  selectedPaths,
  isExpanded,
  setExpandedIds,
  toggleExpand,
  onNodeClick,
  onSelectionChange,
  handleOpenFile,
  onRequestDelete,
  refreshDirectory,
  showContextMenu,
  children,
}: {
  node: Entry;
  depth: number;
  isSelected: boolean;
  selectedFile: Entry | null;
  selectedPaths: Set<string>;
  isExpanded: boolean;
  setExpandedIds: React.Dispatch<React.SetStateAction<string[]>>;
  toggleExpand: (e: React.MouseEvent) => void;
  onNodeClick: (node: Entry, event: React.MouseEvent) => void;
  onSelectionChange: (paths: Set<string>, focused: Entry | null) => void;
  handleOpenFile: (file: FileMetadata) => Promise<void>;
  onRequestDelete: (file: Entry) => void;
  refreshDirectory: () => Promise<unknown>;
  showContextMenu: ShowContextMenu;
  children?: React.ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const didDragRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dragStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const dragContext = useContext(DragContext);

  const [isDraggingNode, setIsDraggingNode] = useState(false);

  useEffect(() => {
    if (!dragContext || node.type !== "directory") {
      return;
    }

    dragContext.registerFolder(node.path, rowRef.current);

    return () => {
      dragContext.registerFolder(node.path, null);
    };
  }, [node.path, node.type, dragContext]);

  const onDragStart = (e: DraggableEvent) => {
    didDragRef.current = false;
    dragStartPointRef.current = getEventPoint(e);
  };

  const onDragMove = (e: DraggableEvent) => {
    if (!dragContext) return;

    const point = getEventPoint(e);
    if (!point) {
      return;
    }

    if (!didDragRef.current && dragStartPointRef.current) {
      const dx = point.x - dragStartPointRef.current.x;
      const dy = point.y - dragStartPointRef.current.y;
      const distance = Math.hypot(dx, dy);

      if (distance >= DRAG_START_THRESHOLD_PX) {
        didDragRef.current = true;
        dragContext.setDraggingPath(node.path);
        setIsDraggingNode(true);
      }
    }

    if (!didDragRef.current) {
      return;
    }

    if (!isDraggingNode) setIsDraggingNode(true);
    dragContext.checkHover(point.x, point.y);
  };

  const onDragStop = () => {
    if (!dragContext) return;
    const wasDragging = didDragRef.current;
    didDragRef.current = false;
    dragStartPointRef.current = null;
    setIsDraggingNode(false);
    suppressClickRef.current = wasDragging;
    if (wasDragging) {
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }

    dragContext.setDraggingPath(null);
    let targetId = dragContext.hoverPath;
    dragContext.setHoverPath(null);

    if (!wasDragging || !targetId) return;

    const isMultiMove = selectedPaths.has(node.path) && selectedPaths.size > 1;
    const sourcePaths = isMultiMove ? Array.from(selectedPaths) : [node.path];

    const handleDrop = async () => {
      const separator = sep();
      let movedAny = false;

      for (const sourcePath of sourcePaths) {
        if (sourcePath === targetId) continue;
        if (targetId!.startsWith(sourcePath + separator)) continue;

        const sourceBasename = await basename(sourcePath);
        const targetPath = await join(targetId!, sourceBasename);
        if (sourcePath === targetPath) continue;

        try {
          await rename(sourcePath, targetPath);
          if (sourcePath.endsWith(".pgn")) {
            await rename(
              sourcePath.replace(".pgn", ".info"),
              targetPath.replace(".pgn", ".info"),
            ).catch(() => {});
          }
          movedAny = true;

          if (!isMultiMove && selectedFile) {
            if (selectedFile.path === sourcePath) {
              const newName = sourceBasename.endsWith(".pgn")
                ? sourceBasename.slice(0, -4)
                : sourceBasename;
              onSelectionChange(new Set([targetPath]), {
                ...selectedFile,
                path: targetPath,
                name: newName,
              });
            } else if (selectedFile.path.startsWith(sourcePath + separator)) {
              const trailingPath = selectedFile.path.slice(sourcePath.length + separator.length);
              const newPath = await join(targetPath, trailingPath);
              onSelectionChange(new Set([newPath]), { ...selectedFile, path: newPath });
            }
          }
        } catch (err) {
          console.error("Drop failed", err);
        }
      }

      if (!movedAny) return;

      await refreshDirectory();
      setExpandedIds((prev) => (prev.includes(targetId!) ? prev : [...prev, targetId!]));

      if (isMultiMove) {
        onSelectionChange(new Set(), null);
      }
    };

    void handleDrop();
  };

  const isOver =
    dragContext?.hoverPath === node.path &&
    node.type === "directory" &&
    dragContext?.draggingPath !== node.path &&
    !node.path.startsWith(dragContext?.draggingPath + "/") &&
    !node.path.startsWith(dragContext?.draggingPath + "\\");

  return (
    <>
      <Draggable
        position={{ x: 0, y: 0 }}
        onStart={onDragStart}
        onDrag={onDragMove}
        onStop={onDragStop}
        scale={1}
        nodeRef={rowRef as React.RefObject<HTMLElement>}
      >
        <div
          ref={rowRef}
          className={clsx(classes.row, {
            [classes.selected]: isSelected,
            [classes.dragOver]: isOver,
          })}
          style={{
            paddingLeft: TREE_BASE_PADDING_PX + depth * TREE_INDENT_PX,
            opacity: isDraggingNode ? 0.5 : 1,
            zIndex: isDraggingNode ? 50 : undefined,
            position: "relative",
          }}
          onClick={(e) => {
            if (suppressClickRef.current) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }

            if (node.type === "directory" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              toggleExpand(e);
            }
            onNodeClick(node, e);
          }}
          onDoubleClick={() => {
            if (node.type === "file") {
              void handleOpenFile(node);
            }
          }}
          onContextMenu={showContextMenu([
            {
              key: "open-file",
              icon: <IconEye size={16} />,
              disabled: node.type === "directory",
              onClick: () => {
                if (node.type === "directory") return;
                void handleOpenFile(node);
              },
            },
            {
              key: "delete-file",
              icon: <IconTrash size={16} />,
              title: "Delete",
              color: "red",
              onClick: () => {
                onRequestDelete(node);
              },
            },
          ])}
        >
          {depth > 0 && (
            <div
              aria-hidden
              className={classes.guides}
              style={{
                left: TREE_BASE_PADDING_PX + TREE_INDENT_PX / 2,
                width: depth * TREE_INDENT_PX,
              }}
            />
          )}
          <div
            className={classes.iconContainer}
            onClick={(e) => {
              if (node.type === "directory") {
                toggleExpand(e);
              }
            }}
          >
            {node.type === "directory" && (
              <IconChevronRight
                className={clsx(classes.expandIcon, {
                  [classes.expandIconRotated]: isExpanded,
                })}
              />
            )}
          </div>
          {node.type === "directory" ? (
            isExpanded ? (
              <IconFolderOpen className={classes.typeIcon} />
            ) : (
              <IconFolder className={classes.typeIcon} />
            )
          ) : (
            <FileIcon type={node.metadata.type} className={classes.typeIcon} />
          )}
          <span className={classes.label}>
            {node.type === "file" ? getDisplayName(node) : node.name}
          </span>
          {node.type === "file" && (
            <Tooltip label={dayjs(node.metadata.createdAt).format("YYYY-MM-DD HH:mm")}>
              <Text size="xs" c="dimmed" className={classes.date}>
                {dayjs(node.metadata.createdAt).fromNow()}
              </Text>
            </Tooltip>
          )}
          {node.type === "file" && node.metadata.type === "repertoire" && (
            <div className={classes.badge}>
              <DuePositions file={node.path} />
            </div>
          )}
        </div>
      </Draggable>
      {children}
    </>
  );
}

function DuePositions({ file }: { file: string }) {
  const [deck] = useAtom(
    deckAtomFamily({
      file,
      game: 0,
    }),
  );

  const stats = getStats(deck.positions);

  if (stats.due + stats.unseen === 0) return null;

  return (
    <Badge size="xs" variant="light" leftSection={<IconTarget size={10} />}>
      {stats.due + stats.unseen}
    </Badge>
  );
}
