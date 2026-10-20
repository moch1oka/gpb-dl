import { describe, it, expect } from "bun:test";
import sharp from "sharp";
import { compareCovers, storeCoverWins } from "../src/utils/image-compare";
import jpeg from "jpeg-js";

function createSolidJpeg(width: number, height: number, r: number, g: number, b: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  const raw = jpeg.encode({ data, width, height }, 90);
  return Buffer.from(raw.data);
}

/** A structured test picture (gradients and bands), deterministic per seed. */
async function picture(width: number, height: number, seed: number, format: "png" | "jpeg"): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.floor(127 + 127 * Math.sin(((x / width) * 5 + seed) * Math.PI));
      raw[i + 1] = Math.floor(127 + 127 * Math.cos((y / height) * (3 + seed) * Math.PI));
      raw[i + 2] = ((x + y * seed) / (width + height)) * 255;
    }
  }
  const img = sharp(raw, { raw: { width, height, channels: 3 } });
  return format === "png" ? img.png().toBuffer() : img.jpeg({ quality: 80 }).toBuffer();
}

describe("image-compare utility", () => {
  it("detects identical images with different dimensions as similar", async () => {
    const imgA = createSolidJpeg(100, 150, 200, 50, 50);
    const imgB = createSolidJpeg(200, 300, 200, 50, 50);

    const result = await compareCovers(imgA, imgB);
    expect(result).not.toBeNull();
    expect(result?.areSimilar).toBe(true);
    expect(result?.meanDiff).toBeLessThan(5);
    expect(result?.dim1.width).toBe(100);
    expect(result?.dim2.width).toBe(200);
  });

  it("detects completely different images as not similar", async () => {
    const imgWhite = createSolidJpeg(100, 150, 255, 255, 255);
    const imgBlack = createSolidJpeg(100, 150, 0, 0, 0);

    const result = await compareCovers(imgWhite, imgBlack);
    expect(result).not.toBeNull();
    expect(result?.areSimilar).toBe(false);
    expect(result?.meanDiff).toBeGreaterThan(50);
  });

  it("compares a PNG page with a JPEG store cover", async () => {
    const page = await picture(600, 900, 1, "png");
    const store = await picture(400, 600, 1, "jpeg");
    const other = await picture(400, 600, 3, "jpeg");
    expect((await compareCovers(page, store))?.areSimilar).toBe(true);
    expect((await compareCovers(page, other))?.areSimilar).toBe(false);
  });

  it("rejects same-content images with a very different aspect ratio", async () => {
    const tall = await picture(400, 600, 1, "png");
    const wide = await sharp(tall).resize(600, 400, { fit: "fill" }).png().toBuffer();
    expect((await compareCovers(tall, wide))?.areSimilar).toBe(false);
  });

  it("prefers the book's own page unless the store cover is much larger", () => {
    const at = (w: number, h: number) => ({ width: w, height: h, pixels: w * h });
    const base = { areSimilar: true, meanDiff: 1, cost: 0 };
    expect(storeCoverWins({ ...base, dim1: at(1044, 1500), dim2: at(1044, 1500) })).toBe(false);
    expect(storeCoverWins({ ...base, dim1: at(1000, 1500), dim2: at(1100, 1650) })).toBe(false);
    expect(storeCoverWins({ ...base, dim1: at(575, 817), dim2: at(1044, 1500) })).toBe(true);
  });

  it("returns null safely when given invalid buffers", async () => {
    const invalidA = Buffer.from([1, 2, 3]);
    const invalidB = Buffer.from([4, 5, 6]);

    const result = await compareCovers(invalidA, invalidB);
    expect(result).toBeNull();
  });
});
