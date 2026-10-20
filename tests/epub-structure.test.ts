import { describe, it, expect } from "bun:test";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { unzipSync, strFromU8 } from "fflate";
import { bookIdentifier, buildEpub, buildTocTree, chapterToc } from "../src/utils/epub-builder";
import { fetchWithRetry } from "../src/utils/async";
import { PageDownloader } from "../src/downloader/page";
import { EpubDownloader } from "../src/downloader/epub";
import { decryptBlob, hiresVariants, normalizeResourceUrl, parseSegmentPayload, resourceId } from "../src/utils/play-api";
import {
  collectIds,
  collectResourceUrls,
  decodeEntities,
  guessLanguage,
  hasReadableContent,
  rewriteFragmentLinks,
  rewriteResourceUrls,
} from "../src/utils/xhtml";
import { GoogleBookManifest } from "../src/types";

const IMG_URL =
  "https://play.google.com/books/publisher/content/reader?id=Hk3cEAAAQBAJ&pg=x01.png&img=1&zoom=6&hl=en&cds=3&sig=ABC&w=816&h=1164";

describe("play-api", () => {
  it("hiresVariants tries the w/h-less original first and keeps zoom", () => {
    const variants = hiresVariants(IMG_URL);
    const first = new URL(variants[0].url);
    expect(first.searchParams.has("w")).toBe(false);
    expect(first.searchParams.has("h")).toBe(false);
    expect(first.searchParams.get("enc_all")).toBe("0");
    expect(first.searchParams.get("zoom")).toBe("6");
    expect(variants[0].encrypted).toBe(false);
    expect(variants[1].encrypted).toBe(true);
    expect(variants[variants.length - 1].url).toBe(IMG_URL);
  });

  it("resourceId uses the pg parameter", () => {
    expect(resourceId(IMG_URL)).toBe("x01.png");
    expect(resourceId("https://example.com/a.png")).toMatch(/^u_[0-9a-f]{16}$/);
  });

  it("normalizeResourceUrl handles entities, relative Play paths and skips data URIs", () => {
    expect(normalizeResourceUrl("/books/x?a=1&amp;b=2")).toBe("https://play.google.com/books/x?a=1&b=2");
    expect(normalizeResourceUrl("//host/a.png")).toBe("https://host/a.png");
    expect(normalizeResourceUrl("data:image/png;base64,AAA")).toBeNull();
    expect(normalizeResourceUrl("images/local.png")).toBeNull();
  });

  it("decryptBlob strips PKCS#7 padding when present", () => {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const plain = Buffer.from("hello original image bytes");
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    const enc = Buffer.concat([iv, cipher.update(plain), cipher.final()]);
    expect(decryptBlob(enc, key).toString()).toBe(plain.toString());
  });

  it("parseSegmentPayload accepts plain JSON and encrypted payloads", () => {
    expect(parseSegmentPayload('{"content":"<p>x</p>"}').content).toBe("<p>x</p>");
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const json = Buffer.from(JSON.stringify({ content: "<p>secret</p>", style: "p{}" }));
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    const enc = Buffer.concat([cipher.update(json), cipher.final()]);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(json.length);
    const payload = Buffer.concat([iv, len, enc]).toString("base64");
    expect(parseSegmentPayload(payload, key).content).toBe("<p>secret</p>");
  });
});

