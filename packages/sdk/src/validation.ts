const MAX_U64 = (1n << 64n) - 1n;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

export function isValidSuiAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value);
}

export function assertSuiAddress(value: string, fieldName: string, options: { allowZero?: boolean } = {}): void {
  if (!isValidSuiAddress(value)) {
    throw new Error(`${fieldName} must be a Sui address`);
  }

  if (!options.allowZero && BigInt(value) === 0n) {
    throw new Error(`${fieldName} cannot be 0x0`);
  }
}

export function parseU64(
  value: bigint | number | string,
  fieldName: string,
  options: { allowZero?: boolean } = {},
): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${fieldName} must be an integer amount`);
  }

  if (parsed < 0n || (!options.allowZero && parsed === 0n)) {
    throw new Error(`${fieldName} must be ${options.allowZero ? "0 or greater" : "greater than 0"}`);
  }

  if (parsed > MAX_U64) {
    throw new Error(`${fieldName} exceeds u64 max`);
  }

  return parsed;
}

export function parsePositiveU64(value: bigint | number | string, fieldName: string): bigint {
  return parseU64(value, fieldName);
}

export function assertCoinType(value: string, fieldName = "coinType"): void {
  if (!/^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${fieldName} must be a fully-qualified Sui coin type`);
  }
}

export function assertMoveIdentifier(value: string, fieldName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${fieldName} must be a valid Move identifier`);
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;

  const bytes = parts.map((part) => Number(part));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return false;

  const [a, b] = bytes;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    isPrivateIpv4(normalized)
  );
}

export function assertSafeHttpUrl(value: string, fieldName = "url"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${fieldName} must use http or https`);
  }

  if (url.username || url.password) {
    throw new Error(`${fieldName} must not include credentials`);
  }

  const allowPrivate = process.env.AGENT_PAY_ALLOW_PRIVATE_HTTP === "true" || process.env.NODE_ENV !== "production";
  if (!allowPrivate && isPrivateHostname(url.hostname)) {
    throw new Error(`${fieldName} cannot target localhost or private network addresses`);
  }

  return url;
}

export function normalizeHttpMethod(value?: string): string {
  const method = (value ?? "GET").toUpperCase();
  const allowed = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
  if (!allowed.has(method)) {
    throw new Error(`Unsupported HTTP method: ${method}`);
  }
  return method;
}

export function getHttpTimeoutMs(): number {
  const configured = Number(process.env.AGENT_PAY_HTTP_TIMEOUT_MS ?? DEFAULT_HTTP_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_HTTP_TIMEOUT_MS;
  return Math.min(configured, 60_000);
}
