// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { printOrigin } from "../origin";
import { Refused, contrastRatio, decodePng, measure, parseRegions, type Region } from "./contrast";

const SCRIPT = printOrigin("./contrast.ts", import.meta.dir);
const CLI_TIMEOUT_MS = 10_000;

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
  return out;
}

interface PngOptions {
  channels?: 3 | 4;
  filter?: number;
  depth?: number;
  interlace?: number;
}

// `pixels` holds `channels` bytes per pixel. Each scanline uses the forward form of `filter` (PNG spec 9.2).
function png(width: number, height: number, pixels: Uint8Array, { channels = 3, filter = 0, depth = 8, interlace = 0 }: PngOptions = {}): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([depth, channels === 4 ? 6 : 2, 0, 0, interlace], 8);
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  const at = (y: number, i: number) => (y < 0 || i < 0 ? 0 : pixels[y * stride + i]!);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const a = at(y, i - channels);
      const b = at(y - 1, i);
      const c = at(y - 1, i - channels);
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter]!;
      raw[y * (stride + 1) + 1 + i] = (at(y, i) - predictor) & 0xff;
    }
  }
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  return Buffer.concat(parts);
}

const rgb = (color: number) => [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];

// A `width`x`height` image of `background` with a `foreground` pixel at every third pixel.
function sample(foreground: number, background: number, width = 6, height = 4): Uint8Array {
  const pixels: number[] = [];
  for (let p = 0; p < width * height; p++) pixels.push(...rgb(p % 3 === 0 ? foreground : background));
  return png(width, height, new Uint8Array(pixels));
}

const region = (kind: Region["kind"], box = { x: 0, y: 0, width: 6, height: 4 }): Region => ({ pair: "Test pair", kind, box });
const ratioOf = (bytes: Uint8Array, kind: Region["kind"] = "text") => measure(decodePng(bytes), region(kind));

describe("WCAG 2.2 contrast ratio", () => {
  test("black on white is 21.00:1", () => {
    expect(contrastRatio(0x000000, 0xffffff).toFixed(2)).toBe("21.00");
    const m = ratioOf(sample(0x000000, 0xffffff));
    expect(m.ratio.toFixed(2)).toBe("21.00");
    expect([m.foreground, m.background, m.pass]).toEqual([0x000000, 0xffffff, true]);
  });

  test("Muted text #576171 on light Selected row #DCE8FA is 5.06:1", () => {
    expect(ratioOf(sample(0x576171, 0xdce8fa)).ratio.toFixed(2)).toBe("5.06");
  });

  test("equal colors are 1.00:1 and fail both kinds", () => {
    const one = png(2, 2, new Uint8Array(Array(4).fill(rgb(0x336699)).flat()));
    const m = measure(decodePng(one), region("non-text", { x: 0, y: 0, width: 2, height: 2 }));
    expect([m.ratio, m.pass]).toEqual([1, false]);
  });

  test("the text threshold is not rounded: #777777 on white fails text, passes non-text", () => {
    // Hand check: L(#777777) = 0.18447, (1.05) / (0.23447) = 4.478.
    const m = ratioOf(sample(0x777777, 0xffffff));
    expect(m.ratio.toFixed(2)).toBe("4.48");
    expect(m.pass).toBe(false);
    expect(ratioOf(sample(0x777777, 0xffffff), "non-text").pass).toBe(true);
    expect(ratioOf(sample(0x767676, 0xffffff)).pass).toBe(true);
  });

  test("the foreground is the color with the highest contrast against the background", () => {
    const pixels = [...rgb(0x000000), ...rgb(0x808080), ...rgb(0xffffff), ...rgb(0xffffff), ...rgb(0xffffff), ...rgb(0xffffff)];
    const m = measure(decodePng(png(3, 2, new Uint8Array(pixels))), region("text", { x: 0, y: 0, width: 3, height: 2 }));
    expect(m.foreground).toBe(0x000000);
  });

  test("a tie for the most frequent color is refused", () => {
    const pixels = [...rgb(0x000000), ...rgb(0xffffff)];
    expect(() => measure(decodePng(png(2, 1, new Uint8Array(pixels))), region("text", { x: 0, y: 0, width: 2, height: 1 }))).toThrow(Refused);
  });

  test("a box outside the image bounds is refused", () => {
    const image = decodePng(sample(0x000000, 0xffffff));
    expect(() => measure(image, region("text", { x: 1, y: 0, width: 6, height: 4 }))).toThrow(/outside the 6x4 image/);
    expect(() => measure(image, region("text", { x: 0, y: 4, width: 1, height: 1 }))).toThrow(Refused);
  });
});