describe("xhtml helpers", () => {
  const html = `<div class="gb-segment"><img  alt="" width="816" height="1164" src="${IMG_URL.replace(/&/g, "&amp;")}" />
<p style="background: url('https://play.google.com/books/publisher/content/reader?id=X&amp;pg=bg.png&amp;img=1')">t</p>
<svg><image xlink:href="https://play.google.com/books/publisher/content/reader?id=X&amp;pg=s.jpg&amp;img=1" /></svg></div>`;

  it("collects resource URLs from img, svg image and inline styles", () => {
    const urls = collectResourceUrls(html, [".a{background:url(https://play.google.com/books/publisher/content/reader?id=X&pg=css.png&img=1)}"]);
    expect(urls.map(resourceId).sort()).toEqual(["bg.png", "css.png", "s.jpg", "x01.png"]);
  });

  it("rewrites resource URLs to local files and keeps other attributes intact", () => {
    const out = rewriteResourceUrls(html, (url) => `images/${resourceId(url).replace(/\..*$/, "")}.png`);
    expect(out).toContain('src="images/x01.png"');
    expect(out).toContain('xlink:href="images/s.png"');
    expect(out).toContain("url(images/bg.png)");
    expect(out).toContain('width="816" height="1164"');
    expect(out).not.toContain("play.google.com");
  });

  it("rewrites cross-file fragment links and drops dangling ones", () => {
    const toc = `<a href="#GBS.PA11">Ch1</a> <a href="#GBS.PA81">Ch3</a> <a href="#own">here</a><a id="own"></a>`;
    const out = rewriteFragmentLinks(toc, (id) =>
      id === "GBS.PA11" ? "id6.xhtml#GBS.PA11" : id === "own" ? "#own" : null,
    );
    expect(out).toContain('<a href="id6.xhtml#GBS.PA11">Ch1</a>');
    expect(out).toContain("<a>Ch3</a>");
    expect(out).toContain('<a href="#own">here</a>');
    expect(collectIds(out)).toEqual(["own"]);
  });

  it("treats &nbsp;/zero-width-only segments as empty", () => {
    expect(hasReadableContent("<p>&nbsp;</p><p>&#8203;&shy;</p>")).toBe(false);
    expect(hasReadableContent("<p>&hellip;Chương&nbsp;3</p>")).toBe(true);
    expect(decodeEntities("&ldquo;A&rdquo; &amp;nbsp; &unknown;")).toBe("“A” &nbsp; &unknown;");
  });

  it("detects empty preview segments", () => {
    expect(hasReadableContent("")).toBe(false);
    expect(hasReadableContent('<div class="gb-segment"><div style="display:none;"><a id="GBS.PA81"></a></div></div>')).toBe(false);
    expect(hasReadableContent("<p>Chương 3</p>")).toBe(true);
    expect(hasReadableContent('<img src="a.png" />')).toBe(true);
  });

  it("guesses Vietnamese and Japanese from the text", () => {
    const vi = "Makoto đã tìm thấy con suối này nhờ kỹ năng Bản đồ. Con suối nhỏ trong khu rừng phía Nam. ".repeat(10);
    expect(guessLanguage(vi)).toBe("vi");
    expect(guessLanguage("これはテストです。ひらがなとカタカナ。".repeat(20))).toBe("ja");
    expect(guessLanguage("This is a plain English sentence about nothing in particular. ".repeat(10))).toBeNull();
  });
});

