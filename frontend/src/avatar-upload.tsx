import React, { useEffect, useRef, useState } from "react";
import { AVATAR_SIZE, AVATAR_MAX_SOURCE_BYTES } from "../../shared/social";
export function AvatarUpload({
  version,
  onSaved,
  onRefresh,
  onCancel,
}: {
  version: number;
  onSaved: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onCancel: () => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null),
    [zoom, setZoom] = useState(1),
    [x, setX] = useState(50),
    [y, setY] = useState(50),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null),
    url = useRef(""),
    live = useRef(true),
    selection = useRef(0),
    pending = useRef<{ blob: Blob; version: number; id: string } | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      selection.current++;
      if (url.current) URL.revokeObjectURL(url.current);
    };
  }, []);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !image) return;
    const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
    ctx.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.drawImage(
      image,
      ((image.naturalWidth - side) * x) / 100,
      ((image.naturalHeight - side) * y) / 100,
      side,
      side,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
    pending.current = null;
  }, [image, zoom, x, y]);
  async function choose(file?: File) {
    if (!file) return;
    const generation = ++selection.current;
    setError("");
    setImage(null);
    pending.current = null;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("请选择 PNG、JPEG 或 WebP 图片");
      return;
    }
    if (file.size > AVATAR_MAX_SOURCE_BYTES) {
      setError("原图不能超过 5MB");
      return;
    }
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = URL.createObjectURL(file);
    const img = new Image();
    img.src = url.current;
    try {
      await img.decode();
      if (!live.current || generation !== selection.current) return;
      if (
        img.naturalWidth * img.naturalHeight > 16000000 ||
        !img.naturalWidth ||
        !img.naturalHeight
      )
        throw Error("图片太大了，请先缩小一些");
      setZoom(1);
      setX(50);
      setY(50);
      setImage(img);
    } catch (e) {
      if (live.current && generation === selection.current)
        setError(
          (e as Error).message === "The source image cannot be decoded."
            ? "图片无法读取，请换一张照片"
            : (e as Error).message,
        );
    }
  }
  async function save() {
    if (busy || !image || !canvas.current) return;
    setBusy(true);
    setError("");
    try {
      if (!pending.current || pending.current.version !== version) {
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.current!.toBlob(
            (b) => (b ? resolve(b) : reject(Error("图片处理失败，请换一张"))),
            "image/png",
          ),
        );
        if (!live.current) return;
        pending.current = { blob, version, id: crypto.randomUUID() };
      }
      const request = pending.current;
      const response = await fetch(
        import.meta.env.BASE_URL + "api/v2/profile/avatar",
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "Content-Type": "image/png",
            "Idempotency-Key": request.id,
            "X-Profile-Version": String(request.version),
          },
          body: request.blob,
        },
      );
      const data = await response.json();
      if (!live.current) return;
      if (!response.ok) {
        if (response.status < 500) pending.current = null;
        throw Object.assign(Error(data.error?.message ?? "头像保存失败"), {
          code: data.error?.code,
        });
      }
      pending.current = null;
      await onSaved();
    } catch (e) {
      if (live.current) {
        setError((e as Error).message);
        if ((e as any).code === "PROFILE_VERSION_CONFLICT") await onRefresh();
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <section className="avatar-upload">
      <h3>上传照片做头像</h3>
      <p>PNG、JPEG 或 WebP，不超过 5MB。同桌的人都看得到。</p>
      <input
        aria-label="选择头像图片"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={busy}
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          void choose(file);
        }}
      />
      {image && (
        <>
          <canvas
            ref={canvas}
            width={AVATAR_SIZE}
            height={AVATAR_SIZE}
            aria-label="头像预览"
          />
          <div className="avatar-adjustments">
            {[
              ["缩放", zoom, setZoom, 1, 3, 0.05],
              ["左右", x, setX, 0, 100, 1],
              ["上下", y, setY, 0, 100, 1],
            ].map(([label, value, change, min, max, step]) => (
              <label key={String(label)}>
                {String(label)}
                <input
                  aria-label={String(label)}
                  type="range"
                  min={Number(min)}
                  max={Number(max)}
                  step={Number(step)}
                  value={Number(value)}
                  disabled={busy}
                  onChange={(e) =>
                    (change as (v: number) => void)(Number(e.target.value))
                  }
                />
              </label>
            ))}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="account-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!image || busy}
          onClick={() => void save()}
        >
          {busy ? "正在保存…" : "保存头像"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    </section>
  );
}
