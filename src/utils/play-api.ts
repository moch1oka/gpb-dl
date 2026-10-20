import crypto from "crypto";
import sharp from "sharp";
import { decryptSegment } from "./crypto";
import { fetchWithRetry } from "./async";
import { logger } from "./logger";

export const PLAY_HOST = "https://play.google.com";

/**
 * Query parameters the web reader itself sends when loading a segment.
 * With them Google keeps original SVG artwork (inside ops:switch) instead of
 * a rasterised fallback, but moves the stylesheet out of `style` into the
 * segment's `resource` list, so CSS has to be fetched separately.
 */
export const READER_SEGMENT_PARAMS: Record<string, string> = {
  enc_all: "1",
  hl: "en",
  av: "2",
  cds: "2",
  ef: "4",
  flvers: "1",
  svg: "2",
  vert: "1",
  multi_toc: "1",
  inline: "0",
};

// Don't advertise webp/avif, otherwise Google transcodes the original image.
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/*;q=0.9,*/*;q=0.8";

export interface SegmentResource {
  url?: string;
  mime_type?: string;
}

export interface SegmentPage {
  pid: string;
  src?: string;
  order: number;
  w?: number; // size the reader displays
  h?: number;
  original_w?: number; // size of the stored scan
  original_h?: number;
}

export interface SegmentObject {
  content?: string;
  style?: string;
  resource?: SegmentResource[];
  resource_url?: string[];
  page?: SegmentPage[];
}

export interface ImageProbe {
  format: string; // jpeg, png, gif, webp, svg, ...
  mimeType: string;
  width: number;
  height: number;
}

export interface DownloadedImage extends ImageProbe {
  data: Buffer;
  url: string;
}

/**
 * Returns `url` with the given query parameters set (or removed when the value is null).
 */
