import fs from "fs";
import path from "path";
import { BaseDownloader, DownloaderOptions } from "../downloader/base";
import { logger, withSpinner } from "../utils/logger";
import { concurrentMap } from "../utils/async";
import { unescapeHtml } from "../utils/text";
import {
  MIME_EXTENSION,
  SegmentObject,
  downloadOriginalImage,
  fetchSegment,
  fetchSegmentCss,
  normalizeResourceUrl,
  probeImage,
  resourceId,
} from "../utils/play-api";
import { collectResourceUrls } from "../utils/xhtml";

export interface FetchedImage {
  id: string;
  file: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  segment: string;
  seg_index: number;
  src_url: string;
  fetched_url: string;
  cached: boolean;
}

/** images.json, the same layout the Python EPUB-Box tool writes, so work dirs are interchangeable. */
export interface FetchedImages {
  volume_id: string;
  title?: string;
  authors?: unknown;
  preview?: string;
  segments: { label: string; order: number; title?: string; images: string[] }[];
  images: FetchedImage[];
}

export function safeStem(s: string, limit = 150): string {
  let name = s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "").slice(0, limit) || "x";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
  return name;
}

function looksLikeImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.searchParams.get("img") === "1" ||
      parsed.pathname.includes("/publisher/content") ||
      /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Downloads the original-resolution illustrations of a Play Books volume into
 * `<workDir>/images`, caching segments and images so an interrupted run can resume.
 */
export class HiresFetcher extends BaseDownloader {
  readonly workDir: string;
  private limit: number;

  constructor(bookId: string, options: DownloaderOptions & { workDir: string; limit?: number }) {
    super(bookId, { ...options, outputDir: options.workDir, tempDir: path.join(options.workDir, ".temp") });
    this.workDir = options.workDir;
    this.limit = options.limit || 0;
    this.headers.referer = `https://play.google.com/books/reader?id=${bookId}&hl=en`;
  }

