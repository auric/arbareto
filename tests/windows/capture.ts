// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// T242: test-only capture source (plan.md "Capture source"). DXGI Desktop Duplication of the output at desktop origin (0,0), the primary output.
// Usage:
//   bun tests/windows/capture.ts --region <x,y,w,h> --out <dir> [--limit 30|60|90] [--mask <file>] [--launch <exe> [arguments]]
//   bun tests/windows/capture.ts --calibrate --region <x,y,w,h> --out <dir>
//   bun tests/windows/capture.ts --analyze <dir> --start <qpc> [--settled <hash>]
// A run writes `frames.json` and `settled.png` into <dir>. `--analyze` applies the start event of `inject.ts` or the T244 helper.

import { CFunction, dlopen, FFIType, JSCallback, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { qpc, qpcFrequency } from "./inject";

type Code = "BAD_ARGUMENT" | "NOT_WINDOWS" | "COM_FAILED" | "ACCESS_LOST" | "NO_REFRESH_RATE" | "ROTATED" | "DPI_SCALED" | "POINTER" | "NO_DISPLAY_STATE";

export class CaptureError extends Error {
  constructor(
    readonly code: Code,
    detail: string,
    readonly hresult?: number,
  ) {
    super(`${code}: ${detail}`);
  }
}

// ---- Analysis (plan.md "Capture source" terms) ----

export interface Frame {
  lastPresentTime: bigint;
  accumulatedFrames: number;
  hash: string;
}

export type Cause = "access-lost" | "secure-desktop" | "no-region-change" | "settled-hash";
export type InvalidKind = "one-off" | "repeatable";
const KIND: Record<Cause, InvalidKind> = { "access-lost": "one-off", "secure-desktop": "one-off", "no-region-change": "repeatable", "settled-hash": "repeatable" };

export type RunResult = { valid: true; settled: Frame; end: Frame; seconds: number; u: number } | { valid: false; cause: Cause; kind: InvalidKind };

export interface Timing {
  frequency: bigint;
  // Δ in seconds.
  delta: number;
}

const SETTLE_SECONDS = 3n;
export const LIMITS = [30, 60, 90] as const;
const CALIBRATE_SECONDS = 5n;

export function deltaSeconds(numerator: number, denominator: number): number {
  if (!(numerator > 0 && denominator > 0)) throw new CaptureError("NO_REFRESH_RATE", `refresh rate ${numerator}/${denominator}`);
  return denominator / numerator;
}

const invalid = (cause: Cause): RunResult => ({ valid: false, cause, kind: KIND[cause] });

// `frames` holds every recorded frame of one run in order; the first one precedes the start event.
export function analyzeRun(frames: Frame[], start: bigint, timing: Timing, expectedSettled?: string, failure?: "access-lost" | "secure-desktop"): RunResult {
  if (failure !== undefined) return invalid(failure);
  if (frames.length === 0) return invalid("no-region-change");
  const settled = frames.at(-1)!;
  let first = frames.length - 1;
  while (first > 0 && frames[first - 1]!.hash === settled.hash) first--;
  const end = frames[first]!;
  if (first === 0 || end.lastPresentTime <= start) return invalid("no-region-change");
  if (expectedSettled !== undefined && settled.hash !== expectedSettled) return invalid("settled-hash");
  const frequency = Number(timing.frequency);
  const gap = Number(end.lastPresentTime - frames[first - 1]!.lastPresentTime) / frequency;
  return { valid: true, settled, end, seconds: Number(end.lastPresentTime - start) / frequency, u: end.accumulatedFrames > 1 && gap > timing.delta ? gap : timing.delta };
}

// The capture loop ends 3 seconds after the last region change, or at the run limit.
export function stopReason(frames: Frame[], now: bigint, first: bigint, frequency: bigint, limit: number): "settled" | "limit" | null {
  let last = frames.length - 1;
  while (last > 0 && frames[last - 1]!.hash === frames[last]!.hash) last--;
  if (last > 0 && now - frames[last]!.lastPresentTime >= SETTLE_SECONDS * frequency) return "settled";
  if (now - first >= BigInt(limit) * frequency) return "limit";
  return null;
}

export interface BlockRun {
  warmup: boolean;
  result: RunResult;
}

export type BlockStatus = { state: "open"; remaining: number; added: number } | { state: "complete"; added: number } | { state: "ended"; label: "missed" | "unverified"; cause: Cause; causes: Cause[] };

// A fourth invalid run ends a block, so at most 3 runs are added.
const MAX_INVALID = 3;

// plan.md "Invalid capture". `runs` holds the warm-up run and the counted runs of one block, in order.
export function blockStatus(app: "arbareto" | "git-extensions", counted: number, runs: BlockRun[]): BlockStatus {
  const causes: Cause[] = [];
  const repeats = new Map<Cause, number>();
  let added = 0;
  let recorded = 0;
  for (let i = 0; i < runs.length; i++) {
    if (recorded === counted + added && i > 0) throw new CaptureError("BAD_ARGUMENT", `run ${i} follows the end of the block`);
    const { warmup, result } = runs[i]!;
    if (!warmup) recorded++;
    if (result.valid) continue;
    causes.push(result.cause);
    if (!warmup) added++;
    const repeated = result.kind === "repeatable" && (repeats.set(result.cause, (repeats.get(result.cause) ?? 0) + 1).get(result.cause) ?? 0) >= 2;
    if (repeated || causes.length > MAX_INVALID) {
      if (i < runs.length - 1) throw new CaptureError("BAD_ARGUMENT", `run ${i + 1} follows the end of the block`);
      // A repeated no-region-change in Arbareto runs is an Arbareto defect (spec Clarifications, 2026-10-01). A fourth invalid run alone gives unverified.
      return { state: "ended", label: repeated && result.cause === "no-region-change" && app === "arbareto" ? "missed" : "unverified", cause: result.cause, causes };
    }
  }
  const remaining = counted + added - recorded;
  return remaining === 0 ? { state: "complete", added } : { state: "open", remaining, added };
}

// ---- Mask, hash, PNG ----

const BYTES_PER_PIXEL = 4;

export function buildMask(images: Uint8Array[], width: number, height: number): Uint8Array {
  const size = width * height * BYTES_PER_PIXEL;
  if (images.length === 0 || images.some((image) => image.length !== size)) throw new CaptureError("BAD_ARGUMENT", `each image needs ${size} bytes`);
  const mask = new Uint8Array(width * height);
  const base = images[0]!;
  for (const image of images.slice(1)) {
    for (let i = 0; i < size; i++) if (image[i] !== base[i]) mask[(i / BYTES_PER_PIXEL) | 0] = 1;
  }
  return mask;
}

export function applyMask(image: Uint8Array, mask: Uint8Array): Uint8Array {
  const out = Uint8Array.from(image);
  for (let p = 0; p < mask.length; p++) if (mask[p] === 1) out.fill(0, p * BYTES_PER_PIXEL, (p + 1) * BYTES_PER_PIXEL);
  return out;
}

export function hashImage(image: Uint8Array, mask: Uint8Array | null): string {
  return new Bun.CryptoHasher("sha256").update(mask === null ? image : applyMask(image, mask)).digest("hex");
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(4 + body.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

// PNG color type 6 (RGBA, 8 bits), filter type 0 on each row. The desktop image is BGRA.
export function encodePng(bgra: Uint8Array, width: number, height: number): Buffer {
  const rows = Buffer.alloc(height * (1 + width * BYTES_PER_PIXEL));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * BYTES_PER_PIXEL);
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * BYTES_PER_PIXEL;
      const to = at + 1 + x * BYTES_PER_PIXEL;
      rows[to] = bgra[from + 2]!;
      rows[to + 1] = bgra[from + 1]!;
      rows[to + 2] = bgra[from]!;
      rows[to + 3] = bgra[from + 3]!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array(0))]);
}

