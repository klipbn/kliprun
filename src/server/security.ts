/** Defence against accidental credential transport into the browser. */

const SECRET_KEY = /api.?key|password|token|authorization|credential|secret/i;
const INLINE =
  /(bearer\s+)[\w.\-]+|((?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi;

export function scrub<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return scrubString(value) as unknown as T;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY.test(key) ? "[redacted]" : scrub(val);
  }
  return result as T;
}

function scrubString(value: string): string {
  let out = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (secret !== undefined && secret.length >= 8 && SECRET_KEY.test(key)) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out.replace(INLINE, (_match, bearer: string | undefined, prefix: string | undefined) =>
    (bearer ?? prefix ?? "") + "[redacted]",
  );
}
