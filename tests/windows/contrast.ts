// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Measures WCAG 2.2 contrast in a capture (T179). Usage: `bun tests/windows/contrast.ts <capture.png> <regions.json>`.
// Exit 0: every region passes. Exit 1: a region is below its threshold. Exit 2: refused input.

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { decodeStrictJson, isObject } from "../../src/contracts/strict-json";

export class Refused extends Error {}

export interface Image {
  width: number;
  height: number;
  // Opaque 8-bit RGB, 3 bytes per pixel, row-major.
  rgb: Uint8Array;
}

export type Kind = "text" | "non-text";

export interface Region {
  pair: string;
  kind: Kind;
  box: { x: number; y: number; width: number; height: number };
}

export interface Measurement {
  region: Region;
  foreground: number;
  background: number;
  ratio: number;
  pass: boolean;
}

// WCAG 2.2 SC 1.4.3 (text) and SC 1.4.11 (non-text). A ratio below the threshold fails, without rounding.
export const THRESHOLD: Record<Kind, number> = { text: 4.5, "non-text": 3 };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// PNG spec 11.2: critical chunks. PLTE is optional for color types 2 and 6 and carries no pixel data there.
const CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);

const refuse = (message: string): never => {
  throw new Refused(message);
};

// PNG (Third Edition) subset: bit depth 8, color type 2 (RGB) or 6 (RGBA), no interlace. RGBA needs alpha 255 on every pixel.
export function decodePng(bytes: Uint8Array): Image {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) refuse("not a PNG signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; channels: number } | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (!ended) {
    if (at + 12 > bytes.length) refuse("truncated chunk");
    const length = view.getUint32(at);
    if (length > 0x7fffffff || at + 12 + length > bytes.length) refuse("truncated chunk");
    const typeAndData = bytes.subarray(at + 4, at + 8 + length);
    const type = String.fromCharCode(...typeAndData.subarray(0, 4));
    const data = typeAndData.subarray(4);
    if (view.getUint32(at + 8 + length) !== Bun.hash.crc32(typeAndData)) refuse(`bad CRC in ${type}`);
    at += 12 + length;
    if (header === null && type !== "IHDR") refuse("first chunk is not IHDR");
    if (type === "IHDR") {
      if (header !== null || length !== 13) refuse("bad IHDR");
      const width = view.getUint32(data.byteOffset - bytes.byteOffset);
      const height = view.getUint32(data.byteOffset - bytes.byteOffset + 4);
      const [depth, color, compression, filter, interlace] = data.subarray(8);
      if (width === 0 || height === 0) refuse("zero image size");
      if (depth !== 8 || (color !== 2 && color !== 6)) refuse(`unsupported bit depth ${depth} or color type ${color}`);
      if (compression !== 0 || filter !== 0) refuse("unsupported compression or filter method");
      if (interlace !== 0) refuse("interlaced PNG");
      header = { width, height, channels: color === 6 ? 4 : 3 };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") ended = true;
    else if (!CRITICAL.has(type) && (type.charCodeAt(0) & 0x20) === 0) refuse(`unknown critical chunk ${type}`);
  }
  if (header === null || idat.length === 0) refuse("no image data");
  const { width, height, channels } = header!;
  const stride = width * channels;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return refuse("bad zlib data");
  }
  if (raw.length !== height * (stride + 1)) refuse("image data size does not match IHDR");

  // PNG spec 7.3 and 9: reverse the per-scanline filters in place.
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = up ? up[i]! : 0;
      const c = up && i >= channels ? up[i - channels]! : 0;
      let predictor: number;
      if (filterType === 0) predictor = 0;
      else if (filterType === 1) predictor = a;
      else if (filterType === 2) predictor = b;
      else if (filterType === 3) predictor = (a + b) >> 1;
      else if (filterType === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else return refuse(`bad filter type ${filterType}`);
      row[i] = (src[i]! + predictor) & 0xff;
    }
  }

  if (channels === 3) return { width, height, rgb: pixels };
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    if (pixels[p * 4 + 3] !== 255) refuse(`non-opaque pixel at ${p % width},${Math.floor(p / width)}`);
    rgb.set(pixels.subarray(p * 4, p * 4 + 3), p * 3);
  }
  return { width, height, rgb };
}

