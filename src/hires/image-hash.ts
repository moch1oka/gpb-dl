import path from "path";
import sharp from "sharp";
import { probeImage } from "../utils/play-api";

/**
 * An image on either side of the match: inside the EPUB, or fetched from Play Books.
 */
export interface ImgInfo {
  id: string; // EPUB: path inside the zip; Play Books: resource id (pg)
  path: string; // zip path, or local file path
  width: number;
  height: number;
  format: string; // sharp format name: jpeg, png, ...
  order: number; // normalised reading order 0..1 (1 = not referenced from the text)
  seq: number; // raw reading-order index (-1 = not referenced)
  phash: bigint;
  dhash: bigint;
  mediaType: string;
  label: string;
  bytes: number;
  hashable: boolean;
}

export interface Match {
  epub: ImgInfo;
  pb: ImgInfo;
  cost: number;
  via: string;
}

const MIN_HASH_SIDE = 24;
const cosTables = new Map<number, number[][]>();

function cosTable(n: number): number[][] {
  let table = cosTables.get(n);
  if (!table) {
    table = Array.from({ length: n }, (_, k) =>
      Array.from({ length: n }, (_, x) => Math.cos((Math.PI * (2 * x + 1) * k) / (2 * n))),
    );
    cosTables.set(n, table);
  }
  return table;
}

async function grayPixels(data: Buffer, width: number, height: number): Promise<Uint8Array> {
  const { data: raw, info } = await sharp(data)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels === 1) return raw;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = raw[i * info.channels];
  return out;
}

/**
 * 64-bit DCT perceptual hash; robust to scaling and recompression.
 */
export async function phash(data: Buffer, hashSize = 8, factor = 4): Promise<bigint> {
  const n = hashSize * factor;
  const px = await grayPixels(data, n, n);
  const c = cosTable(n);
  const rowDct: number[][] = [];
  for (let y = 0; y < n; y++) {
    const row: number[] = [];
    for (let k = 0; k < hashSize; k++) {
      let sum = 0;
      for (let x = 0; x < n; x++) sum += px[y * n + x] * c[k][x];
      row.push(sum);
    }
    rowDct.push(row);
  }
  const low: number[] = [];
  for (let k = 0; k < hashSize; k++) {
    for (let j = 0; j < hashSize; j++) {
      let sum = 0;
      for (let y = 0; y < n; y++) sum += rowDct[y][j] * c[k][y];
      low.push(sum);
    }
  }
  const median = [...low].sort((a, b) => a - b)[Math.floor(low.length / 2)];
  let bits = 0n;
  for (const v of low) bits = (bits << 1n) | (v > median ? 1n : 0n);
  return bits;
}

/**
 * 256-bit difference hash; complements pHash on fine detail.
 */
export async function dhash(data: Buffer, hashSize = 16): Promise<bigint> {
  const w = hashSize + 1;
  const px = await grayPixels(data, w, hashSize);
  let bits = 0n;
  for (let r = 0; r < hashSize; r++) {
    for (let x = 0; x < hashSize; x++) {
      bits = (bits << 1n) | (px[r * w + x + 1] > px[r * w + x] ? 1n : 0n);
    }
  }
  return bits;
}

export function hamming(a: bigint, b: bigint): number {
  let v = a ^ b;
  let count = 0;
  while (v) {
    v &= v - 1n;
    count++;
  }
  return count;
}

/**
 * 0 = identical, ~0.5 = unrelated images.
 */
export function hashCost(a: ImgInfo, b: ImgInfo): number {
  return (0.5 * hamming(a.phash, b.phash)) / 64 + (0.5 * hamming(a.dhash, b.dhash)) / 256;
}

export async function computeHashes(info: ImgInfo, data: Buffer): Promise<void> {
  if (Math.min(info.width, info.height) < MIN_HASH_SIDE) {
    info.hashable = false;
    return;
  }
  try {
    info.phash = await phash(data);
    info.dhash = await dhash(data);
  } catch {
    info.hashable = false;
  }
}

