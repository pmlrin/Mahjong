import { useCallback, useEffect, useState } from "react";

/** Set on <html> while the table is fullscreen: the site header steps aside and the table fills the screen. */
export const FULLSCREEN_CLASS = "table-fullscreen";

type Doc = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type Root = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const doc = () => document as Doc;
function nativeAvailable() {
  return !!(doc().fullscreenEnabled ?? doc().webkitFullscreenEnabled);
}
function nativeActive() {
  return !!(doc().fullscreenElement ?? doc().webkitFullscreenElement);
}
async function enterNative() {
  const root = document.documentElement as Root;
  if (root.requestFullscreen)
    await root.requestFullscreen({ navigationUI: "hide" });
  else await root.webkitRequestFullscreen?.();
}
async function exitNative() {
  if (!nativeActive()) return;
  if (document.exitFullscreen) await document.exitFullscreen();
  else await doc().webkitExitFullscreen?.();
}

/**
 * Fullscreen play. Where the browser allows it, the whole page goes
 * fullscreen (so toasts and dialogs still show); where it does not (iPhone
 * Safari), the table still takes the whole viewport and the header steps aside.
 * Leaving the table leaves fullscreen.
 */
export function useFullscreen() {
  const [native] = useState(nativeAvailable);
  const [on, setOn] = useState(() => native && nativeActive());

  useEffect(() => {
    if (!native) return;
    const sync = () => setOn(nativeActive());
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [native]);

  useEffect(() => {
    document.documentElement.classList.toggle(FULLSCREEN_CLASS, on);
    return () => document.documentElement.classList.remove(FULLSCREEN_CLASS);
  }, [on]);

  // Leaving the table (back to the lobby, a new match) leaves fullscreen too.
  useEffect(
    () => () => {
      exitNative().catch(() => {});
    },
    [],
  );

  const toggle = useCallback(async () => {
    if (on) {
      if (nativeActive()) await exitNative().catch(() => setOn(false));
      else setOn(false);
      return;
    }
    if (!native) {
      setOn(true);
      return;
    }
    try {
      // Some embedded webviews never answer the request: give up after a
      // moment rather than leave the button doing nothing.
      await Promise.race([
        enterNative(),
        new Promise((_, reject) => setTimeout(reject, 1200)),
      ]);
    } catch {
      // The browser refused (a policy, an iframe): still fill the viewport.
      if (!nativeActive()) setOn(true);
      return;
    }
    // Phones play sideways: the 3D table needs landscape. Not every browser
    // lets a page lock it, and that is fine.
    if (matchMedia("(pointer: coarse)").matches)
      (screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      })
        .lock?.("landscape")
        .catch(() => {});
  }, [on, native]);

  return { on, toggle };
}
