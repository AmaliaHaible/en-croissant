import { Select } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { enginesAtom } from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";

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
    if (engines.length === 0) return;
    if (engine === null) {
      setEngine(engines[0]);
    } else {
      const updatedEngine = engines.find((e) => e.id === engine.id);
      if (updatedEngine && updatedEngine !== engine) {
        setEngine(updatedEngine);
      }
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