/**
 * Builds an ImgInfo for image bytes: real size and format from the data, perceptual
 * hashes unless `withHashes` is false. `fields` sets the rest (id, path, order...).
 * Returns null when the data isn't a readable image.
 */
export async function hashImage(data: Buffer, fields: Partial<ImgInfo> = {}, withHashes = true): Promise<ImgInfo | null> {
  const probe = await probeImage(data);
  if (!probe) return null;
  const info: ImgInfo = {
    id: "",
    path: "",
    order: 1,
    seq: -1,
    label: "",
    ...fields,
    width: probe.width,
    height: probe.height,
    format: probe.format,
    mediaType: fields.mediaType || probe.mimeType,
    bytes: data.length,
    phash: 0n,
    dhash: 0n,
    hashable: true,
  };
  if (withHashes) await computeHashes(info, data);
  return info;
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function contiguous(sub: string[], sup: string[]): boolean {
  if (!sub.length || sub.length > sup.length) return false;
  for (let i = 0; i + sub.length <= sup.length; i++) {
    if (sub.every((t, j) => sup[i + j] === t)) return true;
  }
  return false;
}

/**
 * Whether the EPUB file name and the Play resource id look like the same source,
 * e.g. `9782803632190_090.jpg` ↔ `i_9782803632190_090`.
 */
export function nameHint(e: ImgInfo, p: ImgInfo): boolean {
  const stem = tokens(path.posix.basename(e.path).replace(/\.[^.]+$/, ""));
  let pid = tokens(p.id.replace(/\.[A-Za-z0-9]{2,4}$/, ""));
  if (pid[0] === "i") pid = pid.slice(1);
  if (!stem.length || !pid.length || stem.join("").length < 3) return false;
  return stem.join("_") === pid.join("_") || contiguous(stem, pid) || contiguous(pid, stem);
}

export function aspectOk(a: ImgInfo, b: ImgInfo, tolerance = 0.05): boolean {
  if (Math.min(a.width, a.height, b.width, b.height) <= 0) return false;
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) <= tolerance * Math.max(ra, rb);
}

/**
 * Pairs EPUB images with Play Books originals: name-hinted pairs first, then by hash
 * distance, then by closeness in reading order. Each Play image is used once, except
 * that duplicate images inside the EPUB may share one source.
 */
export function matchImages(epubImages: ImgInfo[], pbImages: ImgInfo[], maxCost: number): Match[] {
  const candidates: { rank: number; cost: number; dist: number; e: ImgInfo; p: ImgInfo; via: string }[] = [];
  for (const e of epubImages) {
    if (!e.hashable) continue;
    for (const p of pbImages) {
      if (!p.hashable || !aspectOk(e, p)) continue;
      const cost = hashCost(e, p);
      const dist = Math.abs(e.order - p.order);
      if (nameHint(e, p) && cost <= Math.max(maxCost, 0.4)) {
        candidates.push({ rank: 0, cost, dist, e, p, via: "name" });
      } else if (cost <= maxCost) {
        candidates.push({ rank: 1, cost, dist, e, p, via: "hash" });
      }
    }
  }
  const round = (v: number) => Math.round(v * 10000);
  candidates.sort((a, b) => a.rank - b.rank || round(a.cost) - round(b.cost) || a.dist - b.dist);

  const usedE = new Set<string>();
  const usedP = new Set<string>();
  const matches: Match[] = [];
  for (const c of candidates) {
    if (usedE.has(c.e.id) || usedP.has(c.p.id)) continue;
    usedE.add(c.e.id);
    usedP.add(c.p.id);
    matches.push({ epub: c.e, pb: c.p, cost: c.cost, via: c.via });
  }
  for (const c of candidates) {
    if (usedE.has(c.e.id)) continue;
    usedE.add(c.e.id);
    matches.push({ epub: c.e, pb: c.p, cost: c.cost, via: `${c.via}+dup` });
  }
  return matches;
}
