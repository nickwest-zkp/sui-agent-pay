import { NextRequest, NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function configuredApiKey() {
  return process.env.AGENT_PAY_API_KEY || process.env.NEXT_PUBLIC_AGENT_PAY_API_KEY || "";
}

function requestApiKey(request: NextRequest) {
  const direct = request.headers.get("x-agent-pay-key");
  if (direct) return direct;

  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  return "";
}

function isLocalHost(host: string) {
  const normalized = host.split(":")[0]?.toLowerCase() ?? "";
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function hasSameOrigin(request: NextRequest) {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const origin = request.headers.get("origin") ?? request.headers.get("referer");

  if (!origin) {
    return isLocalHost(host);
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function middleware(request: NextRequest) {
  const expectedKey = configuredApiKey();
  const providedKey = requestApiKey(request);

  if (expectedKey && providedKey !== expectedKey) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

  if (!SAFE_METHODS.has(request.method) && !hasSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin API request blocked" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
