// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { LOCAL_DATE } from "../history/CommitDetails";

// Feature 005 plan.md D12 "Relative date text" and "Age steps" (spec FR-055).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const count = (n: number, unit: string) => `${n} ${n === 1 ? unit : `${unit}s`} ago`;

/** The gutter date of an author time in seconds. `now` is the clock in milliseconds. A time after now shows the 001 date form. */
export function relativeDate(seconds: number, now: number): string {
  const d = now - seconds * 1000;
  if (d < 0) return LOCAL_DATE.format(seconds * 1000);
  if (d < MINUTE) return "Less than a minute ago";
  if (d < HOUR) return count(Math.floor(d / MINUTE), "minute");
  if (d < DAY) return count(Math.floor(d / HOUR), "hour");
  const days = Math.floor(d / DAY);
  if (days < 14) return count(days, "day");
  if (days < 60) return count(Math.floor(days / 7), "week");
  if (days < 365) return count(Math.floor(days / 30), "month");
  return count(Math.floor(days / 365), "year");
}

/** The age step 1 to 7 of each time: floor(7 × r / c) + 1, with r the 0-based rank of the time among the c distinct times, oldest first. */
export function ageSteps(times: readonly number[]): number[] {
  const distinct = [...new Set(times)].sort((a, b) => a - b);
  const rank = new Map(distinct.map((t, r) => [t, r]));
  return times.map((t) => Math.floor((7 * rank.get(t)!) / distinct.length) + 1);
}