// WCAG 2.2 "relative luminance" definition, for a 0xRRGGBB sRGB color.
export function relativeLuminance(color: number): number {
  const linear = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear((color >> 16) & 0xff) + 0.7152 * linear((color >> 8) & 0xff) + 0.0722 * linear(color & 0xff);
}

// WCAG 2.2 "contrast ratio" definition: (L1 + 0.05) / (L2 + 0.05), with L1 the lighter color.
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const hex = (color: number) => `#${color.toString(16).toUpperCase().padStart(6, "0")}`;

export function parseRegions(bytes: Uint8Array): Region[] {
  const decoded = decodeStrictJson(bytes);
  if (!decoded.ok || !Array.isArray(decoded.value) || decoded.value.length === 0) return refuse("regions file must be a non-empty JSON array");
  return decoded.value.map((entry, i) => {
    if (!isObject(entry) || Object.keys(entry).sort().join() !== "box,kind,pair") return refuse(`region ${i} must have exactly pair, kind, and box`);
    const { pair, kind, box } = entry;
    if (typeof pair !== "string" || pair.length === 0) return refuse(`region ${i} has no pair name`);
    if (kind !== "text" && kind !== "non-text") return refuse(`region ${i} kind must be text or non-text`);
    if (!isObject(box) || Object.keys(box).sort().join() !== "height,width,x,y") return refuse(`region ${i} box must have exactly x, y, width, and height`);
    const { x, y, width, height } = box;
    for (const v of [x, y, width, height]) if (!Number.isSafeInteger(v) || (v as number) < 0) refuse(`region ${i} box values must be non-negative integers`);
    if ((width as number) === 0 || (height as number) === 0) refuse(`region ${i} box is empty`);
    return { pair, kind, box: { x, y, width, height } as Region["box"] };
  });
}

// T179: the background is the most frequent color in the box. The foreground is the box color with the highest contrast against it.
export function measure(image: Image, region: Region): Measurement {
  const { x, y, width, height } = region.box;
  if (x + width > image.width || y + height > image.height) refuse(`region ${region.pair} is outside the ${image.width}x${image.height} image`);
  const counts = new Map<number, number>();
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) {
      const p = (row * image.width + col) * 3;
      const color = (image.rgb[p]! << 16) | (image.rgb[p + 1]! << 8) | image.rgb[p + 2]!;
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
  }
  const top = Math.max(...counts.values());
  const tops = [...counts].filter(([, n]) => n === top);
  if (tops.length > 1) refuse(`region ${region.pair} has no single most frequent color: ${tops.map(([c]) => hex(c)).join(" ")}`);
  const background = tops[0]![0];
  let foreground = background;
  let ratio = 1;
  for (const color of counts.keys()) {
    const r = contrastRatio(color, background);
    if (r > ratio) [foreground, ratio] = [color, r];
  }
  return { region, foreground, background, ratio, pass: ratio >= THRESHOLD[region.kind] };
}

export const formatMeasurement = (m: Measurement) =>
  `${m.pass ? "PASS" : "FAIL"} ${m.ratio.toFixed(2)}:1 ${m.region.kind} fg ${hex(m.foreground)} bg ${hex(m.background)} ${m.region.pair}`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 2) refuse("usage: bun tests/windows/contrast.ts <capture.png> <regions.json>");
    const image = decodePng(readFileSync(args[0]!));
    const results = parseRegions(readFileSync(args[1]!)).map((r) => measure(image, r));
    for (const m of results) console.log(formatMeasurement(m));
    process.exit(results.every((m) => m.pass) ? 0 : 1);
  } catch (error) {
    console.error(`REFUSED ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
