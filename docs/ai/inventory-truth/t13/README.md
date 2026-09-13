# T13 — Receipt/Vision truth & Inventory UX V2

T08 foundation → T09 mutation authority → T10 observations/reconciliation →
T11 read authority → T12 closed-loop hardening → **T13: the receipt/vision
evidence path and the inventory UX finally tell the truth.**

T13 is the last roadmap task. It restores the receipt/vision provenance work
and the Inventory UX V2 surface that were displaced from T11 into T12, without
changing any certified T08–T12 behavior.

## The one idea

**Evidence is not authority.**

OCR output, a vision guess, a shelf-life table and a user's own correction are
all *evidence*. None of them may silently become stock. Evidence flows:

```
OCR / vision  ->  user review  ->  T10 observation  ->  T09 command  ->  lots
   (claim)        (correction)      (evidence row)      (authority)    (truth)
```

Every arrow is explicit. The only component that may change stock is the T09
lot authority, and T13 adds **no second writer**.

## What this closes

| Area | Before T13 | After T13 |
| --- | --- | --- |
| Confidence | Fabricated `0.9` default | Real model confidence, or absent |
| Merchant | Fabricated `"Siêu thị"` | Real merchant, or absent |
| Purchase date | Fabricated *today* | Real receipt date, or absent |
| Price | Fabricated `0₫` | Real amount, or absent |
| Provenance | Lost after confirm | `RECEIPT` / `SCAN`, server-decided |
| Expiry | A guess looked like a fact | `KNOWN` / `ESTIMATED` / `UNKNOWN` |
| Unknown expiry in UI | Rendered as "fresh" | Visibly distinct, never fresh |
| Raw OCR | Discarded on confirm | Retained (`ocr_*`, `review_state`) |
| Reconciliation | No user surface | `/inventory-reconciliation` |

## Documents

- `RECEIPT_VISION_TRUTH.md` — the evidence→authority chain, what may become a
  fact, and every no-fabrication guard.
- `UX_V2.md` — the Inventory UX V2 surfaces and the presentation truth rules.
- `AUTHORITY_MAP.md` — writer and reader audit for everything T13 added.
- `TEST_MATRIX.md` — AC1–AC14 and the gap set mapped to permanent tests.
- `CONTINUATION.md` — what a follow-up task should know, including the defects
  found by browser verification and the limits of this verification.

## Hard constraints honored

- No merge to `main`, no deploy, no remote D1 access.
- Migrations `0001`–`0030` untouched; `0031` is additive-only.
- Exactly one inventory writer (T09). No second ledger.
- PayOS / payments / billing / checkout untouched.
- `MEAL_PLANNER_ENABLED` and cutover flags unchanged.
