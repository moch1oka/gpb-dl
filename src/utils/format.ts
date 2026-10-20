import { GoogleBookManifest } from "../types";

export type OutputFormat = "pdf" | "epub" | "cbz";

/**
 * Picks the output format from the manifest:
 * - fixed-layout books (manga, comics) and scan-only books → CBZ: every page is a picture;
 * - books with flowing text → EPUB (illustrations are upgraded from the page edition if any);
 * - page images only, no segments → PDF.
 */
export function chooseFormat(manifest: GoogleBookManifest): { format: OutputFormat; reason: string } {
  const segments = manifest.segment || [];
  const hasPages = (manifest.page || []).some((page) => page.src);
  if (segments.length > 0) {
    const fixedLayout = segments.every(
      (segment) => segment.fixed_layout_version || segment.text_properties?.fixed_layout_version
    );
    const scanOnly = !fixedLayout && segments.every((segment) => segment.not_viewable);
    if (hasPages && fixedLayout) return { format: "cbz", reason: "fixed-layout book (manga/comic)" };
    if (hasPages && scanOnly) return { format: "cbz", reason: "scanned pages only" };
    return { format: "epub", reason: "flowing text" };
  }
  if (manifest.page && manifest.page.length > 0) return { format: "pdf", reason: "page images only" };
  throw new Error("No readable segments or pages found in book manifest.");
}
