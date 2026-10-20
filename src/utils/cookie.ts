import fs from "fs";

/**
 * Validates cookie name and value character sets.
 */
function isValidCookiePair(name: string, value: string): boolean {
  return (
    Boolean(name) &&
    Boolean(value) &&
    /^[\x20-\x3A\x3C-\x7E]+$/.test(name) &&
    /^[\x20-\x3A\x3C-\x7E]+$/.test(value)
  );
}

/**
 * Parses raw cookie string like "NAME=VAL; NAME2=VAL2".
 */
function parseRawCookieString(raw: string): string[] {
  const result: string[] = [];
  const parts = raw.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const name = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (isValidCookiePair(name, value)) {
        result.push(`${name}=${value}`);
      }
    }
  }
  return result;
}

/**
 * Extracts cookies from a cURL command string.
 * Supports bash/POSIX quotes and Windows cmd.exe caret escaping.
 */
function parseCookiesFromCurl(content: string): string[] {
  // Normalize Windows cmd.exe carets
  let normalized = content.replace(/\r\n/g, "\n");
  normalized = normalized.replace(/\s*\^\s*\n\s*/g, " ");
  normalized = normalized.replace(/\^(.)/g, "$1");

  const extracted: string[] = [];

  // Match -H or --header with Cookie header
  const headerRegex = /(?:-H|--header)\s+["']?([Cc]ookie:\s*[^"'\r\n]+)["']?/gi;
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(normalized)) !== null) {
    const cookieHeaderVal = match[1].replace(/^[Cc]ookie:\s*/i, "").trim();
    extracted.push(...parseRawCookieString(cookieHeaderVal));
  }

  // Match -b or --cookie arguments
  const cookieArgRegex = /(?:-b|--cookie)\s+["']?([^"'\r\n]+)["']?/gi;
  while ((match = cookieArgRegex.exec(normalized)) !== null) {
    const argVal = match[1].trim();
    if (argVal && !argVal.endsWith(".txt")) {
      extracted.push(...parseRawCookieString(argVal));
    }
  }

  return extracted;
}

/**
 * Applies `Set-Cookie` response headers to a Cookie request header: a cookie the server
 * (re)sets replaces every existing cookie of that name, deleted ones are dropped.
 */
export function mergeSetCookies(cookieHeader: string, setCookies: string[]): string {
  const updates = new Map<string, string | null>();
  for (const header of setCookies) {
    const pair = header.split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = /;\s*max-age=0\b/i.test(header) || /;\s*expires=Thu, 01 Jan 1970/i.test(header);
    updates.set(name, expired || !value ? null : `${name}=${value}`);
  }
  if (!updates.size) return cookieHeader;

  const kept = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !updates.has(part.slice(0, part.indexOf("=")).trim()));
  for (const pair of updates.values()) if (pair) kept.push(pair);
  return kept.join("; ");
}

/**
 * Parses a Netscape cookies.txt file, a cURL command, or a raw cookie string.
 * Returns a semicolon-separated string of cookies ready for HTTP headers.
 */
export function getCookieHeader(cookiePath: string): string {
  if (!fs.existsSync(cookiePath)) {
    throw new Error(`Cookies file not found at: ${cookiePath}`);
  }

  const cookieData = fs.readFileSync(cookiePath, "utf-8").trim();

  // 1. Check if the file is a cURL command (copied from browser DevTools)
  if (cookieData.includes("curl") || cookieData.includes("-H ") || cookieData.includes("--header ")) {
    const curlCookies = parseCookiesFromCurl(cookieData);
    if (curlCookies.length > 0) {
      return curlCookies.join("; ");
    }
  }

  // 2. Try parsing as Netscape format (tab-separated columns)
  const netscapeCookies = cookieData
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#") && trimmed.split("\t").length >= 7;
    })
    .map((line) => {
      const parts = line.split("\t");
      const name = parts[5]?.trim();
      const value = parts[6]?.trim();

      if (!name || !value || !isValidCookiePair(name, value)) {
        return null;
      }

      return `${name}=${value}`;
    })
    .filter((cookie): cookie is string => cookie !== null);

  if (netscapeCookies.length > 0) {
    return netscapeCookies.join("; ");
  }

  // 3. Fallback: Try parsing as raw semicolon-separated cookie string
  const rawCookies = parseRawCookieString(cookieData);
  if (rawCookies.length > 0) {
    return rawCookies.join("; ");
  }

  throw new Error(`No valid cookies found in ${cookiePath}. Please verify the file format.`);
}