// ---- Arguments ----

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Args = { mode: "run" | "calibrate"; region: Region; limit: number; out: string; mask: string | null; launch: string[] | null } | { mode: "analyze"; out: string; start: bigint; settled: string | null };

export function parseArgs(argv: string[]): Args {
  const bad = (detail: string) => new CaptureError("BAD_ARGUMENT", detail);
  const values: Record<string, string> = {};
  let calibrate = false;
  let launch: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--calibrate") calibrate = true;
    else if (arg === "--launch") {
      launch = argv.slice(i + 1);
      if (launch.length === 0) throw bad("--launch needs an executable");
      break;
    } else if (["--region", "--out", "--limit", "--mask", "--analyze", "--start", "--settled"].includes(arg) && argv[i + 1] !== undefined) values[arg] = argv[++i]!;
    else throw bad(`unknown argument ${arg}`);
  }
  if (values["--analyze"] !== undefined) {
    if (!/^\d+$/.test(values["--start"] ?? "")) throw bad("--analyze needs --start <qpc>");
    return { mode: "analyze", out: values["--analyze"], start: BigInt(values["--start"]!), settled: values["--settled"] ?? null };
  }
  const region = /^(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(values["--region"] ?? "");
  if (!region || Number(region[3]) === 0 || Number(region[4]) === 0) throw bad("--region needs x,y,w,h with w and h above 0");
  if (values["--out"] === undefined) throw bad("--out is missing");
  const limit = Number(values["--limit"] ?? 30);
  if (!(LIMITS as readonly number[]).includes(limit)) throw bad(`--limit must be one of ${LIMITS.join(", ")} (plan.md "Run limit")`);
  return { mode: calibrate ? "calibrate" : "run", region: { x: Number(region[1]), y: Number(region[2]), width: Number(region[3]), height: Number(region[4]) }, limit, out: values["--out"], mask: values["--mask"] ?? null, launch };
}

