import { useState } from "react";
import { parsePreferences, preferenceKey } from "./table-actions";

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
  return readLocalPreference(viewPreferenceKey(userId)) === "flat" ? "flat" : "3d";
}
export function TablePreferenceSettings({ userId }: { userId: string }) {
  const key = preferenceKey(location.origin + import.meta.env.BASE_URL, userId);
  const [value, setValue] = useState(() =>
    parsePreferences(readLocalPreference(key)),
  );
  const [warning, setWarning] = useState("");
  const [mode, setMode] = useState(() => readTableMode(userId));
  function change(mode: "quick" | "keyboard", enabled: boolean) {
    const next = { ...value, [mode]: enabled };
    setValue(next);
    if (!writeLocalPreference(key, JSON.stringify(next)))
      setWarning("设置无法保存，本页仍可使用");
  }
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={mode === "3d"}
          onChange={(e) => {
            const next = e.target.checked ? "3d" : "flat";
            setMode(next);
            if (!writeLocalPreference(viewPreferenceKey(userId), next))
              setWarning("设置无法保存，本页仍可使用");
          }}
        />
        3D 牌桌（横屏时；设备不支持时自动改用平面）
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.quick}
          onChange={(e) => change("quick", e.target.checked)}
        />
        快速出牌（单击即出牌）
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.keyboard}
          onChange={(e) => change("keyboard", e.target.checked)}
        />
        启用键盘操作
      </label>
      {value.quick && (
        <p>
          快速出牌单击或轻触即提交普通弃牌，已提交无法撤销；立直仍须选牌后确认。
        </p>
      )}
      <p>
        以上偏好按当前环境和身份保存在本浏览器。键盘操作须先聚焦牌桌。自动摸切与不鸣牌只在牌桌手动开启，离桌或失焦后关闭。
      </p>
      {warning && <p role="status">{warning}</p>}
    </>
  );
}
