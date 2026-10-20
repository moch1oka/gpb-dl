import fs from "fs";
import path from "path";
import sharp from "sharp";
import { zipSync, Zippable } from "fflate";
import { logger } from "../utils/logger";
import { safeName } from "../utils/text";
import { probeImage } from "../utils/play-api";
import { ImgInfo, hashImage, matchImages } from "./image-hash";
import { EpubInfo, loadEpub } from "./epub-reader";

export interface ReplaceOptions {
  out?: string;
  minGain: number;
  maxDist: number;
  dryRun: boolean;
  report?: string;
  allowSmaller: boolean;
  overwrite: boolean;
}

interface ReportRow {
  epub: string;
  old: string;
  old_bytes: number;
  new: string;
  new_bytes?: number;
  gain: number | null;
  cost: number | null;
  source: string;
  via: string;
  action: "Replace" | "Keep" | "Skip" | "Unmatched" | "Failed";
  note: string;
}

const REPLACEABLE_FORMATS = new Set(["jpeg", "png", "gif", "webp"]);
const FORMAT_BY_MEDIA: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

const dims = (i: { width: number; height: number }) => `${i.width}x${i.height}`;

/**
 * Loads images fetched by `hires fetch` (a work dir with images.json, its images/ subdir,
 * or a plain folder of images). Also reads work dirs made by the Python EPUB-Box tool.
 */
export async function loadPlayImages(imagesDir: string): Promise<ImgInfo[]> {
  type Entry = { id?: string; file: string; kind?: string; alt?: string; segment?: string };
  let meta: { images?: Entry[] } = {};
  let base = imagesDir;
  if (fs.existsSync(path.join(imagesDir, "images.json"))) {
    meta = JSON.parse(fs.readFileSync(path.join(imagesDir, "images.json"), "utf-8"));
    base = path.join(imagesDir, "images");
  } else if (path.basename(imagesDir) === "images" && fs.existsSync(path.join(imagesDir, "..", "images.json"))) {
    meta = JSON.parse(fs.readFileSync(path.join(imagesDir, "..", "images.json"), "utf-8"));
  } else if (fs.existsSync(path.join(imagesDir, "images"))) {
    base = path.join(imagesDir, "images");
  }
  if (!fs.existsSync(base)) throw new Error(`Images folder not found: ${base}`);

  const entries: Entry[] =
    meta.images ??
    fs
      .readdirSync(base)
      .filter((f) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(f))
      .sort()
      .map((file) => ({ id: file.replace(/\.[^.]+$/, ""), file }));

  const out: ImgInfo[] = [];
  const total = Math.max(entries.length, 1);
  for (const [i, entry] of entries.entries()) {
    // Store covers and cropped page renders from older caches never take part in matching.
    if (entry.id === "__frontcover__" || entry.kind === "page" || entry.file.startsWith("page__")) continue;
    const file = path.join(base, entry.file);
    if (!fs.existsSync(file)) continue;
    const info = await hashImage(fs.readFileSync(file), {
      id: entry.id || entry.file.replace(/\.[^.]+$/, ""),
      path: file,
      order: i / total,
      seq: i,
      label: entry.alt || entry.segment || "",
    });
    if (info) out.push(info);
  }
  return out;
}

/**
 * Re-encodes an image into the format the EPUB used for it, as losslessly as practical.
 */
export async function convertImage(data: Buffer, target: string): Promise<Buffer> {
  const img = sharp(data).keepIccProfile();
  switch (target) {
    case "jpeg":
      return img.flatten({ background: "#ffffff" }).jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
    case "png":
      return img.png({ compressionLevel: 9 }).toBuffer();
    case "gif":
      return img.gif().toBuffer();
    case "webp":
      return img.webp({ quality: 95, effort: 6 }).toBuffer();
    default:
      throw new Error(`Unsupported target format ${target}`);
  }
}

/**
 * Writes `src` with some entries replaced, keeping entry order and `mimetype` first and stored.
 */
function writeEpubZip(book: EpubInfo, replacements: Map<string, Buffer>): Uint8Array {
  const files: Zippable = {};
  files["mimetype"] = [new TextEncoder().encode("application/epub+zip"), { level: 0 }];
  for (const [name, data] of Object.entries(book.entries)) {
    if (name === "mimetype" || name.endsWith("/")) continue;
    const content = replacements.get(name) ?? data;
    // Images are already compressed; deflating them again only costs time.
    const isMedia = /\.(jpe?g|png|gif|webp|mp3|mp4|m4a|woff2?|otf|ttf)$/i.test(name);
    files[name] = [content, { level: isMedia ? 0 : 9 }];
  }
  return zipSync(files);
}

