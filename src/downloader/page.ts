import fs from "fs";
import path from "path";
import sharp from "sharp";
import { BaseDownloader, DownloaderOptions } from "./base";
import { concurrentMap, fetchWithRetry } from "../utils/async";
import { logger, withSpinner } from "../utils/logger";
import { GoogleBookManifest, GoogleBookPageManifest } from "../types";
import { compareCovers, storeCoverWins } from "../utils/image-compare";
import { downloadOriginalImage, fetchPlayImage, fetchSegment, pageImageUrl } from "../utils/play-api";
import { collectResourceUrls, visibleText } from "../utils/xhtml";

/**
 * Where the best copy of a page comes from:
 * - "scan": a stored page scan, served unresampled at exactly its original size
 *   (a larger w/h only returns an upscaled copy);
 * - "image": a fixed-layout page that is a single publisher image (manga/comics). The page
 *   endpoint only offers a lossy JPEG re-render of it, so take the image itself.
 * Pages without a source keep the render at the largest size the server allows.
 */
export type PageSource = { kind: "scan"; width: number; height: number } | { kind: "image"; url: string };

export abstract class PageDownloader extends BaseDownloader {
  protected cachedFiles: Set<string> = new Set();

  constructor(bookId: string, options: DownloaderOptions) {
    super(bookId, options);
  }