  private async cachedSegment(link: string, cacheFile: string, aesKey: Buffer): Promise<SegmentObject> {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as SegmentObject;
      if (cached && typeof cached === "object") return cached;
    } catch {
      // not cached yet
    }
    const obj = await fetchSegment(link, this.headers, aesKey);
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf-8");
    fs.renameSync(tmp, cacheFile);
    return obj;
  }

  async run(): Promise<void> {
    await this.fetchImages();
  }

  async fetchImages(): Promise<FetchedImages> {
    if (!/^[A-Za-z0-9_-]{12}$/.test(this.bookId)) {
      throw new Error("Invalid Google volume ID; expected 12 letters, digits, underscores or hyphens.");
    }
    const segDir = path.join(this.workDir, "segments");
    const imgDir = path.join(this.workDir, "images");
    fs.mkdirSync(segDir, { recursive: true });
    fs.mkdirSync(imgDir, { recursive: true });

    const { html, manifest } = await withSpinner("Fetching book details...", async () => ({
      html: await this.getBookHtml(),
      manifest: await this.getManifest(),
    }));
    const aesKey = this.getKey(html);
    fs.writeFileSync(path.join(this.workDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

    const meta = manifest.metadata || {};
    const segments = [...(manifest.segment || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    logger.info(`Title: ${unescapeHtml(meta.title || "?")}  |  Access: ${meta.preview}  |  Segments: ${segments.length}`);
    if (!segments.length) {
      throw new Error("The manifest has no reflowable segments (fixed-layout scan or PDF-only book).");
    }
    if (meta.preview && meta.preview !== "full") {
      logger.warn(`Preview access only ('${meta.preview}'): only images in the preview segments can be fetched.`);
    }

    // Segments → referenced images
    const refs = new Map<string, { url: string; segment: string; segIndex: number }>();
    const segImages = new Map<string, string[]>();
    const cssCache = new Map<string, Promise<string>>();
    let missing = 0;
    for (const [idx, seg] of segments.entries()) {
      const label = seg.label || `seg${idx}`;
      if (!seg.link) {
        missing++;
        continue;
      }
      let obj: SegmentObject;
      try {
        obj = await this.cachedSegment(seg.link, path.join(segDir, `${safeStem(label)}.json`), aesKey);
      } catch (err) {
        logger.warn(`Segment ${label} download/decryption failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const cssTexts = [obj.style || ""];
      for (const res of [...(seg.resource || []), ...(obj.resource || [])]) {
        if (!res.url || !(res.mime_type || "").startsWith("text/css")) continue;
        let pending = cssCache.get(res.url);
        if (!pending) {
          pending = fetchSegmentCss(res.url, this.headers, aesKey).catch(() => "");
          cssCache.set(res.url, pending);
        }
        cssTexts.push(await pending);
      }
      const urls = collectResourceUrls(obj.content || "", cssTexts);
      // The segment's own resource list is more reliable than scanning markup; use it to fill gaps.
      const listed = [
        ...(obj.resource_url || []),
        ...(obj.resource || []).filter((r) => (r.mime_type || "").startsWith("image")).map((r) => r.url || ""),
      ];
      for (const raw of listed) {
        const url = normalizeResourceUrl(raw);
        if (url && !urls.includes(url)) urls.push(url);
      }
      const ids: string[] = [];
      for (const url of urls.filter(looksLikeImageUrl)) {
        const rid = resourceId(url);
        ids.push(rid);
        if (!refs.has(rid)) refs.set(rid, { url, segment: label, segIndex: idx });
      }
      segImages.set(label, ids);
      logger.info(`  [${idx + 1}/${segments.length}] ${label.padEnd(28)} images ${String(ids.length).padStart(3)}  (unique so far: ${refs.size})`);
    }
    if (missing) logger.warn(`${missing} segments have no download link (expected for previews).`);
    logger.info(`Found ${refs.size} unique original images.`);

    let items = [...refs.entries()];
    if (this.limit) items = items.slice(0, this.limit);
    let done = 0;
    const results = await concurrentMap(items, this.options.concurrency || 1, async ([rid, ref]): Promise<FetchedImage | null> => {
      const stem = safeStem(rid);
      const base = { id: rid, segment: ref.segment, seg_index: ref.segIndex, src_url: ref.url };
      const existing = fs.readdirSync(imgDir).find((f) => f.slice(0, f.lastIndexOf(".")) === stem);
      if (existing) {
        const data = fs.readFileSync(path.join(imgDir, existing));
        const probe = await probeImage(data);
        if (probe) {
          logger.progress(++done, items.length, `${rid} cached ${probe.width}x${probe.height}`);
          return { ...base, file: existing, format: probe.format, width: probe.width, height: probe.height, bytes: data.length, fetched_url: "", cached: true };
        }
      }
      try {
        const image = await downloadOriginalImage(ref.url, this.headers, aesKey);
        const file = `${stem}.${MIME_EXTENSION[image.mimeType] || image.format}`;
        fs.writeFileSync(path.join(imgDir, file), image.data);
        logger.progress(++done, items.length, `${rid} ${image.width}x${image.height} ${image.format}`);
        return { ...base, file, format: image.format, width: image.width, height: image.height, bytes: image.data.length, fetched_url: image.url, cached: false };
      } catch (err) {
        done++;
        logger.warn(`${rid} download failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    });
    logger.clearProgress();

    const images = results.filter((r): r is FetchedImage => r !== null).sort((a, b) => a.seg_index - b.seg_index || a.id.localeCompare(b.id));
    const out: FetchedImages = {
      volume_id: this.bookId,
      title: meta.title ? unescapeHtml(meta.title) : undefined,
      authors: meta.authors,
      preview: meta.preview,
      segments: segments.map((s) => ({ label: s.label, order: s.order, title: s.title, images: segImages.get(s.label) || [] })),
      images,
    };
    fs.writeFileSync(path.join(this.workDir, "images.json"), JSON.stringify(out, null, 2), "utf-8");
    this.cleanup();
    logger.success(`Saved ${images.length} images to ${imgDir}`);
    return out;
  }
}
