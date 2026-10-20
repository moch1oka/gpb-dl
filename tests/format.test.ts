import { describe, it, expect } from "bun:test";
import { chooseFormat } from "../src/utils/format";
import { hasPageEdition } from "../src/utils/page-illustrations";
import { GoogleBookManifest } from "../src/types";

const page = (pid: string, src = true) => ({ pid, order: 0, ...(src ? { src: `https://play.google.com/books/publisher/content/reader?pg=${pid}` } : {}) });
const seg = (extra: object = {}) => ({ label: "s", order: 0, link: "/x", ...extra });

describe("chooseFormat (--format auto)", () => {
  it("light novel with flowing text → EPUB", () => {
    const m = { metadata: {}, available_mode: [1, 2], segment: [seg(), seg()], page: [page("PP1")] } as GoogleBookManifest;
    expect(chooseFormat(m).format).toBe("epub");
  });

  it("fixed-layout manga → CBZ", () => {
    const m = { metadata: {}, available_mode: [1], segment: [seg({ fixed_layout_version: 1 }), seg({ text_properties: { fixed_layout_version: 1 } })], page: [page("PA1")] } as GoogleBookManifest;
    expect(chooseFormat(m)).toEqual({ format: "cbz", reason: "fixed-layout book (manga/comic)" });
  });

  it("scan-only book (all segments not viewable) → CBZ", () => {
    const m = { metadata: {}, segment: [seg({ not_viewable: true })], page: [page("PP1")] } as GoogleBookManifest;
    expect(chooseFormat(m).format).toBe("cbz");
  });

  it("fixed-layout without any downloadable page stays EPUB", () => {
    const m = { metadata: {}, segment: [seg({ fixed_layout_version: 1 })], page: [page("PA1", false)] } as GoogleBookManifest;
    expect(chooseFormat(m).format).toBe("epub");
  });

  it("pages only → PDF, nothing → error", () => {
    expect(chooseFormat({ metadata: {}, page: [page("PA1")] } as GoogleBookManifest).format).toBe("pdf");
    expect(() => chooseFormat({ metadata: {} } as GoogleBookManifest)).toThrow();
  });
});

describe("hasPageEdition", () => {
  it("needs mode 1 and at least one downloadable page", () => {
    expect(hasPageEdition({ metadata: {}, available_mode: [1, 2], page: [page("PP1")] } as GoogleBookManifest)).toBe(true);
    expect(hasPageEdition({ metadata: {}, available_mode: [2], page: [page("PP1")] } as GoogleBookManifest)).toBe(false);
    expect(hasPageEdition({ metadata: {}, available_mode: [1, 2], page: [page("PP1", false)] } as GoogleBookManifest)).toBe(false);
  });
});
