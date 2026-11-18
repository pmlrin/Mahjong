export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const r = await fetch(import.meta.env.BASE_URL + "api/v2" + path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(method === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await readAPI(r)) as T;
}
/** Unwrap `{data}` / `{error}`; proxies may answer with HTML (413, 502), so never trust the body to be JSON. */
export async function readAPI(r: Response): Promise<unknown> {
  let d: any = null;
  try {
    d = await r.json();
  } catch {
    /* fall through to a status-based message */
  }
  if (!r.ok || !d)
    throw Object.assign(
      new Error(
        d?.error?.message ??
          (r.status === 413
            ? "文件太大，没能传上去"
            : "暂时无法连接，请稍后再试"),
      ),
      {
        code:
          d?.error?.code ??
          (r.status === 413 ? "PAYLOAD_TOO_LARGE" : undefined),
      },
    );
  return d.data;
}
