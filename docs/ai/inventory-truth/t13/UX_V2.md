# T13 Inventory UX V2

The UI's job is to show what is **known**, what is **estimated**, and what is
**unknown** — and never to let the third look like the first.

## Surfaces

| Route | Purpose |
| --- | --- |
| `/inventory` (`/fridge`) | List. Unknown expiry is visibly distinct. |
| `/ingredients/:id` | Lot detail: provenance, lot id/version, edit, MOVE. |
| `/scan/receipt-review?scanId=` | Review: confidence, price/date truth, per-line correction and rejection. |
| `/inventory-reconciliation` | Evidence from receipts/photos, with accept / dismiss. |

## Presentation truth rules

`src/web/lib/inventory-truth.ts` holds the rules, so every surface answers the
same question the same way.

| Helper | Rule |
| --- | --- |
| `presentExpiry` | `UNKNOWN` renders as "Chưa rõ hạn" — never as fresh, never as a date. `ESTIMATED` is marked as an estimate. |
| `presentConfidence` | Absent confidence renders as absent, never as a number. |
| `presentPrice` | Absent price renders as absent, never `0₫`. |
| `presentPurchaseDate` | Absent date renders "Không rõ ngày mua", never today. |
| `provenanceLabel` | `RECEIPT` → "Từ hóa đơn", `SCAN` → "Từ ảnh quét", legacy → "Dữ liệu cũ". |
| `presentDomainError` | Maps a domain code to specific, readable Vietnamese text and says whether the client must refetch. |

An unmapped error code falls back to readable text — never raw JSON.

## Closed loops verified in the running app

| Loop | Result |
| --- | --- |
| A — receipt → review → confirm → `RECEIPT` provenance + `purchasedAt` | Verified |
| C — storage MOVE through the authority | Verified |
| D — stale edit → `409 CONFLICT`, prior state preserved | Verified |
| D' — expiry `UNKNOWN → ESTIMATED → UNKNOWN` and `UNKNOWN → KNOWN` | Verified |
| E — observation → dismiss → `RECONCILED`, stock untouched | Verified |

### Conflict handling (loop D)

A stale write returns `409 CONFLICT` with a specific Vietnamese message and the
expected/received versions. Observed directly: the earlier write's state
survived intact; nothing was silently overwritten.

### Reconciliation (loop E)

Each evidence card shows its source, the recorded claim, the deterministic T10
verdict and the reasons behind it. When T10 offers no safe automatic action,
**"Áp dụng" is disabled** and the card says so plainly, rather than offering a
button that would guess.

Observed: dismissing one card moved it `OPEN → RECONCILED` (v1 → v2) while the
active lot count stayed unchanged — evidence was decided without any stock
write.

## Layout

Checked for horizontal overflow at **360 / 390 / 430** CSS px on the
reconciliation surface: **0 offending elements** at each width.

Viewport *emulation* could not be applied in this sandbox (`set viewport` and
`set device` both left `innerWidth` at 1440), so this is a computed
layout-overflow probe rather than a visual check at those widths. See
`CONTINUATION.md`.
