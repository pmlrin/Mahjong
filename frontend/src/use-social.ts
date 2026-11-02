import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { SocialSnapshot } from "../../shared/social";
export function useSocial(
  identity: string | null,
  enabled: boolean,
  connected: boolean,
) {
  const [snapshot, setSnapshot] = useState<SocialSnapshot | null>(null),
    [error, setError] = useState("");
  const [snapshotIdentity, setSnapshotIdentity] = useState<string | null>(null);
  const generation = useRef(0),
    busy = useRef(false),
    again = useRef(false);
  const refresh = useCallback(async () => {
    if (!identity || !enabled) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    const current = generation.current;
    try {
      const data = await api<SocialSnapshot>("/social/snapshot");
      if (current !== generation.current) return;
      setSnapshotIdentity(identity);
      setSnapshot((old) =>
        old &&
        old.presenceEpoch === data.presenceEpoch &&
        (old.revision > data.revision ||
          (old.revision === data.revision &&
            old.presenceSeq > data.presenceSeq))
          ? old
          : data,
      );
      setError("");
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        if (again.current) {
          again.current = false;
          void refresh();
        }
      }
    }
  }, [identity, enabled]);
  useEffect(() => {
    generation.current++;
    busy.current = false;
    again.current = false;
    setSnapshot(null);
    setError("");
    if (!identity || !enabled) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30000);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      generation.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [identity, enabled, refresh]);
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);
  return {
    snapshot: snapshotIdentity === identity ? snapshot : null,
    refresh,
    error,
    stale: !connected || !!error,
  };
}
