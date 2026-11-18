import React, { useEffect, useRef, useState } from "react";
import {
  AVATAR_SIZE,
  AVATAR_MAX_SOURCE_BYTES,
  AVATAR_MAX_UPLOAD_BYTES,
} from "../../shared/social";
import { readAPI } from "./api";

/** Longest side kept after decoding: plenty for a 256px crop at 4x zoom, small enough for phones. */
const WORKING_SIDE = 1600;
const MAX_ZOOM = 4;
type Frame = { zoom: number; cx: number; cy: number };

/** Decode with the browser (so HEIC works where Safari can read it) and shrink big phone photos. */
async function decode(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth,
      h = img.naturalHeight;
    if (!w || !h) throw Error();
    if (Math.min(w, h) < 64) throw Error("照片太小了，换一张清楚些的吧");
    const scale = Math.min(1, WORKING_SIDE / Math.max(w, h)),
      out = document.createElement("canvas");
    out.width = Math.round(w * scale);
    out.height = Math.round(h * scale);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, out.width, out.height);
    return out;
  } catch (e) {
    throw (e as Error).message
      ? e
      : Error("这张照片读不出来，换一张 JPEG 或 PNG 试试");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Keep the square crop inside the photo. */
function clamp(src: HTMLCanvasElement, f: Frame): Frame {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, f.zoom)),
    half = Math.min(src.width, src.height) / zoom / 2;
  return {
    zoom,
    cx: Math.min(src.width - half, Math.max(half, f.cx)),
    cy: Math.min(src.height - half, Math.max(half, f.cy)),
  };
}

function draw(target: HTMLCanvasElement, src: HTMLCanvasElement, f: Frame) {
  const ctx = target.getContext("2d")!,
    side = Math.min(src.width, src.height) / f.zoom;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(
    src,
    f.cx - side / 2,
    f.cy - side / 2,
    side,
    side,
    0,
    0,
    target.width,
    target.height,
  );
}

