import React, {
  Component,
  Suspense,
  lazy,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { MatchView } from "../../shared/types";
import { TableSurface } from "./TableSurface";
import {
  readTableMode,
  viewPreferenceKey,
  writeLocalPreference,
  type TableMode,
} from "./table-preferences";

import type { Table3DHand } from "./table3d/Table3D";

const Table3D = lazy(() => import("./table3d/Table3D"));

let webgl: boolean | undefined;
export function webglAvailable() {
  if (webgl === undefined) {
    try {
      const canvas = document.createElement("canvas");
      webgl = !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
    } catch {
      webgl = false;
    }
  }
  return webgl;
}
function usePortrait() {
  const query = "(orientation: portrait)";
  const [portrait, setPortrait] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const change = () => setPortrait(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return portrait;
}

export function useTableMode(userId: string) {
  const [mode, setMode] = useState<TableMode>(() => readTableMode(userId));
  const [failure, setFailure] = useState<string | null>(null);
  const portrait = usePortrait();
  const supported = webglAvailable();
  const active: TableMode =
    mode === "3d" && supported && !portrait && !failure ? "3d" : "flat";
  return {
    mode,
    active,
    portrait,
    supported,
    failure,
    fail: setFailure,
    choose(next: TableMode) {
      setMode(next);
      setFailure(null);
      writeLocalPreference(viewPreferenceKey(userId), next);
    },
  };
}

class Boundary extends Component<
  { onError: (reason: string) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error instanceof Error ? error.message : String(error));
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The table display: 3D when chosen and possible, otherwise the flat table. */
export function TableView({
  view,
  table,
  hand,
}: {
  view: MatchView;
  table: ReturnType<typeof useTableMode>;
  /** The viewer's hand state, drawn in 3D; the flat table ignores it. */
  hand?: Table3DHand;
}) {
  if (table.active === "flat") return <TableSurface view={view} />;
  return (
    <Boundary onError={(reason) => table.fail(reason)}>
      <Suspense fallback={<TableSurface view={view} />}>
        <Table3D
          view={view}
          hand={hand}
          onFail={(reason) => table.fail(reason)}
        />
      </Suspense>
    </Boundary>
  );
}