// ---- DXGI Desktop Duplication through bun:ffi ----

const { ptr: P, u32, i32, void: V } = FFIType;
const open = () => ({
  dxgi: dlopen("dxgi.dll", { CreateDXGIFactory1: { args: [P, P], returns: i32 } }).symbols,
  d3d11: dlopen("d3d11.dll", { D3D11CreateDevice: { args: [P, u32, P, u32, P, u32, u32, P, P, P], returns: i32 } }).symbols,
  user32: dlopen("user32.dll", {
    GetCursorPos: { args: [P], returns: i32 },
    SetCursorPos: { args: [i32, i32], returns: i32 },
    SetProcessDpiAwarenessContext: { args: [FFIType.i64], returns: i32 },
  }).symbols,
  kernel32: dlopen("kernel32.dll", { SetThreadExecutionState: { args: [u32], returns: u32 } }).symbols,
  powrprof: dlopen("powrprof.dll", {
    PowerSettingRegisterNotification: { args: [P, u32, P, P], returns: u32 },
    PowerSettingUnregisterNotification: { args: [P], returns: u32 },
  }).symbols,
});
let dlls: ReturnType<typeof open> | undefined;
// `windef.h` DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. A DPI-unaware process gets scaled `DesktopCoordinates` and cursor positions, so regions use physical pixels only after this call.
const PER_MONITOR_AWARE_V2 = -4n;

// The DLLs exist only on Windows, so the import of this file must not open them.
function lib(): ReturnType<typeof open> {
  if (process.platform !== "win32") throw new CaptureError("NOT_WINDOWS", "desktop duplication needs Windows");
  return (dlls ??= open());
}