  /**
   * Reads the segments to learn, per page id, where its best copy comes from.
   * Page sizes and fixed-layout content are only listed there, not in the manifest's page list.
   */
  async resolvePageSources(manifest: GoogleBookManifest, aesKey: Buffer): Promise<Map<string, PageSource>> {
    const sources = new Map<string, PageSource>();
    // Only segments covering at least one downloadable page (a preview may offer few of them).
    const allPages = manifest.page || [];
    const pageIndex = new Map(allPages.map((page, i) => [page.pid, i]));
    const coversDownloadablePage = (segment: { start?: string; num_pages?: number }): boolean => {
      const start = segment.start !== undefined ? pageIndex.get(segment.start) : undefined;
      if (start === undefined) return true; // can't tell, read it
      return allPages.slice(start, start + Math.max(1, segment.num_pages || 0)).some((page) => page.src);
    };
    const segments = (manifest.segment || []).filter((segment) => segment.link && coversDownloadablePage(segment));
    if (!segments.length) return sources;

    await withSpinner(`Reading ${segments.length} segments for original page sizes...`, () =>
      concurrentMap(segments, Math.max(1, this.options.concurrency || 1), async (segment) => {
        let obj;
        try {
          obj = await fetchSegment(segment.link!, this.headers, aesKey);
        } catch (err) {
          logger.debug(`Segment ${segment.label}: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        const pages = (obj.page || []).filter((page) => page.src);
        for (const page of pages) {
          if (page.original_w && page.original_h) {
            sources.set(page.pid, { kind: "scan", width: page.original_w, height: page.original_h });
          }
        }

        const viewport = segment.text_properties?.fixed_layout_info?.viewport;
        const isFixedLayout = Boolean(segment.fixed_layout_version || segment.text_properties?.fixed_layout_version);
        if (!isFixedLayout || pages.length !== 1 || sources.has(pages[0].pid)) return;
        const content = obj.content || "";
        const images = collectResourceUrls(content);
        // Manga pages carry a hidden "." placeholder; only letters/digits count as page text.
        if (images.length !== 1 || /[\p{L}\p{N}]/u.test(visibleText(content))) return;
        // Only when the image is the page: its aspect must match the page viewport.
        const declared = new URL(images[0]).searchParams;
        const w = Number(declared.get("w")) || 0;
        const h = Number(declared.get("h")) || 0;
        const vw = Number(viewport?.width) || 0;
        const vh = Number(viewport?.height) || 0;
        if (w && h && vw && vh && Math.abs(w / h - vw / vh) > 0.03 * (vw / vh)) return;
        sources.set(pages[0].pid, { kind: "image", url: images[0] });
      }),
    );

    const counts = { scan: 0, image: 0 };
    for (const source of sources.values()) counts[source.kind]++;
    if (counts.scan) logger.info(`${counts.scan} pages are scans: downloading them at their original size.`);
    if (counts.image) logger.info(`${counts.image} pages are single publisher images: downloading the originals instead of re-rendered pages.`);
    return sources;
  }

  /**
   * Downloads a single page at the best available quality and decrypts it.
   */
  async downloadAndDecryptPage(
    src: string,
    aesKey: Buffer,
    pid: string,
    order: number,
    totalPages: number,
    source?: PageSource
  ): Promise<string> {
    // Check if file already exists in cache
    const existingFile = [...this.cachedFiles].find((file) => file.slice(0, file.lastIndexOf(".")) === pid);
    if (existingFile) {
      logger.debug(`Page ${pid} already exists in cache, skipping download`);
      return path.join(this.bookTempDir, existingFile);
    }

    if (source?.kind === "image") {
      try {
        const image = await downloadOriginalImage(source.url, this.headers, aesKey);
        logger.debug(`Page ${pid}: original image ${image.width}x${image.height} ${image.format}`);
        return await this.savePage(pid, image.data, image.format);
      } catch (err) {
        logger.debug(`Page ${pid}: original image failed (${err instanceof Error ? err.message : String(err)}), using the page render`);
      }
    }

    // Scans at their stored size; other pages at the largest render the server allows
    const url = pageImageUrl(src, source?.kind === "scan" ? source : undefined);
    logger.debug(`Downloading page pid: ${pid}, order: ${order} from URL: ${url}`);
    const image = await fetchPlayImage(url, this.headers, aesKey);
    if (typeof image === "string") {
      throw new Error(`Failed to download page ${pid}: ${image}`);
    }
    // savePage converts anything that isn't PNG/JPEG (e.g. WebP)
    return this.savePage(pid, image.data, image.format);
  }

  /**
   * Writes a page image to the temp dir as PNG or JPEG (the formats PDF and comic readers accept).
   */
  private async savePage(pid: string, data: Buffer, format: string): Promise<string> {
    let ext = format === "jpeg" ? "jpeg" : "png";
    if (format !== "jpeg" && format !== "png") {
      data = await sharp(data).png().toBuffer();
      ext = "png";
    }
    const filename = `${pid}.${ext}`;
    const filepath = path.join(this.bookTempDir, filename);
    await fs.promises.writeFile(filepath, data);
    this.cachedFiles.add(filename);
    logger.debug(`Saved page ${pid} to: ${filepath}`);
    return filepath;
  }

  /**
   * Reorders pages for Right-to-Left (RTL) reading layouts: the front and back covers stay,
   * every spread in between is swapped. Spreads are taken from the book's full page list
   * (`allPages`), so pages missing from a preview don't shift the pairing of later spreads.
   */
  protected adjustRtlPages(
    pages: GoogleBookPageManifest[],
    allPages: GoogleBookPageManifest[] = pages,
  ): GoogleBookPageManifest[] {
    if (pages.length <= 2) return pages;

    const position = new Map(allPages.map((page, i) => [page.pid, i]));
    const last = allPages.length - 1;
    const spreadOf = (page: GoogleBookPageManifest): string => {
      const i = position.get(page.pid) ?? -1;
      if (i <= 0) return "front";
      if (i === last) return "back";
      return `s${Math.floor((i - 1) / 2)}`;
    };

    const result: GoogleBookPageManifest[] = [];
    let spread: GoogleBookPageManifest[] = [];
    let current = "";
    const flush = () => {
      result.push(...(current === "front" || current === "back" ? spread : spread.reverse()));
      spread = [];
    };
    for (const page of pages) {
      const key = spreadOf(page);
      if (key !== current) flush();
      current = key;
      spread.push(page);
    }
    flush();
    return result;
  }

  /**
   * Intelligently selects or upgrades the cover page for page-based formats (PDF, CBZ).
   * - If --cover none: keeps pages as-is.
   * - If --cover <path>: prepends local cover image.
   * - If --cover <page_id>: moves the specified page to the front as cover.
   * - If --cover auto (or frontcover): compares the first page with official store cover.
   *   * Similar content: picks the higher resolution version.
   *   * Different content: prepends official store cover as page 1.
   */
  async applyCoverSelection(imagePaths: string[]): Promise<string[]> {
    if (imagePaths.length === 0) return imagePaths;

    const coverChoice = (this.options.cover || "auto").trim();
    const lowerChoice = coverChoice.toLowerCase();

    // 1. Skip if user explicitly disabled cover processing
    if (lowerChoice === "none" || lowerChoice === "off" || lowerChoice === "false") {
      logger.info("Cover selection skipped (--cover none).");
      return imagePaths;
    }

    // 2. If user specified a local image file
    if (fs.existsSync(coverChoice) && fs.statSync(coverChoice).isFile()) {
      logger.info(`Using local image file as cover: ${coverChoice}`);
      return [coverChoice, ...imagePaths];
    }

    // 3. If user specified a specific page ID (e.g. PP1, PP2, PA1)
    if (lowerChoice !== "auto" && lowerChoice !== "frontcover" && lowerChoice !== "thumbnail" && lowerChoice !== "web") {
      const targetIdx = imagePaths.findIndex((p) => {
        const base = path.basename(p).toLowerCase();
        return base.startsWith(lowerChoice + ".") || base.startsWith(lowerChoice + "_");
      });
      if (targetIdx > 0) {
        logger.info(`Moving specified page '${coverChoice}' to the front as cover.`);
        const cloned = [...imagePaths];
        const [targetPage] = cloned.splice(targetIdx, 1);
        return [targetPage, ...cloned];
      } else if (targetIdx === 0) {
        logger.info(`Specified page '${coverChoice}' is already the first page.`);
        return imagePaths;
      }
    }

    // 4. Fetch publisher frontcover asset
    const publisherCover = await this.downloadFrontcover();
    if (!publisherCover) {
      return imagePaths;
    }

    const ext = publisherCover.mimeType.includes("png") ? "png" : "jpeg";
    const coverPath = path.join(this.bookTempDir, `cover.${ext}`);

    // If user explicitly forced frontcover
    if (lowerChoice === "frontcover" || lowerChoice === "thumbnail" || lowerChoice === "web") {
      await fs.promises.writeFile(coverPath, publisherCover.data);
      this.cachedFiles.add(`cover.${ext}`);

      const page0Bytes = await fs.promises.readFile(imagePaths[0]);
      const comparison = await compareCovers(page0Bytes, publisherCover.data);
      if (comparison?.areSimilar) {
        logger.info("First page matches store frontcover. Replaced first page with store frontcover.");
        return [coverPath, ...imagePaths.slice(1)];
      } else {
        logger.info("Added store frontcover as the first page.");
        return [coverPath, ...imagePaths];
      }
    }

    // 5. 'auto' mode: compare first page with publisher cover
    try {
      const page0Bytes = await fs.promises.readFile(imagePaths[0]);
      const comparison = await compareCovers(page0Bytes, publisherCover.data);

      if (comparison) {
        if (comparison.areSimilar) {
          // Same cover: keep the book's own page unless the store copy is much larger
          if (storeCoverWins(comparison)) {
            await fs.promises.writeFile(coverPath, publisherCover.data);
            this.cachedFiles.add(`cover.${ext}`);
            logger.info(
              `First page matches store cover. Replaced with the much larger store cover (${comparison.dim2.width}x${comparison.dim2.height} vs ${comparison.dim1.width}x${comparison.dim1.height}).`
            );
            return [coverPath, ...imagePaths.slice(1)];
          } else {
            logger.info(
              `First page matches store cover. Kept the book's own cover page (${comparison.dim1.width}x${comparison.dim1.height}, store ${comparison.dim2.width}x${comparison.dim2.height}).`
            );
            return imagePaths;
          }
        } else {
          // Content differs: page 0 is an inner illustration or prelim page, add store cover to the front
          await fs.promises.writeFile(coverPath, publisherCover.data);
          this.cachedFiles.add(`cover.${ext}`);
          logger.info(
            `First page differs from store cover. Added official store cover as the first page (${comparison.dim2.width}x${comparison.dim2.height}).`
          );
          return [coverPath, ...imagePaths];
        }
      }
    } catch (err) {
      logger.debug(`Auto cover comparison failed for page-based format: ${err instanceof Error ? err.message : String(err)}`);
    }

    return imagePaths;
  }
}
