import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { zipSync, strToU8 } from "fflate";
import { ImgInfo, aspectOk, hashCost, matchImages, nameHint, computeHashes } from "../src/hires/image-hash";
import { detectVolumeId, loadEpub } from "../src/hires/epub-reader";
import { replaceImages } from "../src/hires/replace";

const dir = path.resolve("tmp/hires_test");

/** A deterministic, non-trivial test picture so perceptual hashes have something to work with. */
async function picture(width: number, height: number, seed: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      const i = (y * width + x) * 3;
      raw[i] = Math.floor(127 + 127 * Math.sin((u * 6 + seed) * Math.PI));
      raw[i + 1] = Math.floor(127 + 127 * Math.cos((v * (4 + seed)) * Math.PI));
      raw[i + 2] = (u + v * seed) * 80 > 60 ? 230 : 20;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function info(id: string, data: Buffer, order = 0): Promise<ImgInfo> {
  const meta = await sharp(data).metadata();
  const img: ImgInfo = {
    id, path: id, width: meta.width!, height: meta.height!, format: meta.format!, order, seq: 0,
    phash: 0n, dhash: 0n, mediaType: "image/png", label: "", bytes: data.length, hashable: true,
  };
  await computeHashes(img, data);
  return img;
}

describe("image hashing and matching", () => {
  it("a downscaled copy is close, a different picture is far", async () => {
    const big = await picture(400, 600, 1);
    const small = await sharp(big).resize(160).jpeg({ quality: 70 }).toBuffer();
    const other = await picture(400, 600, 3);
    const a = await info("a", big);
    const b = await info("b", small);
    const c = await info("c", other);
    expect(hashCost(a, b)).toBeLessThan(0.1);
    expect(hashCost(a, c)).toBeGreaterThan(0.2);
    expect(aspectOk(a, b)).toBe(true);
  });

  it("nameHint links EPUB file names with Play resource ids", () => {
    const e = { path: "OEBPS/images/9782803632190_090.jpg" } as ImgInfo;
    expect(nameHint(e, { id: "i_9782803632190_090" } as ImgInfo)).toBe(true);
    expect(nameHint({ path: "OEBPS/images/x01.png" } as ImgInfo, { id: "x01.png" } as ImgInfo)).toBe(true);
    expect(nameHint(e, { id: "x02.png" } as ImgInfo)).toBe(false);
  });

  it("matchImages pairs each EPUB image with its source", async () => {
    const srcA = await picture(400, 600, 1);
    const srcB = await picture(600, 400, 2);
    const epub = [await info("e/b.png", await sharp(srcB).resize(150).png().toBuffer(), 0.1), await info("e/a.png", await sharp(srcA).resize(100).png().toBuffer(), 0.5)];
    const play = [await info("p_a", srcA, 0.4), await info("p_b", srcB, 0.2)];
    const matches = matchImages(epub, play, 0.2);
    const pairs = Object.fromEntries(matches.map((m) => [m.epub.id, m.pb.id]));
    expect(pairs).toEqual({ "e/a.png": "p_a", "e/b.png": "p_b" });
  });
});

describe("hires replace", () => {
  let epubPath = "";
  let workDir = "";

  beforeAll(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    workDir = path.join(dir, "work");
    fs.mkdirSync(path.join(workDir, "images"), { recursive: true });
    const original = await picture(800, 1200, 1);
    fs.writeFileSync(path.join(workDir, "images", "x01.png"), original);
    fs.writeFileSync(
      path.join(workDir, "images.json"),
      JSON.stringify({ volume_id: "Hk3cEAAAQBAJ", title: "Hires Test", images: [{ id: "x01.png", file: "x01.png", seg_index: 0 }] }),
    );

    const lowRes = await sharp(original).resize(200).jpeg({ quality: 60 }).toBuffer();
    epubPath = path.join(dir, "book.epub");
    fs.writeFileSync(
      epubPath,
      zipSync({
        mimetype: [strToU8("application/epub+zip"), { level: 0 }],
        "META-INF/container.xml": strToU8(
          `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        ),
        "OPS/book.opf": strToU8(
          `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book</dc:title><dc:source>https://books.google.com/books?id=Hk3cEAAAQBAJ</dc:source></metadata><manifest><item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="pic" href="img/pic%201.jpg" media-type="image/jpeg"/></manifest><spine><itemref idref="c1"/></spine></package>`,
        ),
        "OPS/text/c1.xhtml": strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="../img/pic%201.jpg"/></body></html>`),
        "OPS/img/pic 1.jpg": new Uint8Array(lowRes),
      }),
    );
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("loadEpub resolves relative, percent-encoded hrefs and the reading order", async () => {
    const book = await loadEpub(epubPath);
    expect(book.volumeId).toBe("Hk3cEAAAQBAJ");
    expect(book.images).toHaveLength(1);
    expect(book.images[0].path).toBe("OPS/img/pic 1.jpg");
    expect(book.images[0].seq).toBe(0);
  });

  it("dry run plans the replacement without writing", async () => {
    const n = await replaceImages(epubPath, workDir, { minGain: 1.1, maxDist: 0.2, dryRun: true, allowSmaller: false, overwrite: false });
    expect(n).toBe(1);
    expect(fs.existsSync(path.join(dir, "hires"))).toBe(false);
  });

  it("replaces the image, keeps its JPEG format and writes a valid archive", async () => {
    const n = await replaceImages(epubPath, workDir, { minGain: 1.1, maxDist: 0.2, dryRun: false, allowSmaller: false, overwrite: false });
    expect(n).toBe(1);
    const out = path.join(dir, "hires", "Hires Test.epub");
    const book = await loadEpub(out, false);
    expect(book.images[0].width).toBe(800);
    expect(book.images[0].format).toBe("jpeg");
    expect(Buffer.from(book.entries["mimetype"]).toString()).toBe("application/epub+zip");
    // Refuses to clobber an existing output unless asked.
    await expect(
      replaceImages(epubPath, workDir, { minGain: 1.1, maxDist: 0.2, dryRun: false, allowSmaller: false, overwrite: false }),
    ).rejects.toThrow(/already exists/);
  });

  it("detectVolumeId reads Google identifiers", () => {
    expect(detectVolumeId('<dc:identifier id="x">google:Hk3cEAAAQBAJ</dc:identifier>')).toBe("Hk3cEAAAQBAJ");
    expect(detectVolumeId("<dc:identifier>urn:uuid:ad59455e-9ed8-52db-aac9-f79bd6bf63ec</dc:identifier>")).toBeUndefined();
  });
});
