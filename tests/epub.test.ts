import { describe, it, expect } from "bun:test";
import { TEST_COOKIES, RUN_NETWORK_TESTS } from "./fixtures";
import { EpubDownloader } from "../src/downloader/epub";
import { GoogleBookManifest } from "../types";
import fs from "fs";
import path from "path";

describe("EpubDownloader cover handling", () => {
  it("skips cover generation when --cover none is specified", async () => {
    const downloader = new EpubDownloader("Hk3cEAAAQBAJ", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: "tmp",
      pace: 0,
      cover: "none",
    });

    const cover = await downloader.downloadCover();
    expect(cover).toBeUndefined();
  });

  it("loads a local image file when a valid file path is provided in --cover", async () => {
    const dummyCoverPath = path.resolve("tmp/dummy_cover.jpg");
    fs.mkdirSync(path.dirname(dummyCoverPath), { recursive: true });
    // Write minimal JPEG header
    fs.writeFileSync(dummyCoverPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]));

    const downloader = new EpubDownloader("Hk3cEAAAQBAJ", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: "tmp",
      pace: 0,
      cover: dummyCoverPath,
    });

    const cover = await downloader.downloadCover();
    expect(cover).toBeDefined();
    expect(cover?.mimeType).toBe("image/jpeg");
    expect(cover?.data.byteLength).toBe(6);

    if (fs.existsSync(dummyCoverPath)) {
      fs.unlinkSync(dummyCoverPath);
    }
  });

  it.skipIf(!RUN_NETWORK_TESTS)("forces frontcover endpoint when --cover frontcover is specified", async () => {
    const downloader = new EpubDownloader("Hk3cEAAAQBAJ", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: "tmp",
      pace: 0,
      cover: "frontcover",
    });

    const cover = await downloader.downloadCover();
    expect(cover).toBeDefined();
    expect(cover?.mimeType).toContain("image");
    expect(cover?.data.byteLength).toBeGreaterThan(1000);
  });

  it.skipIf(!RUN_NETWORK_TESTS)("falls back to frontcover endpoint when no pages are available in auto mode", async () => {
    const downloader = new EpubDownloader("Hk3cEAAAQBAJ", {
      cookiesPath: TEST_COOKIES,
      outputDir: "tmp",
      tempDir: "tmp",
      pace: 0,
    });

    const manifestWithoutPages: GoogleBookManifest = {
      metadata: { title: "Test Book" },
      page: [],
    };

    const cover = await downloader.downloadCover(manifestWithoutPages, undefined);
    expect(cover).toBeDefined();
    expect(cover?.mimeType).toContain("image");
    expect(cover?.data.byteLength).toBeGreaterThan(1000);
  });
});

describe("EpubDownloader CSS and illustration formatting", () => {
  const downloader = new EpubDownloader("Hk3cEAAAQBAJ", {
    cookiesPath: TEST_COOKIES,
    outputDir: "tmp",
    tempDir: "tmp",
    pace: 0,
  });

  it("cleanSegmentCss removes malformed @font-face blocks and fixes max-width", () => {
    const rawCss = `
@font-face {
  font-family: bookerly;
}
@font-face {
  font-family: bookerlyBold;
  format("truetype");
}
.gb-segment img {
  display: block;
  margin-left: auto;
  margin-right: auto;
  max-width: 50%;
}
.gb-segment {
  -epub-hyphens: auto;
  font-family: bookerly;
}
@page {
  margin: 0 0 0 0;
}
`;
    const cleaned = downloader.cleanSegmentCss(rawCss, false);
    expect(cleaned).not.toContain('format("truetype")');
    expect(cleaned).not.toContain("font-family: bookerly");
    expect(cleaned).toContain("max-width: 100%");
    expect(cleaned).not.toContain("max-width: 50%");
    expect(cleaned).not.toContain("@page");
    expect(cleaned).toContain(".full-page-illustration");
  });

  it("cleanSegmentCss drops the remote Bookerly @font-face from reader-style CSS", () => {
    const rawCss = `@font-face {
  font-family: bookerly;
  src: url('https://books.googleusercontent.com/books/content/download/bookerly.ttf?id=Hk3cEAAAQBAJ&output=font&aid=id&ef=4');
}
@font-face { font-family: "Other"; src: url(fonts/other.otf); }
.gb-segment { font-family: bookerly; }`;
    const cleaned = downloader.cleanSegmentCss(rawCss, false);
    expect(cleaned).not.toContain("googleusercontent");
    expect(cleaned).not.toContain("bookerly");
    expect(cleaned).toContain('font-family: "Other"');
  });

  it("cleanSegmentCss preserves @page in fixed layout mode", () => {
    const rawCss = `@page { margin: 0; } .gb-segment img { max-width: 50%; }`;
    const cleaned = downloader.cleanSegmentCss(rawCss, true);
    expect(cleaned).toContain("@page");
    expect(cleaned).toContain("max-width: 100%");
  });

  it("formatReflowableIllustrations wraps large illustrations and breaks following paragraphs", () => {
    const htmlWithIllustration = `
<p>Some text</p>
<img width="785" height="1157" alt="illust" src="images/id16_1.png" />
<div style="display:none;"></div>
<p class="Normal">Next paragraph text</p>
<img width="315" height="305" alt="logo" src="images/logo.png" />
`;
    const formatted = downloader.formatReflowableIllustrations(htmlWithIllustration);
    expect(formatted).toContain('class="full-page-illustration-container"');
    expect(formatted).toContain('class="full-page-illustration"');
    expect(formatted).toContain("break-before: page");
    expect(formatted).toContain("page-break-before: always");
    // Next paragraph must receive break-before to prevent dangling lines under the image
    expect(formatted).toMatch(/<p[^>]*style="[^"]*break-before:\s*page[^"]*"[^>]*class="Normal"/);
    // Logo should not be wrapped in illustration container
    expect(formatted).toMatch(/<img width="315" height="305"[^>]*src="images\/logo\.png"/);
    expect(formatted).not.toContain('src="images/logo.png" class="full-page-illustration"');
  });

  it("linkStylesheet injects standard viewport meta tag", () => {
    const segment = `<div>Hello world</div>`;
    const linked = downloader.linkStylesheet(segment, "ch1", "Chapter 1");
    expect(linked).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0" />');
    expect(linked).toContain('<link rel="stylesheet" type="text/css" href="ch1.css" />');
  });

  it("linkStylesheet injects fixed layout viewport when specified", () => {
    const segment = `<div>Manga Page</div>`;
    const linked = downloader.linkStylesheet(segment, "p1", "Page 1", { width: 1210, height: 1720 }, true);
    expect(linked).toContain('<meta name="viewport" content="width=1210, height=1720" />');
  });
});

