export function ok<T>(data: T, init?: ResponseInit) {
  return json(data, init);
}

export function fail(message: string, status = 400, details?: unknown) {
  return json(
    {
      error: message,
      details,
    },
    { status },
  );
}

export function json<T>(data: T, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}
