import { useSetAtom } from "jotai";
import { createContext, useEffect, useRef } from "react";
import { tabDirtyFamily } from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import type { TreeState } from "@/utils/treeReducer";

export const TreeStateContext = createContext<TreeStore | null>(null);

export function TreeStateProvider({
  id,
  initial,
  children,
}: {
  id?: string;
  initial?: TreeState;
  children: React.ReactNode;
}) {
  const store = useRef(createTreeStore(id, initial)).current;
  const setDirty = useSetAtom(tabDirtyFamily(id ?? ""));

  useEffect(() => {
    // `id` is only set for real board tabs (see `BoardsPage`) — ephemeral
    // previews like `GamePreview` create a store with no id and must not
    // write into the shared `tabDirtyFamily("")` bucket.
    if (!id) return;
    setDirty(store.getState().dirty);
    return store.subscribe((state) => setDirty(state.dirty));
  }, [id, store, setDirty]);

  return <TreeStateContext.Provider value={store}>{children}</TreeStateContext.Provider>;
}