// Windows SDK 10.0.26100.0 `dxgi.h`, `dxgi1_2.h`, `d3d11.h`: GUIDs and the C vtable slot of each method.
const IID_IDXGIFactory1 = "770aae78-f26f-4dba-a829-253c83d1b387";
const IID_IDXGIOutput1 = "00cddea8-939b-4b83-a340-a685226666cc";
const IID_ID3D11Texture2D = "6f15aaf2-d208-4e89-9ab4-489535d34f9c";
const SLOT = {
  QueryInterface: 0,
  Release: 2,
  // IDXGIFactory1
  EnumAdapters1: 12,
  // IDXGIAdapter1
  EnumOutputs: 7,
  AdapterGetDesc: 8,
  // IDXGIOutput1
  OutputGetDesc: 7,
  DuplicateOutput: 22,
  // IDXGIOutputDuplication
  DuplicationGetDesc: 7,
  AcquireNextFrame: 8,
  ReleaseFrame: 14,
  // ID3D11Device
  CreateTexture2D: 5,
  // ID3D11DeviceContext
  Map: 14,
  Unmap: 15,
  CopySubresourceRegion: 46,
} as const;
// `winerror.h`.
const DXGI_ERROR_NOT_FOUND = 0x887a0002;
const DXGI_ERROR_UNSUPPORTED = 0x887a0004;
const DXGI_ERROR_NOT_CURRENTLY_AVAILABLE = 0x887a0022;
const DXGI_ERROR_ACCESS_LOST = 0x887a0026;
const DXGI_ERROR_WAIT_TIMEOUT = 0x887a0027;
const DXGI_ERROR_SESSION_DISCONNECTED = 0x887a0028;
const E_ACCESSDENIED = 0x80070005;
// Microsoft Learn "IDXGIOutput1::DuplicateOutput": these results name a missing capability of the session.
const CAPABILITY: Record<number, string> = {
  [E_ACCESSDENIED]: "access to the current desktop (secure desktop)",
  [DXGI_ERROR_UNSUPPORTED]: "desktop duplication in this session (remote session)",
  [DXGI_ERROR_NOT_CURRENTLY_AVAILABLE]: "a free desktop duplication slot (four processes duplicate)",
  [DXGI_ERROR_SESSION_DISCONNECTED]: "a connected session",
};
const D3D_DRIVER_TYPE_UNKNOWN = 0;
const D3D11_SDK_VERSION = 7;
const DXGI_FORMAT_B8G8R8A8_UNORM = 87;
const DXGI_MODE_ROTATION_IDENTITY = 1;
const D3D11_USAGE_STAGING = 3;
const D3D11_CPU_ACCESS_READ = 0x20000;
const D3D11_MAP_READ = 1;
// x64 struct sizes: DXGI_OUTPUT_DESC 96, DXGI_ADAPTER_DESC 304, DXGI_OUTDUPL_DESC 36, DXGI_OUTDUPL_FRAME_INFO 48, D3D11_TEXTURE2D_DESC 44, D3D11_BOX 24, D3D11_MAPPED_SUBRESOURCE 16.
const OUTPUT_DESC_BYTES = 96;
const ADAPTER_DESC_BYTES = 304;
const DUPL_DESC_BYTES = 36;
const FRAME_INFO_BYTES = 48;

function guid(text: string): Buffer {
  const hex = text.replaceAll("-", "");
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0);
  bytes.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4);
  bytes.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6);
  Buffer.from(hex.slice(16), "hex").copy(bytes, 8);
  return bytes;
}

// ---- Display power state ----

// `winbase.h` ES_CONTINUOUS and ES_DISPLAY_REQUIRED. The request holds for the calling thread until `releaseDisplay`.
const ES_CONTINUOUS = 0x80000000;
const ES_DISPLAY_REQUIRED = 0x00000002;

export function keepDisplayOn(): void {
  if (lib().kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED) === 0) throw new CaptureError("NO_DISPLAY_STATE", "SetThreadExecutionState failed");
}

export function releaseDisplay(): void {
  if (lib().kernel32.SetThreadExecutionState(ES_CONTINUOUS) === 0) throw new CaptureError("NO_DISPLAY_STATE", "SetThreadExecutionState failed");
}

// Power setting GUIDs: GUID_CONSOLE_DISPLAY_STATE carries 0 (off), 1 (on), or 2 (dimmed).
const GUID_CONSOLE_DISPLAY_STATE = "6fe69556-704a-47a0-8f24-c28d936fda47";
export const DISPLAY_OFF = 0;
// `winuser.h` DEVICE_NOTIFY_CALLBACK and PBT_POWERSETTINGCHANGE.
const DEVICE_NOTIFY_CALLBACK = 2;
const PBT_POWERSETTINGCHANGE = 0x8013;
// `winuser.h` POWERBROADCAST_SETTING: PowerSetting GUID (16 bytes), DataLength (u32), Data.
const SETTING_DATA_OFFSET = 20;
// Safety cap only. The first callback arrived after about 10 ms in a probe.
const DISPLAY_STATE_WAIT_MS = 2000;

