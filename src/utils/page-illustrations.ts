/**
 * Upgrades the illustrations of a reflowable ("flowing text") EPUB with the book's
 * "Original pages" edition, when Google offers both.
 *
 * The page edition is the print layout rendered from the publisher's PDF. Its colour plates
 * and full-page illustrations usually come from higher-resolution artwork than the images
 * embedded in the flowing-text edition (measured ~2x linear on a light novel), while its
 * text pages are of no use to an EPUB. So: fetch every readable page as a small thumbnail,
 * trim the white margin, match the EPUB images against them by perceptual hash, and only
 * download the matching pages at full size.
 */
import crypto from "crypto";
import sharp from "sharp";
import { GoogleBookManifest, GoogleBookPageManifest } from "../types";
import { ImgInfo, aspectOk, hashCost, hashImage } from "../hires/image-hash";
import { concurrentMap } from "./async";
import { logger } from "./logger";
import { fetchPlayImage, pageImageUrl, probeImage, withParams } from "./play-api";

export interface IllustrationCandidate {
  filename: string; // href inside the EPUB, e.g. "images/x01.png"
  data: Buffer;
}

export interface UpgradedIllustration {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
  pid: string;
  cost: number;
}

const THUMB_WIDTH = 400;
const MAX_COST = 0.2;
const ASPECT_TOLERANCE = 0.08; // print bleed makes the page a little wider/taller than the EPUB crop
const MIN_GAIN = 1.2; // pixel-count ratio worth a replacement
const TRIM_THRESHOLD = 25;

/** Whether the manifest offers a page edition with downloadable pages. */
export function hasPageEdition(manifest: GoogleBookManifest): boolean {
  const modes = manifest.available_mode || [];
  return modes.includes(1) && (manifest.page || []).some((page) => page.src);
}

async function fetchPage(page: GoogleBookPageManifest, width: number | null, headers: Record<string, string>, aesKey: Buffer): Promise<Buffer | null> {
  // A thumbnail is `width` wide (any height); otherwise the largest render the server allows.
  const url = width ? withParams(pageImageUrl(page.src!), { w: String(width) }) : pageImageUrl(page.src!);
  const image = await fetchPlayImage(url, headers, aesKey, 1);
  if (typeof image === "string") {
    logger.debug(`Page ${page.pid}: ${image}`);
    return null;
  }
  return image.data;
}

/**
 * Re-encodes an edited page in its own format without adding visible loss
 * (sharp would otherwise write JPEG at quality 80).
 */
async function encodeLike(img: sharp.Sharp, source: Buffer): Promise<Buffer> {
  const format = (await sharp(source).metadata()).format;
  return format === "jpeg"
    ? img.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer()
    : img.png().toBuffer();
}

/** The page with its white margin (and nothing else) cut away. */
async function trimPage(data: Buffer): Promise<Buffer> {
  try {
    return await encodeLike(sharp(data).trim({ threshold: TRIM_THRESHOLD }), data);
  } catch {
    return data; // trim fails on a uniform page
  }
}

/**
 * Centre-crops `data` to `aspect` (width / height); returns it unchanged when already there.
 */
async function cropToAspect(data: Buffer, aspect: number): Promise<Buffer> {
  const meta = await sharp(data).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (!w || !h || Math.abs(w / h - aspect) < 0.002) return data;
  const box = w / h > aspect
    ? { width: Math.round(h * aspect), height: h }
    : { width: w, height: Math.round(w / aspect) };
  return encodeLike(
    sharp(data).extract({ left: Math.floor((w - box.width) / 2), top: Math.floor((h - box.height) / 2), ...box }),
    data,
  );
}

/** A way of looking at a page (whole, or margin-trimmed), hashed once. */
interface PageVariant {
  data: Buffer;
  info: ImgInfo;
}

/**
 * The whole page and its margin-trimmed content: full-bleed art loses its light edges
 * when trimmed, while illustrations on text pages need the trim.
 */
async function pageVariants(id: string, data: Buffer): Promise<PageVariant[]> {
  const variants: PageVariant[] = [];
  const whole = await hashed(id, data);
  if (whole) variants.push({ data, info: whole });
  const trimmed = await trimPage(data);
  const meta = await sharp(trimmed).metadata();
  if (whole && meta.width === whole.width && meta.height === whole.height) return variants; // nothing trimmed
  const info = await hashed(id, trimmed);
  if (info) variants.push({ data: trimmed, info });
  return variants;
}

// An uncropped variant this far from the EPUB image can't be it, even after cropping the bleed.
const PREFILTER_COST = 0.3;

/**
 * How a page shows the EPUB image best: the variant (whole or trimmed) centre-cropped
 * to the EPUB image's framing with the lowest hash distance. Variants are first compared
 * uncropped with their precomputed hashes, so only plausible pages get cropped and re-hashed.
 */