describe("PNG decoding", () => {
  test("every filter type decodes to the same pixels", () => {
    const pixels = new Uint8Array(5 * 4 * 3).map((_, i) => (i * 37 + (i >> 3) * 11) & 0xff);
    for (const filter of [0, 1, 2, 3, 4]) expect(decodePng(png(5, 4, pixels, { filter })).rgb).toEqual(pixels);
  });

  test("opaque RGBA decodes, a non-opaque pixel is refused", () => {
    const opaque = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(decodePng(png(2, 1, opaque, { channels: 4, filter: 1 })).rgb).toEqual(new Uint8Array([0, 0, 0, 255, 255, 255]));
    const translucent = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 254]);
    expect(() => decodePng(png(2, 1, translucent, { channels: 4 }))).toThrow(/non-opaque pixel at 1,0/);
  });

  test("other formats and malformed files are refused", () => {
    const good = sample(0x000000, 0xffffff);
    expect(() => decodePng(png(1, 1, new Uint8Array(6), { depth: 16 }))).toThrow(/bit depth 16/);
    expect(() => decodePng(png(1, 1, new Uint8Array(3), { interlace: 1 }))).toThrow(/interlaced/);
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/signature/);
    expect(() => decodePng(good.subarray(0, good.length - 6))).toThrow(/truncated/);
    const badCrc = new Uint8Array(good);
    badCrc[20] = badCrc[20]! ^ 1;
    expect(() => decodePng(badCrc)).toThrow(/bad CRC in IHDR/);
    const short = Buffer.concat([good.subarray(0, 33), chunk("IDAT", deflateSync(new Uint8Array(3))), chunk("IEND", new Uint8Array())]);
    expect(() => decodePng(short)).toThrow(/does not match IHDR/);
    const notZlib = Buffer.concat([good.subarray(0, 33), chunk("IDAT", new Uint8Array([1, 2, 3])), chunk("IEND", new Uint8Array())]);
    expect(() => decodePng(notZlib)).toThrow(/bad zlib data/);
  });

  test("an unknown critical chunk is refused", () => {
    const good = sample(0x000000, 0xffffff);
    const withChunk = Buffer.concat([good.subarray(0, 33), chunk("ZZZZ", new Uint8Array(1)), good.subarray(33)]);
    expect(() => decodePng(withChunk)).toThrow(/unknown critical chunk ZZZZ/);
    const withAncillary = Buffer.concat([good.subarray(0, 33), chunk("tEXt", new Uint8Array(1)), good.subarray(33)]);
    expect(decodePng(withAncillary).width).toBe(6);
  });
});

describe("regions input", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  test("valid regions parse", () => {
    expect(parseRegions(encode([region("non-text")]))).toEqual([region("non-text")]);
  });

  test("bad regions are refused", () => {
    expect(() => parseRegions(encode([]))).toThrow(Refused);
    expect(() => parseRegions(encode([{ ...region("text"), kind: "large" }]))).toThrow(/kind/);
    expect(() => parseRegions(encode([{ ...region("text"), extra: 1 }]))).toThrow(/exactly/);
    expect(() => parseRegions(encode([region("text", { x: 0, y: 0, width: 0, height: 1 })]))).toThrow(/empty/);
    expect(() => parseRegions(encode([region("text", { x: -1, y: 0, width: 1, height: 1 })]))).toThrow(/non-negative/);
    expect(() => parseRegions(new TextEncoder().encode('[{"pair":"a","pair":"b"}]'))).toThrow(Refused);
  });
});

describe("CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "arbareto-contrast-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (pngBytes: Uint8Array, regions: unknown) => {
    const capture = join(dir, `${crypto.randomUUID()}.png`);
    const list = join(dir, `${crypto.randomUUID()}.json`);
    writeFileSync(capture, pngBytes);
    writeFileSync(list, JSON.stringify(regions));
    const proc = Bun.spawnSync([process.execPath, SCRIPT, capture, list], { stdin: "ignore", timeout: CLI_TIMEOUT_MS });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  };

  test("exit 0 when every region passes", () => {
    const r = run(sample(0x576171, 0xdce8fa), [{ pair: "Muted text on Selected row", kind: "text", box: { x: 0, y: 0, width: 6, height: 4 } }]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("PASS 5.06:1 text fg #576171 bg #DCE8FA Muted text on Selected row");
  });

  test("exit 1 when a region fails", () => {
    const r = run(sample(0x777777, 0xffffff), [region("non-text"), region("text")]);
    expect(r.code).toBe(1);
    expect(r.out.trim().split("\n")).toEqual(["PASS 4.48:1 non-text fg #777777 bg #FFFFFF Test pair", "FAIL 4.48:1 text fg #777777 bg #FFFFFF Test pair"]);
  });

  test("exit 2 for refused input", () => {
    expect(run(new Uint8Array([1, 2, 3]), [region("text")]).code).toBe(2);
    const outside = run(sample(0x000000, 0xffffff), [region("text", { x: 0, y: 0, width: 7, height: 4 })]);
    expect([outside.code, outside.err.trim()]).toEqual([2, "REFUSED region Test pair is outside the 6x4 image"]);
    const usage = Bun.spawnSync([process.execPath, SCRIPT], { stdin: "ignore", timeout: CLI_TIMEOUT_MS });
    expect(usage.exitCode).toBe(2);
    const missing = Bun.spawnSync([process.execPath, SCRIPT, join(dir, "absent.png"), join(dir, "absent.json")], { stdin: "ignore", timeout: CLI_TIMEOUT_MS });
    expect(missing.exitCode).toBe(2);
  });
});
