// Whether to leave motion out: the system's "reduce motion" or the app's own
// 减少动画 setting. The table's moves, stamps and sound timing all ask here.
import { createContext, useContext, useEffect, useState } from "react";

/** The app's own 减少动画 setting, provided at the root of the page. */
export const AppReducedMotion = createContext(false);

const QUERY = "(prefers-reduced-motion: reduce)";

export function useReducedMotion() {
  const app = useContext(AppReducedMotion);
  const [system, setSystem] = useState(() => matchMedia(QUERY).matches);
  useEffect(() => {
    const list = matchMedia(QUERY);
    const change = () => setSystem(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return app || system;
}
