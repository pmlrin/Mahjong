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
  const d = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(d.error?.message ?? "暂时无法连接"), {
      code: d.error?.code,
    });
  return d.data;
}