async function bestFit(epub: ImgInfo, variants: PageVariant[]): Promise<{ cost: number; data: Buffer; info: ImgInfo } | null> {
  const aspect = epub.width / epub.height;
  let best: { cost: number; data: Buffer; info: ImgInfo } | null = null;
  for (const variant of variants) {
    const pageAspect = variant.info.width / variant.info.height;
    if (Math.abs(pageAspect - aspect) > ASPECT_TOLERANCE * aspect) continue;
    if (hashCost(epub, variant.info) > PREFILTER_COST) continue;
    let fit = { data: variant.data, info: variant.info };
    if (!aspectOk(epub, variant.info, 0.002)) {
      const data = await cropToAspect(variant.data, aspect);
      const info = await hashed(variant.info.id, data);
      if (!info) continue;
      fit = { data, info };
    }
    const cost = hashCost(epub, fit.info);
    if (!best || cost < best.cost) best = { cost, ...fit };
  }
  return best;
}

async function hashed(id: string, data: Buffer): Promise<ImgInfo | null> {
  const info = await hashImage(data, { id, path: id });
  return info?.hashable ? info : null;
}

/**
 * Finds, for each candidate image, a page of the print edition showing the same picture at a
 * clearly higher resolution. Returns the replacements keyed by candidate filename.
 */
export async function findPageIllustrations(
  manifest: GoogleBookManifest,
  candidates: IllustrationCandidate[],
  headers: Record<string, string>,
  aesKey: Buffer,
  concurrency = 4,
): Promise<Map<string, UpgradedIllustration>> {
  const result = new Map<string, UpgradedIllustration>();
  const pages = (manifest.page || []).filter((page) => page.src);
  if (!pages.length || !candidates.length) return result;

  const epubInfos = (await Promise.all(candidates.map(async (c) => ({ c, info: await hashed(c.filename, c.data) }))))
    .filter((x): x is { c: IllustrationCandidate; info: ImgInfo } => x.info !== null);
  if (!epubInfos.length) return result;

  logger.info(`Book also has an "Original pages" edition: scanning ${pages.length} pages for sharper illustrations...`);
  let done = 0;
  const thumbs = (
    await concurrentMap(pages, concurrency, async (page) => {
      const data = await fetchPage(page, THUMB_WIDTH, headers, aesKey);
      logger.progress(++done, pages.length, "Scanning pages");
      if (!data) return null;
      return { page, variants: await pageVariants(page.pid, data) };
    })
  ).filter((t): t is { page: GoogleBookPageManifest; variants: PageVariant[] } => t !== null);
  logger.clearProgress();

  // Best page per EPUB image (a page may serve several images, e.g. the cover and a plate).
  const wanted = new Map<string, { page: GoogleBookPageManifest; images: { c: IllustrationCandidate; info: ImgInfo }[] }>();
  for (const e of epubInfos) {
    let best: { page: GoogleBookPageManifest; cost: number } | null = null;
    for (const t of thumbs) {
      const fit = await bestFit(e.info, t.variants);
      if (fit && fit.cost <= MAX_COST && (!best || fit.cost < best.cost)) best = { page: t.page, cost: fit.cost };
    }
    if (!best) continue;
    const entry = wanted.get(best.page.pid) || { page: best.page, images: [] };
    entry.images.push(e);
    wanted.set(best.page.pid, entry);
  }

  await concurrentMap([...wanted.values()], concurrency, async ({ page, images }) => {
    const full = await fetchPage(page, null, headers, aesKey);
    if (!full) return;
    const variants = await pageVariants(page.pid, full);
    for (const e of images) {
      const fit = await bestFit(e.info, variants);
      if (!fit || fit.cost > MAX_COST) {
        logger.debug(`${e.c.filename}: page ${page.pid} no longer matches at full size${fit ? ` (cost ${fit.cost.toFixed(3)})` : ""}`);
        continue;
      }
      const { info, cost } = fit;
      const gain = (info.width * info.height) / (e.info.width * e.info.height);
      if (gain < MIN_GAIN) {
        logger.debug(`${e.c.filename}: page ${page.pid} is not larger (${info.width}x${info.height} vs ${e.info.width}x${e.info.height})`);
        continue;
      }
      const probe = (await probeImage(fit.data))!;
      result.set(e.c.filename, { data: fit.data, mimeType: probe.mimeType, width: info.width, height: info.height, pid: page.pid, cost });
      logger.debug(`${e.c.filename} ${e.info.width}x${e.info.height} -> page ${page.pid} ${info.width}x${info.height} (cost ${cost.toFixed(3)})`);
    }
  });
  return result;
}

/** A content hash used to keep replacement files unique inside the EPUB. */
export function shortHash(data: Buffer): string {
  return crypto.createHash("sha1").update(data).digest("hex").slice(0, 8);
}
