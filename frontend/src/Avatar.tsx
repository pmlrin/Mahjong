import React from "react";
import {
  AVATARS,
  DEFAULT_AVATAR,
  uploadedAvatarSchema,
} from "../../shared/social";
export function Avatar({ id, label }: { id?: string; label?: string }) {
  const avatar =
    AVATARS.find((a) => a.id === id) ??
    AVATARS.find((a) => a.id === DEFAULT_AVATAR)!;
  return (
    <img
      className="profile-avatar"
      src={
        (import.meta.env?.BASE_URL ?? "/") +
        (uploadedAvatarSchema.safeParse(id).success
          ? "api/v2/avatars/" + id
          : "avatars/" + avatar.id + ".svg")
      }
      alt={
        label ??
        (uploadedAvatarSchema.safeParse(id).success
          ? "自定义头像"
          : avatar.name + "头像")
      }
      onError={(e) => {
        const fallback =
          (import.meta.env?.BASE_URL ?? "/") +
          "avatars/" +
          DEFAULT_AVATAR +
          ".svg";
        if (!e.currentTarget.src.endsWith(fallback))
          e.currentTarget.src = fallback;
      }}
      width="36"
      height="36"
    />
  );
}
