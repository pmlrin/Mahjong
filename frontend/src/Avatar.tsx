import React from "react";
import { AVATARS, DEFAULT_AVATAR } from "../../shared/social";
export function Avatar({ id, label }: { id?: string; label?: string }) {
  const avatar =
    AVATARS.find((a) => a.id === id) ??
    AVATARS.find((a) => a.id === DEFAULT_AVATAR)!;
  return (
    <img
      className="profile-avatar"
      src={(import.meta.env?.BASE_URL ?? "/") + "avatars/" + avatar.id + ".svg"}
      alt={label ?? avatar.name + "头像"}
      width="36"
      height="36"
    />
  );
}
