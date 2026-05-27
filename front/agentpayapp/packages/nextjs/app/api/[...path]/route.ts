const BACKEND_URL = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL;

function resolveBackendUrl(request: Request) {
  if (!BACKEND_URL) {
    return null;
  }

  const incomingUrl = new URL(request.url);
  const backendUrl = new URL(BACKEND_URL);
  backendUrl.pathname = incomingUrl.pathname;
  backendUrl.search = incomingUrl.search;
  return backendUrl;
}

async function proxy(request: Request) {
  const backendUrl = resolveBackendUrl(request);
  if (!backendUrl) {
    return Response.json(
      {
        error: "Backend URL is not configured",
        details: "Set BACKEND_URL or NEXT_PUBLIC_BACKEND_URL for the frontend deployment.",
      },
      { status: 503 },
    );
  }

  const headers = new Headers(request.headers);
  headers.delete("host");

  const response = await fetch(backendUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return proxy(request);
}

export async function POST(request: Request) {
  return proxy(request);
}

export async function DELETE(request: Request) {
  return proxy(request);
}

export async function OPTIONS(request: Request) {
  return proxy(request);
}