// The registration calls back once with the current value (PowerSettingRegisterNotification docs).
export async function displayState(): Promise<number> {
  const { powrprof } = lib();
  let value: number | undefined;
  const callback = new JSCallback(
    (_context: Pointer, type: number, setting: Pointer) => {
      if (type === PBT_POWERSETTINGCHANGE) value ??= read.u32(setting, SETTING_DATA_OFFSET);
      return 0;
    },
    { args: [P, u32, P], returns: u32, threadsafe: true },
  );
  try {
    const setting = guid(GUID_CONSOLE_DISPLAY_STATE);
    // `powrprof.h` DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS: Callback, Context.
    const parameters = new BigUint64Array([BigInt(callback.ptr!), 0n]);
    const handle = new BigUint64Array(1);
    const result = powrprof.PowerSettingRegisterNotification(ptr(setting), DEVICE_NOTIFY_CALLBACK, ptr(parameters), ptr(handle));
    if (result !== 0) throw new CaptureError("NO_DISPLAY_STATE", `PowerSettingRegisterNotification returned ${result}`);
    try {
      for (const end = performance.now() + DISPLAY_STATE_WAIT_MS; value === undefined && performance.now() < end; ) await Bun.sleep(10);
    } finally {
      powrprof.PowerSettingUnregisterNotification(Number(handle[0]) as Pointer);
    }
  } finally {
    callback.close();
  }
  if (value === undefined) throw new CaptureError("NO_DISPLAY_STATE", `no GUID_CONSOLE_DISPLAY_STATE callback within ${DISPLAY_STATE_WAIT_MS} ms`);
  return value;
}

const methods = new Map<string, (...args: unknown[]) => number>();

function call(self: Pointer, slot: number, args: FFIType[], values: unknown[], returns: FFIType = i32): number {
  const fn = read.ptr(read.ptr(self, 0) as Pointer, slot * 8) as Pointer;
  const key = `${fn}:${args.join(",")}:${returns}`;
  let method = methods.get(key);
  if (!method) methods.set(key, (method = CFunction({ ptr: fn, args: [P, ...args], returns }) as never));
  return method(self, ...values);
}

function hr(name: string, result: number): void {
  if (result < 0) throw new CaptureError("COM_FAILED", `${name} returned 0x${(result >>> 0).toString(16)}`, result >>> 0);
}

const release = (self: Pointer | null) => void (self !== null && call(self, SLOT.Release, [], [], u32));

// Calls a method whose last parameter receives an interface pointer. `hr` is the signed HRESULT.
function out(self: Pointer, slot: number, args: FFIType[], values: unknown[]): { hr: number; ptr: Pointer } {
  const value = new BigUint64Array(1);
  const result = call(self, slot, [...args, P], [...values, ptr(value)]);
  return { hr: result, ptr: Number(value[0]) as Pointer };
}

function must(name: string, result: { hr: number; ptr: Pointer }): Pointer {
  hr(name, result.hr);
  return result.ptr;
}

function accessLost(name: string, result: number): number {
  if (result >>> 0 === DXGI_ERROR_ACCESS_LOST) throw new CaptureError("ACCESS_LOST", `${name} returned DXGI_ERROR_ACCESS_LOST`, result >>> 0);
  return result;
}

const wide = (bytes: Buffer, at: number, chars: number) => bytes.toString("utf16le", at, at + chars * 2).replace(/\0.*$/s, "");

export interface RawFrame {
  lastPresentTime: bigint;
  accumulatedFrames: number;
  image: Uint8Array;
}

// Captures one fixed region. `openDuplication` checks the region against the output once and creates the staging texture once.
export class Duplication {
  constructor(
    readonly adapter: string,
    readonly output: { name: string; rect: { left: number; top: number; right: number; bottom: number } },
    readonly mode: { width: number; height: number; numerator: number; denominator: number },
    readonly region: Region,
    private readonly device: Pointer,
    private readonly context: Pointer,
    private readonly dup: Pointer,
    private readonly staging: Pointer,
  ) {}

  // Null on a time-out and on a pointer-only update (`LastPresentTime` 0).
  acquire(timeoutMs: number): RawFrame | null {
    const info = Buffer.alloc(FRAME_INFO_BYTES);
    const resource = new BigUint64Array(1);
    const result = accessLost("AcquireNextFrame", call(this.dup, SLOT.AcquireNextFrame, [u32, P, P], [timeoutMs, ptr(info), ptr(resource)]));
    if (result >>> 0 === DXGI_ERROR_WAIT_TIMEOUT) return null;
    hr("AcquireNextFrame", result);
    const lastPresentTime = info.readBigInt64LE(0);
    const accumulatedFrames = info.readUInt32LE(16);
    const desktop = Number(resource[0]) as Pointer;
    try {
      if (lastPresentTime === 0n) return null;
      const texture = must("QueryInterface ID3D11Texture2D", out(desktop, SLOT.QueryInterface, [P], [ptr(guid(IID_ID3D11Texture2D))]));
      try {
        const { x, y, width, height } = this.region;
        const { left, top } = this.output.rect;
        const box = Buffer.alloc(24);
        [x - left, y - top, 0, x - left + width, y - top + height, 1].forEach((v, i) => box.writeUInt32LE(v, i * 4));
        call(this.context, SLOT.CopySubresourceRegion, [P, u32, u32, u32, u32, P, u32, P], [this.staging, 0, 0, 0, 0, texture, 0, ptr(box)], V);
      } finally {
        release(texture);
      }
      // Map waits for the copy, so the frame stays held until the bytes are read.
      return { lastPresentTime, accumulatedFrames, image: this.readStaging() };
    } finally {
      release(desktop);
      hr("ReleaseFrame", accessLost("ReleaseFrame", call(this.dup, SLOT.ReleaseFrame, [], [])));
    }
  }