export function AvatarUpload({
  version,
  onSaved,
  onRefresh,
  onCancel,
}: {
  version: number;
  onSaved: (avatarId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onCancel: () => void;
}) {
  const [source, setSource] = useState<HTMLCanvasElement | null>(null),
    [frame, setFrame] = useState<Frame>({ zoom: 1, cx: 0, cy: 0 }),
    [reading, setReading] = useState(false),
    [busy, setBusy] = useState(false),
    [dragOver, setDragOver] = useState(false),
    [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null),
    picker = useRef<HTMLInputElement>(null),
    live = useRef(true),
    selection = useRef(0),
    pointers = useRef(new Map<number, { x: number; y: number }>()),
    gesture = useRef<{
      frame: Frame;
      dist: number;
      x: number;
      y: number;
    } | null>(null),
    pending = useRef<{ blob: Blob; version: number; id: string } | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      selection.current++;
    };
  }, []);
  useEffect(() => {
    if (canvas.current && source) draw(canvas.current, source, frame);
    pending.current = null;
  }, [source, frame]);
  // Wheel zoom needs a non-passive listener so the page does not scroll underneath.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !source) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setFrame((f) =>
        clamp(source, { ...f, zoom: f.zoom * Math.exp(-e.deltaY / 400) }),
      );
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [source]);

  async function choose(file?: File) {
    if (!file || busy) return;
    const generation = ++selection.current;
    setError("");
    pending.current = null;
    if (file.type && !file.type.startsWith("image/")) {
      setError("请选一张照片");
      return;
    }
    if (file.size > AVATAR_MAX_SOURCE_BYTES) {
      setError("照片不能超过 30MB");
      return;
    }
    setReading(true);
    try {
      const src = await decode(file);
      if (!live.current || generation !== selection.current) return;
      setSource(src);
      setFrame({ zoom: 1, cx: src.width / 2, cy: src.height / 2 });
    } catch (e) {
      if (live.current && generation === selection.current)
        setError((e as Error).message);
    } finally {
      if (live.current && generation === selection.current) setReading(false);
    }
  }

  /** Pixels on screen → pixels in the working photo. */
  function ratio() {
    const shown = canvas.current?.getBoundingClientRect().width || AVATAR_SIZE;
    return Math.min(source!.width, source!.height) / frame.zoom / shown;
  }
  function centroid() {
    const ps = [...pointers.current.values()],
      x = ps.reduce((a, p) => a + p.x, 0) / ps.length,
      y = ps.reduce((a, p) => a + p.y, 0) / ps.length,
      dist =
        ps.length > 1 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
    return { x, y, dist };
  }
  function startGesture() {
    gesture.current = pointers.current.size ? { frame, ...centroid() } : null;
  }
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!source || busy) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety; the drag still works inside the canvas */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!source || !gesture.current || !pointers.current.has(e.pointerId))
      return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current,
      now = centroid(),
      zoom =
        g.dist && now.dist ? g.frame.zoom * (now.dist / g.dist) : g.frame.zoom,
      shown = canvas.current!.getBoundingClientRect().width || AVATAR_SIZE,
      k = Math.min(source.width, source.height) / g.frame.zoom / shown;
    setFrame(
      clamp(source, {
        zoom,
        cx: g.frame.cx - (now.x - g.x) * k,
        cy: g.frame.cy - (now.y - g.y) * k,
      }),
    );
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    pointers.current.delete(e.pointerId);
    startGesture();
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!source) return;
    const step = 8 * ratio(),
      moves: Record<string, Partial<Frame>> = {
        ArrowLeft: { cx: frame.cx - step },
        ArrowRight: { cx: frame.cx + step },
        ArrowUp: { cy: frame.cy - step },
        ArrowDown: { cy: frame.cy + step },
        "+": { zoom: frame.zoom * 1.1 },
        "=": { zoom: frame.zoom * 1.1 },
        "-": { zoom: frame.zoom / 1.1 },
      };
    if (!moves[e.key]) return;
    e.preventDefault();
    setFrame(clamp(source, { ...frame, ...moves[e.key] }));
  }

  async function save() {
    if (busy || !source) return;
    setBusy(true);
    setError("");
    try {
      if (!pending.current || pending.current.version !== version) {
        const out = document.createElement("canvas");
        out.width = out.height = AVATAR_SIZE;
        draw(out, source, frame);
        const blob = await new Promise<Blob>((resolve, reject) =>
          out.toBlob(
            (b) => (b ? resolve(b) : reject(Error("照片处理失败，换一张试试"))),
            "image/png",
          ),
        );
        if (!live.current) return;
        if (blob.size > AVATAR_MAX_UPLOAD_BYTES)
          throw Error("这张照片细节太多，放大一点或换一张试试");
        pending.current = { blob, version, id: crypto.randomUUID() };
      }
      const request = pending.current;
      let response: Response;
      try {
        response = await fetch(
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
      } catch {
        // Network drop: keep the same key so a retry cannot apply twice.
        throw Error("网络断了一下，再点一次保存");
      }
      if (!response.ok && response.status < 500) pending.current = null;
      const data = (await readAPI(response)) as { avatarId: string };
      if (!live.current) return;
      pending.current = null;
      await onSaved(data.avatarId);
    } catch (e) {
      if (live.current) {
        setError((e as Error).message);
        if ((e as any).code === "PROFILE_VERSION_CONFLICT") await onRefresh();
      }
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const pick = (
    <input
      ref={picker}
      hidden
      aria-label="选择头像照片"
      type="file"
      accept="image/*"
      disabled={busy}
      onChange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = "";
        void choose(file);
      }}
    />
  );
  return (
    <section
      className={"avatar-upload" + (dragOver ? " drag-over" : "")}
      onDragOver={(e) => {
        if (busy) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void choose(e.dataTransfer.files?.[0]);
      }}
    >
      {pick}
      {!source ? (
        <button
          type="button"
          className="avatar-drop"
          disabled={reading}
          onClick={() => picker.current?.click()}
        >
          <strong>{reading ? "正在读取照片…" : "选一张照片"}</strong>
          <span>也可以把照片拖到这里。之后能拖动、缩放来框选。</span>
        </button>
      ) : (
        <>
          <div className="avatar-crop">
            <canvas
              ref={canvas}
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              tabIndex={0}
              role="img"
              aria-label="头像预览。拖动调整位置，滚轮或双指缩放；也可用方向键和加减号。"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
            />
          </div>
          <label className="avatar-zoom">
            缩放
            <input
              type="range"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              value={frame.zoom}
              disabled={busy}
              onChange={(e) =>
                setFrame(
                  clamp(source, { ...frame, zoom: Number(e.target.value) }),
                )
              }
            />
          </label>
          <p className="muted">拖动照片调整位置。同桌的人都看得到这张头像。</p>
        </>
      )}
      {error && (
        <p role="alert" className="account-error">
          {error}
        </p>
      )}
      <div className="actions">
        {source && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "正在保存…" : "用这张做头像"}
          </button>
        )}
        {source && (
          <button
            type="button"
            className="secondary"
            disabled={busy || reading}
            onClick={() => picker.current?.click()}
          >
            换一张
          </button>
        )}
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={onCancel}
        >
          不换了
        </button>
      </div>
    </section>
  );
}