/**
 * Checks the archive layout and that every replaced image decodes at the expected size.
 */
export async function verifyEpub(file: string, expected: Map<string, [number, number]>): Promise<string[]> {
  const problems: string[] = [];
  const raw = fs.readFileSync(file);
  const firstName = raw.subarray(30, 30 + raw.readUInt16LE(26)).toString("latin1");
  if (raw.readUInt32LE(0) !== 0x04034b50 || firstName !== "mimetype" || raw.readUInt16LE(8) !== 0) {
    problems.push("mimetype must be the first, uncompressed entry");
  }
  try {
    const book = await loadEpub(file, false);
    if (Buffer.from(book.entries["mimetype"] || []).toString() !== "application/epub+zip") {
      problems.push("Invalid mimetype contents");
    }
    for (const [name, [w, h]] of expected) {
      const probe = await probeImage(Buffer.from(book.entries[name] || []));
      if (!probe) problems.push(`${name} can't be parsed as an image`);
      else if (probe.width !== w || probe.height !== h) problems.push(`${name} is ${dims(probe)}, expected ${w}x${h}`);
    }
  } catch (err) {
    problems.push(`EPUB re-parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return problems;
}

function pad(s: unknown, n: number): string {
  const str = String(s);
  // CJK and other wide characters take two columns in a terminal.
  const width = [...str].reduce((w, ch) => w + ((ch.codePointAt(0) || 0) > 0x2e7f ? 2 : 1), 0);
  return str + " ".repeat(Math.max(n - width, 0));
}

function printReport(rows: ReportRow[], unused: ImgInfo[]): void {
  const header = `${pad("#", 4)}${pad("EPUB image", 42)}${pad("Old size", 12)}${pad("New size", 12)}${pad("Gain", 8)}${pad("Dist.", 7)}${pad("Source (pg)", 34)}${pad("Action", 10)}Notes`;
  const lines = [header, "─".repeat(header.length + 8)];
  rows.forEach((r, i) => {
    const gain = r.gain !== null ? `${r.gain.toFixed(1)}x` : "";
    const cost = r.cost !== null ? r.cost.toFixed(3) : "";
    const via = r.via && r.via !== "hash" ? ` [${r.via}]` : "";
    lines.push(`${pad(i + 1, 4)}${pad(r.epub.slice(-40), 42)}${pad(r.old, 12)}${pad(r.new, 12)}${pad(gain, 8)}${pad(cost, 7)}${pad(r.source.slice(-32), 34)}${pad(r.action, 10)}${r.note}${via}`);
  });
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1;
  lines.push("─".repeat(header.length + 8));
  lines.push("Summary: " + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "));
  if (unused.length) {
    lines.push(`Play Books has ${unused.length} images not matched to the EPUB: ` + unused.slice(0, 12).map((p) => `${p.id}(${dims(p)})`).join(", ") + (unused.length > 12 ? "…" : ""));
  }
  console.log("\n" + lines.join("\n") + "\n");
}

export function defaultOutputPath(epubPath: string, title: string, imagesDir: string): string {
  let name = "";
  for (const candidate of [path.join(imagesDir, "images.json"), path.join(imagesDir, "..", "images.json")]) {
    try {
      name = JSON.parse(fs.readFileSync(candidate, "utf-8")).title || "";
      if (name) break;
    } catch {
      // no metadata here
    }
  }
  name = safeName(name || title || path.basename(epubPath, path.extname(epubPath)));
  return path.join(path.dirname(path.resolve(epubPath)), "hires", `${name}.epub`);
}

/**
 * Replaces low-resolution EPUB illustrations with matching Play Books originals.
 * Returns the number of images replaced.
 */
export async function replaceImages(epubPath: string, imagesDir: string, options: ReplaceOptions): Promise<number> {
  if (!(options.minGain > 0) || !(options.maxDist >= 0 && options.maxDist <= 0.5)) {
    throw new Error("Invalid matching ranges: --min-gain must be > 0 and --max-dist between 0 and 0.5.");
  }
  logger.info(`Parsing EPUB: ${epubPath}`);
  const book = await loadEpub(epubPath);
  logger.info(`Title: ${book.title || "?"}  |  ${book.images.length} images`);
  const playImages = await loadPlayImages(imagesDir);
  logger.info(`Play Books images: ${playImages.length} (${imagesDir})`);
  if (!playImages.length) throw new Error("No usable Play Books images; run `hires fetch` first.");

  const matches = matchImages(book.images, playImages, options.maxDist);
  const byEpub = new Map(matches.map((m) => [m.epub.id, m]));
  const replacements = new Map<string, Buffer>();
  const expected = new Map<string, [number, number]>();
  const rows: ReportRow[] = [];

  for (const e of [...book.images].sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))) {
    const row: ReportRow = { epub: e.path, old: dims(e), old_bytes: e.bytes, new: "", gain: null, cost: null, source: "", via: "", action: "Keep", note: "" };
    rows.push(row);
    const m = byEpub.get(e.id);
    if (!e.hashable) {
      row.action = "Skip";
      row.note = "SVG / too small / unreadable";
      continue;
    }
    if (!m) {
      row.action = "Unmatched";
      row.note = "No matching Play Books image";
      continue;
    }
    const p = m.pb;
    const gain = e.width * e.height ? (p.width * p.height) / (e.width * e.height) : 0;
    Object.assign(row, { new: dims(p), gain: Math.round(gain * 100) / 100, cost: Math.round(m.cost * 1000) / 1000, source: p.id, via: m.via });
    if (gain < options.minGain && !options.allowSmaller) {
      row.note = gain <= 1 ? "New image is not larger" : `Gain below ${options.minGain.toFixed(2)}x`;
      continue;
    }
    // Keep the file's real format (manifest media-types are occasionally wrong).
    const target = REPLACEABLE_FORMATS.has(e.format) ? e.format : FORMAT_BY_MEDIA[e.mediaType] || e.format;
    let data: Buffer = fs.readFileSync(p.path);
    if (p.format !== target) {
      try {
        data = await convertImage(data, target);
        row.note = `${p.format}→${target}`;
      } catch (err) {
        row.action = "Failed";
        row.note = `Format conversion failed: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }
    }
    replacements.set(e.path, data);
    expected.set(e.path, [p.width, p.height]);
    row.action = "Replace";
    row.new_bytes = data.length;
  }

  const matched = new Set(matches.map((m) => m.pb.id));
  const unused = playImages.filter((p) => !matched.has(p.id));
  printReport(rows, unused);
  if (options.report) {
    fs.writeFileSync(
      options.report,
      JSON.stringify({ epub: epubPath, images_dir: imagesDir, rows, unused_play_images: unused.map((p) => ({ id: p.id, dims: dims(p), file: p.path })) }, null, 2),
      "utf-8",
    );
    logger.info(`Report written to ${options.report}`);
  }

  const count = replacements.size;
  if (options.dryRun) {
    logger.info(`(Dry run) Would replace ${count} images; nothing written.`);
    return count;
  }
  if (!count) {
    logger.info("No images need replacing; nothing written.");
    return 0;
  }

  const out = path.resolve(options.out || defaultOutputPath(epubPath, book.title, imagesDir));
  if (out === path.resolve(epubPath)) throw new Error("Output path must differ from the source EPUB.");
  if (fs.existsSync(out) && !options.overwrite) throw new Error(`Output already exists: ${out} (use --overwrite)`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  // Write to a temp file and only move it into place once it validates.
  const tmp = `${out}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, writeEpubZip(book, replacements));
    const problems = await verifyEpub(tmp, expected);
    if (problems.length) throw new Error(`Output EPUB failed validation: ${problems.join("; ")}`);
    fs.renameSync(tmp, out);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  const before = fs.statSync(epubPath).size / 1e6;
  const after = fs.statSync(out).size / 1e6;
  logger.success(`Replaced ${count} images; validation passed → ${out} (${before.toFixed(1)} MB → ${after.toFixed(1)} MB)`);
  return count;
}

export async function inspectEpub(epubPath: string): Promise<void> {
  const book = await loadEpub(epubPath, false);
  const lines = [
    epubPath,
    `Title: ${book.title || "?"}   OPF: ${book.opfPath}   Volume ID: ${book.volumeId || "unknown"}   Cover: ${book.cover || "-"}`,
    `${pad("#", 4)}${pad("Path", 50)}${pad("Size", 12)}${pad("Format", 7)}${pad("Bytes", 9)}Reading order`,
  ];
  [...book.images]
    .sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))
    .forEach((im, i) => {
      const order = im.seq < 0 ? "Unreferenced" : String(im.seq + 1);
      lines.push(`${pad(i + 1, 4)}${pad(im.path.slice(-48), 50)}${pad(dims(im), 12)}${pad(im.format || "?", 7)}${pad(`${Math.round(im.bytes / 1024)}KB`, 9)}${order}${im.label === "cover" ? "  (cover)" : ""}`);
    });
  const total = book.images.reduce((s, i) => s + i.bytes, 0);
  lines.push(`Total: ${book.images.length} images, ${(total / 1e6).toFixed(1)} MB`);
  console.log(lines.join("\n"));
}