describe("EPUB structure", () => {
  it("bookIdentifier matches the Python tool's uuid5", () => {
    expect(bookIdentifier("Hk3cEAAAQBAJ")).toBe("urn:uuid:ad59455e-9ed8-52db-aac9-f79bd6bf63ec");
  });

  it("buildTocTree nests by depth, keeps same-named entries with different targets", () => {
    const tree = buildTocTree([
      { title: "Part 1", href: "a.xhtml", depth: 0 },
      { title: "Ch 1", href: "b.xhtml", depth: 1 },
      { title: "Interlude", href: "c.xhtml", depth: 1 },
      { title: "Interlude", href: "d.xhtml", depth: 1 },
      { title: "Interlude", href: "d.xhtml", depth: 1 },
      { title: "Part 2", href: "e.xhtml", depth: 0 },
    ]);
    expect(tree.map((n) => n.title)).toEqual(["Part 1", "Part 2"]);
    expect(tree[0].children.map((n) => n.href)).toEqual(["b.xhtml", "c.xhtml", "d.xhtml"]);
  });

  it("chapterToc merges split chapters and scanned pages into one entry", () => {
    const ch = (label: string, title: string) => ({ label, title, xhtml: "", css: "" });
    expect(chapterToc([ch("id7", "Ch 2"), ch("id7-ppd", "Ch 2"), ch("id8", "Ch 3"), ch("p1", "Ch 2")])).toEqual([
      { title: "Ch 2", href: "id7.xhtml", depth: 0 },
      { title: "Ch 3", href: "id8.xhtml", depth: 0 },
      { title: "Ch 2", href: "p1.xhtml", depth: 0 },
    ]);
  });

  it("fileStems are unique and XML/filesystem safe", () => {
    const stems = EpubDownloader.fileStems([
      { label: "id7", order: 0 },
      { label: "id7", order: 1 },
      { label: "nav", order: 2 },
      { label: "Chương 1", order: 3 },
    ] as GoogleBookManifest["segment"] & object);
    expect(stems).toEqual(["id7", "id7-2", "nav-2", "Ch__ng_1"]);
  });

  it("linkChapters resolves TOC reading positions and skips missing segments", () => {
    const chapters = [
      [{ label: "id17", title: "toc", xhtml: '<a id="GBS.PP1"></a><a href="#GBS.PA11">1</a><a href="#GBS.PA81">3</a>', css: "" }],
      [{ label: "id6", title: "Ch1", xhtml: '<div><a id="GBS.PA11"></a><p>x</p></div>', css: "" }],
      [],
    ];
    const manifest = {
      metadata: {},
      toc_entry: [
        { label: "Book", depth: 0, segment_index: 0, reading_position: "GBS.PP1" },
        { label: "Ch&#7911;1", depth: 0, segment_index: 1, reading_position: "GBS.PA11" },
        { label: "Ch3", depth: 0, segment_index: 2, reading_position: "GBS.PA81" },
      ],
    } as GoogleBookManifest;
    const { chapters: linked, tocItems } = EpubDownloader.linkChapters(chapters, manifest);
    expect(linked).toHaveLength(2);
    expect(linked[0].xhtml).toContain('href="id6.xhtml#GBS.PA11"');
    expect(linked[0].xhtml).not.toContain("GBS.PA81");
    expect(tocItems.map((t) => t.href)).toEqual(["id17.xhtml#GBS.PP1", "id6.xhtml#GBS.PA11"]);
    expect(tocItems[1].title).toBe("Chủ1");
  });

  it("linkChapters points TOC entries of scanned segments at their page documents", () => {
    const pages = [
      [
        { label: "chapter.4.0_PA11", title: "Ch1", xhtml: '<div class="page-image" id="GBS.PA11"><img src="images/PA11.png" alt="" /></div>', css: "", pageImage: { width: 1572, height: 2317 } },
        { label: "chapter.4.0_PA12", title: "Ch1", xhtml: '<div class="page-image" id="GBS.PA12"><img src="images/PA12.png" alt="" /></div>', css: "", pageImage: { width: 1572, height: 2317 } },
      ],
    ];
    const manifest = { metadata: {}, toc_entry: [{ label: "Ch1", depth: 0, segment_index: 0, reading_position: "GBS.PA12" }] } as GoogleBookManifest;
    const { chapters, tocItems } = EpubDownloader.linkChapters(pages, manifest);
    expect(chapters.map((c) => c.label)).toEqual(["chapter.4.0_PA11", "chapter.4.0_PA12"]);
    expect(tocItems[0].href).toBe("chapter.4.0_PA12.xhtml#GBS.PA12");
  });

  it("pageImageCss sizes scans to the fixed-layout viewport", () => {
    const fixed = EpubDownloader.pageImageCss(1572, 2317, true);
    expect(fixed).toContain("width: 1572px; height: 2317px");
    expect(EpubDownloader.pageImageCss(1572, 2317, false)).toContain("max-height: 100vh");
  });

  it("omitCoverPage keeps the cover image but drops cover.xhtml from the spine", async () => {
    const out = path.resolve("tmp/test_scan.epub");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await buildEpub(
      out,
      { title: "Scan", authors: ["A"], publisher: "P", pubDate: "2026", language: "vi", volumeId: "M37cEAAAQBAJ", isFixedLayout: true, viewport: { width: 1572, height: 2317 }, omitCoverPage: true },
      [{ label: "p1", title: "P1", xhtml: "<html/>", css: "", pageImage: { width: 1572, height: 2317 } }],
      { data: Buffer.from([0xff, 0xd8]), mimeType: "image/jpeg" },
    );
    const files = unzipSync(new Uint8Array(fs.readFileSync(out)));
    const opf = strFromU8(files["OEBPS/content.opf"]);
    expect(files["OEBPS/cover.jpg"]).toBeDefined();
    expect(files["OEBPS/cover.xhtml"]).toBeUndefined();
    expect(opf).toContain('properties="cover-image"');
    expect(opf).not.toContain("cover-xhtml");
    expect(opf).toContain('<itemref idref="xhtml-p1" properties="rendition:layout-pre-paginated"/>');
    fs.unlinkSync(out);
  });

  it("writes nested nav, ncx depth and safe manifest ids", async () => {
    const out = path.resolve("tmp/test_structure.epub");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await buildEpub(
      out,
      {
        title: "T & T",
        authors: ["A"],
        publisher: "P",
        pubDate: "2023.10.15",
        language: "vi",
        volumeId: "Hk3cEAAAQBAJ",
        tocItems: [
          { title: "Part", href: "1a.xhtml", depth: 0 },
          { title: "Ch", href: "1a.xhtml#x", depth: 1 },
        ],
      },
      [{ label: "1a", title: "Part", xhtml: "<html/>", css: "" }],
      undefined,
      [{ filename: "images/x 1.png", data: Buffer.from([1]), mimeType: "image/png" }],
    );
    const files = unzipSync(new Uint8Array(fs.readFileSync(out)));
    const opf = strFromU8(files["OEBPS/content.opf"]);
    const nav = strFromU8(files["OEBPS/nav.xhtml"]);
    const ncx = strFromU8(files["OEBPS/toc.ncx"]);
    expect(Object.keys(files)[0]).toBe("mimetype");
    expect(opf).toContain("urn:uuid:ad59455e-9ed8-52db-aac9-f79bd6bf63ec");
    expect(opf).toContain("<dc:date>2023-10-15</dc:date>");
    expect(opf).toContain("<dc:source>https://books.google.com/books?id=Hk3cEAAAQBAJ</dc:source>");
    expect(opf).toContain('id="xhtml-1a"');
    expect(opf).toContain('id="img-x_1.png"');
    expect(opf).toContain("T &amp; T");
    expect(nav).toMatch(/<li><a href="1a.xhtml">Part<\/a>\s*<ol>\s*<li><a href="1a.xhtml#x">Ch<\/a><\/li>/);
    expect(ncx).toContain('<meta name="dtb:depth" content="2"/>');
    fs.unlinkSync(out);
  });
});

