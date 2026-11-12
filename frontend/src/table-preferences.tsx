import { preferenceKey } from "./table-actions";

export function readLocalPreference(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeLocalPreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
export type TableMode = "3d" | "flat";
/** Stored beside, not inside, the v4.2 quick/keyboard preferences so their writers keep working. */
export const viewPreferenceKey = (userId: string) =>
  preferenceKey(location.origin + import.meta.env.BASE_URL, userId) + ":view";
export function readTableMode(userId: string): TableMode {
  return readLocalPreference(viewPreferenceKey(userId)) === "flat"
    ? "flat"
    : "3d";
}
