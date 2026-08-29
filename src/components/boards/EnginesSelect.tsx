import { Select } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { enginesAtom } from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";

/**
 * Picks which engine should be considered selected, auto-selecting the first
 * available one when nothing is selected yet. Must return the exact same
 * `engine` reference (not just an equal-by-id one) when no auto-selection is
 * needed: the async engines list is re-parsed from disk on every refetch, so
 * a same-id-but-new-reference engine here does NOT mean the user picked a
 * different engine, and callers reset engine-specific settings (like variant)
 * whenever this causes them to call `setEngine`.
 */
export function pickAutoEngine<T extends { id: string }>(engine: T | null, engines: T[]): T | null {
  if (engines.length === 0) return engine;
  if (engine === null) return engines[0];
  return engine;
}

export function EnginesSelect({
  engine,
  setEngine,
  filter,
}: {
  engine: LocalEngine | null;
  setEngine: (engine: LocalEngine | null) => void;
  /**
   * Extra predicate narrowing which local engines are offered. Callers that only
   * work with engines in a particular state (e.g. loaded ones) must pass it, so
   * the auto-selection below can never hand them an engine they can't use.
   */
  filter?: (engine: LocalEngine) => boolean;
}) {
  const allEngines = useAtomValue(enginesAtom);
  const rawEngines = (allEngines ?? []).filter(
    (e): e is LocalEngine => e.type === "local" && (!filter || filter(e)),
  );

  const engines = useMemo(() => {
    const seen = new Set<string>();
    return rawEngines.filter((e) => {
      if (!e || !e.id || seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }, [rawEngines]);

  useEffect(() => {
    const next = pickAutoEngine(engine, engines);
    if (next !== engine) {
      setEngine(next);
    }
  }, [engine, engines, setEngine]);

  return (
    <Select
      allowDeselect={false}
      data={engines.map((e) => ({
        label: e.name,
        value: e.id,
      }))}
      value={engine?.id ?? ""}
      onChange={(e) => {
        setEngine(engines.find((engine) => engine.id === e) ?? null);
      }}
    />
  );
}