  private readStaging(): Uint8Array {
    const { width, height } = this.region;
    const mapped = Buffer.alloc(16);
    hr("Map", call(this.context, SLOT.Map, [P, u32, u32, u32, P], [this.staging, 0, D3D11_MAP_READ, 0, ptr(mapped)]));
    try {
      const data = Number(mapped.readBigUInt64LE(0)) as Pointer;
      const pitch = mapped.readUInt32LE(8);
      const row = width * BYTES_PER_PIXEL;
      const image = new Uint8Array(row * height);
      for (let y = 0; y < height; y++) image.set(new Uint8Array(toArrayBuffer(data, y * pitch, row)), y * row);
      return image;
    } finally {
      call(this.context, SLOT.Unmap, [P, u32], [this.staging, 0], V);
    }
  }

  close(): void {
    release(this.staging);
    release(this.dup);
    release(this.context);
    release(this.device);
  }
}

export type Opened = { dup: Duplication } | { skip: string; hresult: number | null };

// The reference output is the attached output at desktop origin (0,0), the primary output.
// The DPI awareness call applies to the whole process, the `bun test` process included.
export function openDuplication(region: Region): Opened {
  const { dxgi, d3d11, user32 } = lib();
  // The call fails when the process already has an awareness. The mode check below then refuses scaled coordinates.
  user32.SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2);
  const factoryOut = new BigUint64Array(1);
  hr("CreateDXGIFactory1", dxgi.CreateDXGIFactory1(ptr(guid(IID_IDXGIFactory1)), ptr(factoryOut)));
  const factory = Number(factoryOut[0]) as Pointer;
  try {
    for (let a = 0; ; a++) {
      const adapter = out(factory, SLOT.EnumAdapters1, [u32], [a]);
      if (adapter.hr >>> 0 === DXGI_ERROR_NOT_FOUND) return { skip: "an attached output at desktop origin (0,0)", hresult: null };
      const adapterPtr = must("EnumAdapters1", adapter);
      try {
        for (let o = 0; ; o++) {
          const output = out(adapterPtr, SLOT.EnumOutputs, [u32], [o]);
          if (output.hr >>> 0 === DXGI_ERROR_NOT_FOUND) break;
          const outputPtr = must("EnumOutputs", output);
          try {
            const desc = Buffer.alloc(OUTPUT_DESC_BYTES);
            hr("IDXGIOutput::GetDesc", call(outputPtr, SLOT.OutputGetDesc, [P], [ptr(desc)]));
            const rect = { left: desc.readInt32LE(64), top: desc.readInt32LE(68), right: desc.readInt32LE(72), bottom: desc.readInt32LE(76) };
            if (desc.readInt32LE(80) === 0 || rect.left !== 0 || rect.top !== 0) continue;
            if (region.x < rect.left || region.y < rect.top || region.x + region.width > rect.right || region.y + region.height > rect.bottom) {
              throw new CaptureError("BAD_ARGUMENT", `region ${JSON.stringify(region)} is outside the output ${JSON.stringify(rect)}`);
            }
            const adapterDesc = Buffer.alloc(ADAPTER_DESC_BYTES);
            hr("IDXGIAdapter::GetDesc", call(adapterPtr, SLOT.AdapterGetDesc, [P], [ptr(adapterDesc)]));
            return duplicate(adapterPtr, outputPtr, wide(adapterDesc, 0, 128), { name: wide(desc, 0, 32), rect });
          } finally {
            release(outputPtr);
          }
        }
      } finally {
        release(adapterPtr);
      }
    }
  } finally {
    release(factory);
  }

  function duplicate(adapter: Pointer, output: Pointer, adapterName: string, info: Duplication["output"]): Opened {
    const device = new BigUint64Array(1);
    const context = new BigUint64Array(1);
    hr("D3D11CreateDevice", d3d11.D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, null, 0, null, 0, D3D11_SDK_VERSION, ptr(device), null, ptr(context)));
    // Released in reverse order unless the Duplication takes them.
    const owned: Pointer[] = [Number(device[0]) as Pointer, Number(context[0]) as Pointer];
    try {
      const output1 = must("QueryInterface IDXGIOutput1", out(output, SLOT.QueryInterface, [P], [ptr(guid(IID_IDXGIOutput1))]));
      let dup: { hr: number; ptr: Pointer };
      try {
        dup = out(output1, SLOT.DuplicateOutput, [P], [owned[0]]);
      } finally {
        release(output1);
      }
      const capability = CAPABILITY[dup.hr >>> 0];
      if (dup.hr < 0 && capability !== undefined) return { skip: `${capability}: DuplicateOutput returned 0x${(dup.hr >>> 0).toString(16)}`, hresult: dup.hr >>> 0 };
      owned.push(must("DuplicateOutput", dup));
      const desc = Buffer.alloc(DUPL_DESC_BYTES);
      call(owned[2]!, SLOT.DuplicationGetDesc, [P], [ptr(desc)], V);
      const mode = { width: desc.readUInt32LE(0), height: desc.readUInt32LE(4), numerator: desc.readUInt32LE(8), denominator: desc.readUInt32LE(12) };
      const rotation = desc.readUInt32LE(28);
      if (rotation !== DXGI_MODE_ROTATION_IDENTITY) throw new CaptureError("ROTATED", `output rotation ${rotation}`);
      if (mode.width !== info.rect.right - info.rect.left || mode.height !== info.rect.bottom - info.rect.top) {
        throw new CaptureError("DPI_SCALED", `output ${JSON.stringify(info.rect)} differs from mode ${mode.width}x${mode.height}`);
      }
      const texture = Buffer.alloc(44);
      [region.width, region.height, 1, 1, DXGI_FORMAT_B8G8R8A8_UNORM, 1, 0, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ, 0].forEach((v, i) => texture.writeUInt32LE(v, i * 4));
      owned.push(must("CreateTexture2D", out(owned[0]!, SLOT.CreateTexture2D, [P, P], [ptr(texture), null])));
      const result = new Duplication(adapterName, info, mode, region, owned[0]!, owned[1]!, owned[2]!, owned[3]!);
      owned.length = 0;
      return { dup: result };
    } finally {
      for (const p of owned.toReversed()) release(p);
    }
  }
}

