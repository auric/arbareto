# Data Model: Full History and Commit Message Filter

**Feature**: `specs/002-full-history` | **Date**: 2026-10-11 | **Plan**: [plan.md](plan.md) | **Contract**: [contracts/operations.md](contracts/operations.md)

The service holds every structure below, except the renderer cache (§8). Nothing persists across a service session. Feature 001 data-model rules stay in force.

## 1. History view

One per service session (contract Δ5).

| Field | Type | Rule |
|---|---|---|
| `viewId` | opaque §2 identifier | Issued by `openHistory`. A released view gives `UNKNOWN_TARGET`. |
| `scope` | `"all"` or `"current"` | Fixed for the life of the view (spec FR-049). |
| `generation` | nonnegative safe integer | The repository generation at capture (spec FR-002). |
| `refs` | captured ref set (§2) | Fixed for the life of the view. |
| `topology` | topology table (§3) | Grows in stream order only. |
| `checkpoints` | lane states | One state every 256 rows (§4). |
| `rowCount` | integer, 0 to 4,000,000 | Rows streamed so far. The bound is `HISTORY_VIEW_COMMITS` (contract Δ5). |
| `complete` | boolean | True after a load ends `succeeded`. |
| `limited` | boolean | True after the load reached `HISTORY_VIEW_COMMITS`. The rows stay, and the view states the limit. |
| `lanes` | integer, 1 to 24 | The most lanes so far. It never shrinks (spec FR-016). |
| `stale` | null or `{code, reason}` | Contract Δ8 lists the conditions. |
| `operations` | at most 3 | The load, the search, and the text read. Each has its own Job. |

**State transitions**

```text
open ──openHistory──▶ loading ──succeeded──▶ complete
                        │  ──4,000,000 rows──▶ limited (rows stay; no further load or search)
                        │  ▲
          cancel/DEADLINE│  │loadHistory (resume with --skip)
                        ▼  │
                       idle
any state ──stale condition──▶ stale (rows stay; load and search refuse)
any state ──closeHistory / new openHistory / session end──▶ released
```

- Cancel and `DEADLINE` lead to `idle`, never to `stale`.
- A ref change or a HEAD move changes no state. The renderer shows a notice (contract Δ8).

## 2. Captured ref set

| Field | Type | Rule |
|---|---|---|
| `head` | `{kind: "branch" \| "detached" \| "unborn", name?, oid?}` | From the 001 `captureHead` steps. |
| `records` | list of `{refname, objectname, commitId?, kind}` | The 001 §3 eight-field records of the FR-047 namespaces. At most 10,000 records. |
| `startPoints` | sorted OIDs | `all`: unique `commitId` values plus the HEAD OID. `current`: the HEAD OID. Ascending lowercase hex. |
| `refsDigest` | SHA-256 hex | Over `refname NUL objectname LF` of each FR-047 record, in Git's output order. |
| `fingerprint` | `{shallow, grafts, replace}` | SHA-256 of each file, or `absent`, plus the `refs/replace/` records. |

Validation:
- `kind` is `head`, `remote`, `tag`, or `stash`. A `refs/replace/` record enters only `fingerprint`.
- A record under `refs/stash/` is skipped.
- A tag that ends at a tree or a blob has no `commitId`. It adds no start point and no label.
- A symbolic ref adds no label (spec FR-050).
- The current scope keeps all FR-047 records for labels. Only its `startPoints` differ (spec FR-048).

## 3. Topology table

Typed arrays. No JS `Map` of OID strings.

| Part | Content | Size per commit (unverified) |
|---|---|---|
| OID table | Raw OID bytes in row order | 20 (SHA-1) or 32 (SHA-256) |
| Hash slots | Lookup from OID to row | about 12 |
| `idToRow`, `rowToId` | Row index maps | 8 |
| CSR parents | Offsets and parent row IDs | about 8.4 |

The total is about 48 bytes per commit for SHA-1 and 60 for SHA-256 (research R6, unverified).

Validation (contract Δ3 `loadHistory`):
- A row OID that already exists gives `MALFORMED_GIT_OUTPUT`.
- A parent that already showed as a row gives `MALFORMED_GIT_OUTPUT`.
- A parent still pending at exit 0 gives `MALFORMED_GIT_OUTPUT`.
- A line with more than 64 parents gives `OUTPUT_LIMIT` reason `HISTORY_PARENTS_PER_COMMIT`.
- A resume overlap row that differs gives `HISTORY_CHANGED` reason `order`.

## 4. Lane state and graph cell

