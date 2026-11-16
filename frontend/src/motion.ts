// Whether to leave motion out: follows the system's "reduce motion" setting.
// The table's moves, stamps and sound timing all ask here.
import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function useReducedMotion() {
  const [system, setSystem] = useState(() => matchMedia(QUERY).matches);
  useEffect(() => {
    const list = matchMedia(QUERY);
    const change = () => setSystem(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return system;
}