// ---- Command line ----

// Moves the pointer to the bottom-right pixel of the output when it lies in the region.
function parkPointer(dup: Duplication): void {
  const { user32 } = lib();
  const { region } = dup;
  const point = new Int32Array(2);
  user32.GetCursorPos(ptr(point));
  const inside = (x: number, y: number) => x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height;
  if (!inside(point[0]!, point[1]!)) return;
  const x = dup.output.rect.right - 1;
  const y = dup.output.rect.bottom - 1;
  if (inside(x, y)) throw new CaptureError("POINTER", "the region covers the bottom-right pixel of the output");
  user32.SetCursorPos(x, y);
}

interface FramesFile {
  frequency: string;
  delta: number;
  failure: "access-lost" | null;
  frames: { lastPresentTime: string; accumulatedFrames: number; hash: string }[];
}

function analyzeFile(dir: string, start: bigint, settled: string | null): RunResult {
  const file = JSON.parse(readFileSync(join(dir, "frames.json"), "utf8")) as FramesFile;
  const frames = file.frames.map((f) => ({ ...f, lastPresentTime: BigInt(f.lastPresentTime) }));
  return analyzeRun(frames, start, { frequency: BigInt(file.frequency), delta: file.delta }, settled ?? undefined, file.failure ?? undefined);
}

function printResult(result: RunResult): void {
  if (result.valid) console.log(`END qpc=${result.end.lastPresentTime} seconds=${result.seconds} u=${result.u} accumulated=${result.end.accumulatedFrames} settled=${result.settled.hash}`);
  else console.log(`CAPTURE_INVALID cause=${result.cause} kind=${result.kind}`);
}

