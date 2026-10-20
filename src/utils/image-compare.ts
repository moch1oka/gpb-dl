import sharp from "sharp";
import { logger } from "./logger";
import { hashCost, hashImage } from "../hires/image-hash";

export interface CoverComparisonResult {
  areSimilar: boolean;
  meanDiff: number; // mean absolute luminance difference on a 32x32 thumbnail (0-255)
  cost: number | null; // perceptual hash distance (0 identical, ~0.5 unrelated); null for flat images
  dim1: { width: number; height: number; pixels: number };
  dim2: { width: number; height: number; pixels: number };
}

const THUMB = 32;
const MAX_MEAN_DIFF = 18;
const MAX_HASH_COST = 0.2;
const ASPECT_TOLERANCE = 0.1; // print bleed vs store crop
const FLAT_STDDEV = 4; // below this the picture has no structure for a hash to describe

/**
 * The store cover only replaces the book's own first page when it is this much larger.
 * The page is the publisher's file inside the book (often lossless PNG) and preferred otherwise.
 */
export const STORE_COVER_MIN_GAIN = 1.5;

async function luminance(data: Buffer): Promise<Float32Array> {
  const raw = await sharp(data)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .resize(THUMB, THUMB, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float32Array(THUMB * THUMB);
  for (let i = 0; i < out.length; i++) out[i] = raw.data[i * raw.info.channels];
  return out;
}

function stddev(values: Float32Array): number {
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  return Math.sqrt(sq / values.length);
}

/**
 * Whether two images (any format sharp reads: JPEG, PNG, WebP, ...) show the same cover.
 * Combines the overall luminance difference with a perceptual hash and an aspect check,
 * and reports both sizes so the caller can pick a version. Returns null for unreadable input.
 */
export async function compareCovers(buf1: Buffer, buf2: Buffer): Promise<CoverComparisonResult | null> {
  try {
    const [m1, m2] = await Promise.all([sharp(buf1).metadata(), sharp(buf2).metadata()]);
    if (!m1.width || !m1.height || !m2.width || !m2.height) return null;
    const dim1 = { width: m1.width, height: m1.height, pixels: m1.width * m1.height };
    const dim2 = { width: m2.width, height: m2.height, pixels: m2.width * m2.height };

    const [l1, l2] = await Promise.all([luminance(buf1), luminance(buf2)]);
    let sum = 0;
    for (let i = 0; i < l1.length; i++) sum += Math.abs(l1[i] - l2[i]);
    const meanDiff = sum / l1.length;

    let cost: number | null = null;
    if (stddev(l1) >= FLAT_STDDEV && stddev(l2) >= FLAT_STDDEV) {
      const [i1, i2] = await Promise.all([hashImage(buf1), hashImage(buf2)]);
      if (i1?.hashable && i2?.hashable) cost = hashCost(i1, i2);
    }

    const a1 = dim1.width / dim1.height;
    const a2 = dim2.width / dim2.height;
    const aspectOk = Math.abs(a1 - a2) <= ASPECT_TOLERANCE * Math.max(a1, a2);
    const areSimilar = aspectOk && meanDiff <= MAX_MEAN_DIFF && (cost === null || cost <= MAX_HASH_COST);
    return { areSimilar, meanDiff, cost, dim1, dim2 };
  } catch (err) {
    logger.debug(`Cover comparison skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * For two matching covers, whether the store copy (dim2) should replace the book's page (dim1).
 */
export function storeCoverWins(comparison: CoverComparisonResult): boolean {
  return comparison.dim2.pixels >= comparison.dim1.pixels * STORE_COVER_MIN_GAIN;
}
