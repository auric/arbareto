// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The notices.json shape (001 T130, 007 plan.md D6). The generator, the About window, and the release notices file share it.

import { z } from "zod";

export const NoticesSchema = z.strictObject({
  repositoryUrl: z.string(),
  project: z.strictObject({ license: z.string(), notice: z.string() }),
  /** Each distinct licence text once. Files share a text only when the texts are byte-identical. */
  texts: z.array(z.string()),
  groups: z.array(
    z.strictObject({
      license: z.string(),
      packages: z.array(
        z.strictObject({
          name: z.string(),
          version: z.string().optional(),
          /** `text` is the index of the licence text in `texts`. */
          files: z.array(z.strictObject({ name: z.string(), text: z.number().int().nonnegative() })),
          note: z.string().optional(),
        }),
      ),
    }),
  ),
});

export type Notices = z.infer<typeof NoticesSchema>;