async function main(args: Args): Promise<number> {
  if (args.mode === "analyze") {
    printResult(analyzeFile(args.out, args.start, args.settled));
    return 0;
  }
  const opened = openDuplication(args.region);
  if ("skip" in opened) {
    console.log(`CAPTURE_UNAVAILABLE ${opened.skip}`);
    // The capture cannot start on the secure desktop, so the run is a one-off failure of the desktop.
    if (opened.hresult === E_ACCESSDENIED) printResult(analyzeRun([], 0n, { frequency: 1n, delta: 0 }, undefined, "secure-desktop"));
    return 4;
  }
  const dup = opened.dup;
  try {
    const frequency = qpcFrequency();
    const delta = deltaSeconds(dup.mode.numerator, dup.mode.denominator);
    console.log(`ADAPTER ${dup.adapter}`);
    console.log(`OUTPUT ${dup.output.name} ${JSON.stringify(dup.output.rect)}`);
    console.log(`MODE ${dup.mode.width}x${dup.mode.height} refresh=${dup.mode.numerator}/${dup.mode.denominator}`);
    console.log(`DELTA_MS ${delta * 1000}`);
    const { region } = args;
    mkdirSync(args.out, { recursive: true });
    parkPointer(dup);
    if (args.mode === "calibrate") {
      const images: Uint8Array[] = [];
      const first = qpc();
      while (qpc() - first < CALIBRATE_SECONDS * frequency) {
        const got = dup.acquire(100);
        if (got !== null) images.push(got.image);
      }
      const mask = buildMask(images, region.width, region.height);
      writeFileSync(join(args.out, "mask.bin"), mask);
      console.log(`MASK ${join(args.out, "mask.bin")} frames=${images.length} masked=${mask.reduce((n, v) => n + v, 0)}`);
      return 0;
    }
    const mask = args.mask === null ? null : new Uint8Array(readFileSync(args.mask));
    if (mask !== null && mask.length !== region.width * region.height) throw new CaptureError("BAD_ARGUMENT", `mask ${args.mask} does not match the region`);
    const frames: Frame[] = [];
    let last: Uint8Array | null = null;
    let failure: "access-lost" | null = null;
    let start: bigint | null = null;
    const first = qpc();
    // False after DXGI_ERROR_ACCESS_LOST.
    const record = (): boolean => {
      try {
        const got = dup.acquire(100);
        if (got !== null) {
          frames.push({ lastPresentTime: got.lastPresentTime, accumulatedFrames: got.accumulatedFrames, hash: hashImage(got.image, mask) });
          last = got.image;
        }
        return true;
      } catch (error) {
        if (!(error instanceof CaptureError && error.code === "ACCESS_LOST")) throw error;
        failure = "access-lost";
        return false;
      }
    };
    // The frame before the start event must exist, so READY follows the first frame.
    let going = true;
    while (going && frames.length === 0 && qpc() - first < BigInt(args.limit) * frequency) going = record();
    if (going && frames.length > 0) {
      console.log(`READY qpc=${qpc()}`);
      if (args.launch !== null) {
        start = qpc();
        Bun.spawn(args.launch, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
        console.log(`START qpc=${start}`);
      }
      while (going) {
        going = record();
        const reason = stopReason(frames, qpc(), first, frequency, args.limit);
        if (reason !== null) {
          console.log(`STOP ${reason}`);
          going = false;
        }
      }
    }
    const file: FramesFile = { frequency: String(frequency), delta, failure, frames: frames.map((f) => ({ ...f, lastPresentTime: String(f.lastPresentTime) })) };
    writeFileSync(join(args.out, "frames.json"), JSON.stringify(file));
    if (last !== null) writeFileSync(join(args.out, "settled.png"), encodePng(last, region.width, region.height));
    console.log(`FRAMES ${frames.length} ${join(args.out, "frames.json")}`);
    if (start !== null) printResult(analyzeFile(args.out, start, null));
    return 0;
  } finally {
    dup.close();
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(parseArgs(process.argv.slice(2))));
  } catch (error) {
    if (!(error instanceof CaptureError)) throw error;
    console.error(error.message);
    process.exit(error.code === "BAD_ARGUMENT" ? 2 : 1);
  }
}