describe("RTL page order", () => {
  class TestPages extends PageDownloader {
    async run(): Promise<void> {}
    rtl(pages: { pid: string; order: number }[], all: { pid: string; order: number }[]) {
      return this.adjustRtlPages(pages, all).map((p) => p.pid);
    }
  }
  const dl = new TestPages("rtl_test", { cookiesPath: "cookies.txt", outputDir: "tmp", tempDir: "tmp", pace: 0 });
  const all = ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7"].map((pid, order) => ({ pid, order }));

  it("swaps spreads but keeps the covers", () => {
    expect(dl.rtl(all, all)).toEqual(["P0", "P2", "P1", "P4", "P3", "P6", "P5", "P7"]);
  });

  it("keeps spreads aligned when preview pages are missing", () => {
    const available = all.filter((p) => p.pid !== "P2"); // P1+P2 is a spread, P2 missing
    expect(dl.rtl(available, all)).toEqual(["P0", "P1", "P4", "P3", "P6", "P5", "P7"]);
  });
});

describe("fetchWithRetry", () => {
  it("returns 404 at once but retries 503", async () => {
    const original = globalThis.fetch;
    const calls: number[] = [];
    let status = 404;
    globalThis.fetch = (async () => {
      calls.push(status);
      const s = status;
      if (status === 503) status = 200;
      return new Response("x", { status: s });
    }) as unknown as typeof fetch;
    try {
      expect((await fetchWithRetry("https://example.test/a")).status).toBe(404);
      expect(calls).toEqual([404]);
      status = 503;
      calls.length = 0;
      expect((await fetchWithRetry("https://example.test/b")).status).toBe(200);
      expect(calls).toEqual([503, 200]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
