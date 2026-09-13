# T13 receipt / vision truth

## The chain

```
OCR / vision  ->  user review  ->  T10 observation  ->  T09 command  ->  lots
   (claim)        (correction)      (evidence row)      (authority)    (truth)
```

Each stage may only *weaken* a claim, never strengthen it. Nothing downstream
can invent a fact that the evidence did not carry.

## No-fabrication guards

Previously the AI layer filled gaps with confident-looking defaults. Every one
of those is removed; absent evidence now stays absent.

| Field | Removed default | Now |
| --- | --- | --- |
| `confidence` | `0.9` | Real model confidence, or `undefined` |
| `merchant_name` | `"Siêu thị"` | Real merchant, or `undefined` |
| `purchase_date` | today | Real receipt date, or `undefined` |
| `unit_price_vnd` / `total_price_vnd` | `0` | Real amount, or `undefined` |

A genuinely low confidence is preserved exactly (`0.11` stays `0.11`); it is
never floored to look more certain.

### Money

`receiptPurchasePrice()` treats VND as a zero-minor-digit currency. A
fractional or out-of-range OCR amount is **unprovable**, so it is rejected as
absent rather than rounded into a plausible-looking number.

`Number(null) === 0` in JavaScript silently fabricated a `0₫` purchase price
from a genuinely `NULL` `unit_price_vnd`. Purchase-fact extraction now
null-checks before any numeric coercion.

### Dates

`trustworthyCalendarDate()` accepts a strict `YYYY-MM-DD` calendar date and
validates the day against the real month length (including leap years).
Anything else — including an ambiguous locale string like `13/9/2026` — is not
a provable date and becomes `null`.

Both real providers (`cloudflare`, `groq`) contract `YYYY-MM-DD`. The mock
provider emitted a `vi-VN` locale string, so in every preview and
`AI_MOCK_MODE` run a date the fixture genuinely carried was silently dropped.
The mock now emits the same contract it documents.

## Provenance

`scanProvenance()` derives provenance from the **server-side** `scan_type`
column only. A client cannot relabel a fridge photo as a receipt (or the
reverse) to smuggle in purchase facts.

| `scan_type` | Provenance | Purchase facts allowed |
| --- | --- | --- |
| `receipt` | `RECEIPT` | Yes |
| `fridge` | `SCAN` | **No** |

`receiptLineFacts()` returns `{ purchasedAt: null, purchasePrice: null }`
immediately when provenance is not `RECEIPT`.

## Expiry truth

`lotExpiryFromEvidence(date, kind)` maps evidence to exactly one state:

| Evidence | Result |
| --- | --- |
| `supplied` (user picked a real date) | `KNOWN`, `expiryAt` set |
| `inferred` (shelf-life table, day chip) | `ESTIMATED`, `estimatedExpiryAt` set |
| `absent` | `UNKNOWN`, both null |

A `KNOWN` date and an `ESTIMATED` date are stored in **different columns**, so
a guess can never be mistaken for a fact downstream. `USE_BY` / `BEST_BEFORE`
are never inferred.

A receipt never produces `KNOWN` expiry: a receipt proves *purchase*, not
*expiry*. Confirmed receipt lots land as `ESTIMATED` with a shelf-life date,
plus a real `purchasedAt`.

### The correction loop

A user correction must always be able to establish a fact. Carrying a lot's
previous `ESTIMATED` kind forward through a `PATCH` trapped a corrected lot as
an estimate forever. Expiry kind is now derived from the submitted evidence:

- explicit date → `KNOWN`
- `expiryEstimated: true` (day chip) → `ESTIMATED`
- cleared date → `UNKNOWN`

Verified end to end against the running app:
`UNKNOWN → ESTIMATED → UNKNOWN` and `UNKNOWN → KNOWN`.

## Raw evidence retention

Migration `0031` (additive only) adds to `scan_items`:

| Column | Purpose |
| --- | --- |
| `ocr_raw_name` | What OCR actually read |
| `ocr_quantity` | What OCR actually read |
| `ocr_unit` | What OCR actually read |
| `ocr_confidence` | Real confidence, **nullable** |
| `review_state` | `PENDING` / `CONFIRMED` / `CORRECTED` / `REJECTED` |

The legacy `scan_items.confidence` column is `NOT NULL DEFAULT 0.9` and
therefore *cannot represent "unknown"*. Rather than rewrite a certified
migration, `ocr_confidence` is added as the nullable truth source while the
legacy column keeps its filler for backward compatibility.

`review_state` and `is_confirmed` are kept consistent by triggers
(`trg_scan_items_review_state_insert` / `_update`) rather than a column
`CHECK`, because `ALTER TABLE ... ADD COLUMN ... CHECK` is evaluated against
all existing rows immediately and would fail on rows confirmed before the
migration.

Keeping the raw read alongside the reviewed value is what makes a *correction*
visible as a correction (`correctionOf()`), instead of silently overwriting
what the machine saw.

## Per-line rejection

A reviewer can reject an individual line. A rejected line is marked
`review_state = 'REJECTED'`, `is_confirmed = 0`, and contributes **no** lot
command and **no** observation — it does not become stock and does not become
evidence of stock.