- `layoutStep(state_i, row_i) → (cell_i, state_{i+1})` is a pure function.
- A checkpoint stores `state_i` for each i that is a multiple of 256.
- A rebuilt cell equals the first one (spec FR-011, FR-014).

Graph cell fields: `node`, `color`, `merge`, `limited`, `segments`, `marks`.
- `limited` is true exactly when the row needs more than 24 lanes. A row needs the larger of two counts: its open lanes above plus one lane for a new node, and its open lanes below. A limited row draws no edge. Its output lane array drops the free slots and keeps the lane order. A new lane takes the lowest free slot. The row states the limit (spec FR-016, plan.md O-5).
- `marks` hold the root and shallow-boundary marks (spec FR-015).
- In filter mode, a skip edge has a dashed style and an accessible text that says it skips commits (spec FR-034).

## 5. History row (result form)

The row form of `readHistoryRows` (contract Δ3).

| Field | Presence |
|---|---|
| `index`, `oid`, `parents`, `cell`, `labels`, `checkout` | Always. `cell` is null for a filter row that is not settled yet. |
| `match` | With `searchId`: true, false, or null. |
| `subject`, `author`, `date`, `encoding`, `invalidUtf8` | `text: "rows"` or `"details"`. `textLimit` replaces them for an object above 256 KiB. |
| `body`, `bodyCut`, `committer`, `committerDate`, `children` | `text: "details"` only (spec FR-017, FR-018). |

Text comes from the commit object by OID. Commit objects never change, so a reread gives the same text.

## 6. Message search

| Field | Type | Rule |
|---|---|---|
| `searchId` | opaque §2 identifier | One running search per view. |
| `text` | string | 1 to 1,024 UTF-8 bytes. Contract Δ3 lists the refusals. |
| `matches` | rising row indices, plus a FIFO of OIDs whose rows are not known yet | Contract Δ3 "Merge into the view". |
| `count` | integer | Final only in the terminal response (spec FR-039). |
| `state` | `running`, `finished`, `stopped`, `refused`, `failed` | See below. |

**Known match state of row r**
- When the search has ended, every streamed row is known.
- When the FIFO is not empty, every streamed row is known.
- Otherwise the rows up to and including the row of the last match are known.

**State transitions**

```text
(text at Enter) ──refusal──▶ refused (no Git process)
               ──probe mismatch──▶ refused (SEARCH_UNSUPPORTED)
               ──start──▶ running ──exit 0, FIFO empty at load end──▶ finished
                           running ──cancel / new text / Escape / close──▶ stopped
                           running ──order break──▶ failed (HISTORY_CHANGED order; the view stays)
```

A `stopped` or `failed` search never shows its count as final.

**Load during a search**
- When a search starts on an incomplete view, the service resumes the load itself, because filter mode needs the full topology stream (plan.md D4). The renderer starts nothing extra.
- That load belongs to the search operation. Its progress and Cancel go with the search. A cancel keeps the loaded rows.
- On a view in the `limited` state, a search ends `limited` with `OUTPUT_LIMIT` reason `HISTORY_VIEW_COMMITS`. No Git process starts.

## 7. Reduced graph

Rows are processed in stream order, when their match state is known.

| Part | Rule |
|---|---|
| `P` | Maps each referenced commit that is not processed yet to a sorted array of match sequence numbers. Arrays are shared and never changed. |
| Edge | `m → q`, with `direct` true when the matching row is a parent of m. Otherwise it skips commits. 8 bytes per edge. |
| Settled prefix | The minimum of the next unprocessed match sequence and the smallest first element over the arrays in `P`. |

Plan D4 gives the algorithm and its proof. A match without a matching ancestor shows "No earlier matching commit", unless it is a true root or a shallow boundary.

## 8. Renderer cache

| Field | Rule |
|---|---|
| Page | 128 rows. |
| Bound | 8 MiB of the `bytes` value of each result, in LRU order. A measurement knob. |
| Visible pages | Always stay. |
| In flight | One row read per view. The latest request wins. |

The renderer holds O(visible + cache) only. It holds no structure of the history size.

## 9. Memory budget record

| Field | Rule |
|---|---|
| Base | The same workspace before history opens (spec SC-002). The design proposes a twin worktree with a one-commit history. That base waits for plan.md open item O-1. |
| Samples | Private bytes over the complete process tree, every 100 ms. |
| Git processes | Recorded apart, next to the peak of the same Git command run alone. |
| Checkpoints | End of a full scroll, after a return to the top, during a filter search (spec SC-002). |