describe("buildEpub packaging", () => {
  it("builds fixed-layout EPUB with pre-paginated metadata and RTL direction", async () => {
    const { buildEpub } = await import("../src/utils/epub-builder");
    const testOutputPath = path.resolve("tmp/test_manga.epub");

    await buildEpub(
      testOutputPath,
      {
        title: "Test Manga",
        authors: ["Test Author"],
        publisher: "Test Publisher",
        pubDate: "2026",
        language: "ja",
        volumeId: "test-manga-1",
        isFixedLayout: true,
        isRightToLeft: true,
        viewport: { width: 1210, height: 1720 },
        tocItems: [{ title: "Chapter 1", href: "p1.xhtml", depth: 0 }],
      },
      [
        {
          label: "p1",
          title: "Page 1",
          xhtml: `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><img src="images/p1.png"/></body></html>`,
          css: `body { margin: 0; }`,
        },
      ]
    );

    expect(fs.existsSync(testOutputPath)).toBe(true);
    expect(fs.statSync(testOutputPath).size).toBeGreaterThan(100);
    const buf = fs.readFileSync(testOutputPath);
    const content = buf.toString("latin1");
    expect(content).toContain("mimetypeapplication/epub+zip");
    expect(content).toContain("OEBPS/content.opf");
    expect(content).toContain("OEBPS/nav.xhtml");
    expect(content).toContain("OEBPS/toc.ncx");
    expect(content).toContain("OEBPS/p1.xhtml");

    if (fs.existsSync(testOutputPath)) {
      fs.unlinkSync(testOutputPath);
    }
  });

  it("builds reflowable EPUB with custom TOC items", async () => {
    const { buildEpub } = await import("../src/utils/epub-builder");
    const testOutputPath = path.resolve("tmp/test_reflowable.epub");

    await buildEpub(
      testOutputPath,
      {
        title: "Test Novel",
        authors: ["Novel Author"],
        publisher: "Novel Publisher",
        pubDate: "2026",
        language: "vi",
        volumeId: "test-novel-1",
        isFixedLayout: false,
        tocItems: [
          { title: "Prologue", href: "ch1.xhtml", depth: 0 },
          { title: "Chapter 1", href: "ch2.xhtml", depth: 0 },
        ],
      },
      [
        {
          label: "ch1",
          title: "Prologue",
          xhtml: `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Hello</p></body></html>`,
          css: `p { color: red; }`,
        },
        {
          label: "ch2",
          title: "Chapter 1",
          xhtml: `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>World</p></body></html>`,
          css: `p { color: blue; }`,
        },
      ]
    );

    expect(fs.existsSync(testOutputPath)).toBe(true);
    expect(fs.statSync(testOutputPath).size).toBeGreaterThan(100);
    const buf = fs.readFileSync(testOutputPath);
    const content = buf.toString("latin1");
    expect(content).toContain("mimetypeapplication/epub+zip");
    expect(content).toContain("OEBPS/content.opf");
    expect(content).toContain("OEBPS/nav.xhtml");
    expect(content).toContain("OEBPS/toc.ncx");
    expect(content).toContain("OEBPS/ch1.xhtml");
    expect(content).toContain("OEBPS/ch2.xhtml");

    if (fs.existsSync(testOutputPath)) {
      fs.unlinkSync(testOutputPath);
    }
  });
});


