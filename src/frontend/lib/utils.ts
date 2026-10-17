// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

export { cn } from "cn"

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