export function withParams(url: string, params: Record<string, string | null>): string {
  const parsed = new URL(url, PLAY_HOST);
  for (const [key, value] of Object.entries(params)) {
    if (value === null) parsed.searchParams.delete(key);
    else parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

/**
 * Normalises a resource reference from segment HTML/CSS to an absolute URL.
 * Returns null for data: URIs, fragments and relative paths that aren't Play resources.
 */
export function normalizeResourceUrl(raw: string): string | null {
  const url = raw.trim().replace(/&amp;/g, "&");
  if (!url || url.startsWith("data:") || url.startsWith("#")) return null;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return PLAY_HOST + url;
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

/**
 * Whether a resource URL points at a font rather than an image.
 */
export function isFontUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("output") === "font" || /\.(ttf|otf|woff2?|eot)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Stable id of a Play Books image resource: its `pg` parameter, or a URL hash.
 */
export function resourceId(url: string): string {
  try {
    const pg = new URL(url).searchParams.get("pg");
    if (pg) return pg;
  } catch {
    // fall through to the hash
  }
  return "u_" + crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
}

/**
 * Candidate URLs for the original-resolution image, best first.
 *
 * Dropping w/h makes the server return the image the publisher uploaded. Asking
 * for a w/h larger than the original only upscales it (longest side capped at
 * 2500), so never try to "squeeze" more resolution that way. `zoom` must stay
 * as-is: changing it returns a whole-page thumbnail instead.
 */
export function hiresVariants(url: string): { url: string; encrypted: boolean }[] {
  const encryptedAsIs = new URL(url, PLAY_HOST).searchParams.get("enc_all") === "1";
  const variants = [
    { url: withParams(url, { w: null, h: null, enc_all: "0" }), encrypted: false },
    { url: withParams(url, { w: null, h: null, enc_all: "1" }), encrypted: true },
    { url: withParams(url, { enc_all: "0" }), encrypted: false },
    { url, encrypted: encryptedAsIs },
  ];
  const seen = new Set<string>();
  return variants.filter((v) => !seen.has(v.url) && seen.add(v.url));
}

/**
 * Decrypts an `enc_all=1` binary resource: 16-byte IV + AES-128-CBC ciphertext,
 * with optional PKCS#7 padding.
 */
export function decryptBlob(buffer: Buffer, aesKey: Buffer): Buffer {
  const iv = buffer.subarray(0, 16);
  const body = buffer.subarray(16);
  const encrypted = body.subarray(0, body.length - (body.length % 16));
  const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  let out = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const pad = out[out.length - 1];
  if (pad >= 1 && pad <= 16 && out.subarray(out.length - pad).every((b) => b === pad)) {
    out = out.subarray(0, out.length - pad);
  }
  return out;
}

const FORMAT_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  avif: "image/avif",
  heif: "image/heif",
};

export const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/tiff": "tif",
  "image/avif": "avif",
  "image/heif": "heif",
};

/**
 * Identifies an image from its bytes. Returns null when the data isn't an image.
 */
export async function probeImage(data: Buffer): Promise<ImageProbe | null> {
  try {
    const meta = await sharp(data).metadata();
    if (!meta.format || !meta.width || !meta.height) return null;
    const format = meta.format === "heif" && meta.compression === "av1" ? "avif" : meta.format;
    return {
      format,
      mimeType: FORMAT_MIME[format] || `image/${format}`,
      width: meta.width,
      height: meta.height,
    };
  } catch {
    return null;
  }
}

/**
 * Fetches one Play Books image (page render, scan or publisher image) and returns it
 * decoded, or an error message. Some resources come back in clear even with enc_all=1,
 * so the bytes are only decrypted when they aren't already a readable image.
 */
export async function fetchPlayImage(
  url: string,
  headers: Record<string, string>,
  aesKey?: Buffer,
  retries = 3,
): Promise<DownloadedImage | string> {
  let response: Response;
  try {
    response = await fetchWithRetry(url, { headers: { ...headers, accept: IMAGE_ACCEPT } }, retries);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (!response.ok) return `HTTP ${response.status}`;
  let data: Buffer = Buffer.from(await response.arrayBuffer());
  if (data.length === 0) return "empty response";
  let probe = await probeImage(data);
  if (!probe && aesKey) {
    try {
      data = decryptBlob(data, aesKey);
    } catch (err) {
      return `decryption failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    probe = await probeImage(data);
  }
  if (!probe) return `not an image (${response.headers.get("content-type") || "unknown type"})${aesKey ? "; the decryption key may not match your session" : ""}`;
  return { ...probe, data, url };
}

/**
 * URL of a page image (scan or render) at the given size, encrypted as the reader asks for it.
 * Pass the scan's original size when known: a larger w/h only returns an upscaled copy
 * (long side capped at 2500px), which is still the best a rendered page can get.
 */
export function pageImageUrl(src: string, size?: { width: number; height: number }): string {
  const w = size ? String(size.width) : "10000";
  const h = size ? String(size.height) : "10000";
  return withParams(src, { w, h, enc_all: "1", img: "1" });
}

/**
 * Downloads the original-resolution version of a Play Books image.
 */
export async function downloadOriginalImage(
  url: string,
  headers: Record<string, string>,
  aesKey?: Buffer,
): Promise<DownloadedImage> {
  const declared = (() => {
    const params = new URL(url, PLAY_HOST).searchParams;
    return (parseInt(params.get("w") || "0", 10) || 0) * (parseInt(params.get("h") || "0", 10) || 0);
  })();

  const tryVariant = (variantUrl: string, encrypted: boolean) =>
    fetchPlayImage(variantUrl, headers, encrypted ? aesKey : undefined, 1);

  let lastError = "download failed";
  for (const variant of hiresVariants(url)) {
    const result = await tryVariant(variant.url, variant.encrypted);
    if (typeof result === "string") {
      lastError = result;
      logger.debug(`Image variant failed (${result}): ${variant.url}`);
      continue;
    }
    // Rarely the w/h-less original is smaller than the size the reader declares:
    // fetch the reader-size copy too and keep the larger one.
    const droppedSize = !new URL(variant.url).searchParams.has("w");
    if (declared && droppedSize && result.width * result.height < declared * 0.95) {
      const readerSize = await tryVariant(withParams(url, { enc_all: "0" }), false);
      if (typeof readerSize !== "string" && readerSize.width * readerSize.height > result.width * result.height) {
        return readerSize;
      }
    }
    return result;
  }
  throw new Error(lastError);
}

/**
 * Parses a segment response, which is either plain JSON or base64 AES ciphertext.
 */
export function parseSegmentPayload(text: string, aesKey?: Buffer): SegmentObject {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as SegmentObject;
    } catch {
      // not actually JSON, fall through to decryption
    }
  }
  if (!aesKey) {
    throw new Error("Segment is encrypted but no decryption key is available.");
  }
  let decrypted: string;
  try {
    decrypted = decryptSegment(Buffer.from(trimmed, "base64"), aesKey);
  } catch {
    throw new Error("Decryption failed (BAD_DECRYPT). This usually indicates your cookies are invalid or expired.");
  }
  try {
    return JSON.parse(decrypted) as SegmentObject;
  } catch {
    throw new Error("Failed to parse decrypted segment JSON. This usually indicates your cookies are invalid or expired (key mismatch).");
  }
}

/**
 * Fetches and decrypts one segment the way the web reader does.
 */
export async function fetchSegment(
  link: string,
  headers: Record<string, string>,
  aesKey?: Buffer,
): Promise<SegmentObject> {
  const url = withParams(link.startsWith("http") ? link : PLAY_HOST + link, READER_SEGMENT_PARAMS);
  logger.debug(`Downloading segment from: ${url}`);
  const response = await fetchWithRetry(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return parseSegmentPayload(await response.text(), aesKey);
}

/**
 * Fetches a stylesheet listed in a segment's `resource` list.
 */
export async function fetchSegmentCss(
  url: string,
  headers: Record<string, string>,
  aesKey?: Buffer,
): Promise<string> {
  const response = await fetchWithRetry(withParams(url, { enc_all: "1", hl: "en" }), { headers });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const text = await response.text();
  try {
    const obj = parseSegmentPayload(text, aesKey);
    return obj.style ?? obj.content ?? "";
  } catch {
    return text;
  }
}
