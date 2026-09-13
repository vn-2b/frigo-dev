-- T13 additive scan-evidence retention (0031). Migrations 0001-0030 are
-- immutable; this migration only adds columns to scan_items.
--
-- WHY_EXISTING_SCHEMA_INSUFFICIENT
--   1. Raw evidence. Confirmation rewrites scan_items.raw_name/canonical_id/
--      estimated_quantity/unit/category/storage in place with the user's
--      corrected values, so the original OCR/vision extraction is destroyed.
--      No other table retains it: inventory_observations.evidence is a
--      five-value enum, note is bounded free text, and the T09 command receipt
--      records the authoritative command, never the extraction it came from.
--      Reusing any of those would be semantic abuse of a certified contract.
--   2. Explicit rejection. is_confirmed is a 0/1 flag, so "user explicitly
--      rejected this line" is indistinguishable from "not reviewed yet".
--      Overloading it with a third value would violate its own semantics and
--      every existing reader of it.
--
-- Observation linkage needs no column: observation identity is derived
-- deterministically from (household_id, source_type, source_ref) with
-- source_ref = '<scanId>:<scanItemId>'.
--
-- Additive, forward-only, replay-safe and legacy-upgrade-safe: the new columns
-- default to the pre-T13 meaning, and the backfill below only records raw
-- evidence that is provably still intact (is_confirmed = 0). Rows confirmed
-- before T13 keep NULL raw evidence, because their extraction is genuinely
-- unknown and UNKNOWN != fabricated.
ALTER TABLE scan_items ADD COLUMN ocr_raw_name TEXT;
ALTER TABLE scan_items ADD COLUMN ocr_quantity REAL
  CHECK (ocr_quantity IS NULL OR (typeof(ocr_quantity) = 'real' AND ocr_quantity > 0));
ALTER TABLE scan_items ADD COLUMN ocr_unit TEXT
  CHECK (ocr_unit IS NULL OR ocr_unit IN ('g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice'));
-- Reported model confidence, or NULL when the provider reported none. The
-- legacy `confidence` column is NOT NULL with a 0.9 default, so it cannot
-- represent "unknown" and every absent confidence there is schema filler, not
-- a model claim. This column is the T13 truth: NULL means unknown.
ALTER TABLE scan_items ADD COLUMN ocr_confidence REAL
  CHECK (ocr_confidence IS NULL OR (ocr_confidence >= 0 AND ocr_confidence <= 1));
-- ADD COLUMN evaluates a CHECK against existing rows, so the review_state /
-- is_confirmed coupling cannot live in the column constraint (rows already
-- confirmed would fail the default). The enum is a column CHECK; the coupling
-- is enforced fail-closed by triggers, the technique 0019 already uses.
ALTER TABLE scan_items ADD COLUMN review_state TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (review_state IN ('PENDING', 'CONFIRMED', 'REJECTED'));

-- Legacy upgrade: unconfirmed rows still hold their untouched extraction, so
-- promoting it to the raw columns is truthful. CAST keeps the REAL affinity the
-- ocr_quantity CHECK requires for integer-valued legacy quantities.
UPDATE scan_items
SET ocr_raw_name = raw_name,
    ocr_quantity = CAST(estimated_quantity AS REAL),
    ocr_unit = CASE WHEN unit IN ('g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice') THEN unit END
WHERE is_confirmed = 0 AND estimated_quantity > 0;

-- Confirmed-before-T13 rows carry the confirmed lifecycle state explicitly.
UPDATE scan_items SET review_state = 'CONFIRMED' WHERE is_confirmed = 1;

-- CONFIRMED and is_confirmed = 1 must stay the same fact, so neither a legacy
-- writer that only sets is_confirmed nor a T13 writer that only sets
-- review_state can produce a half-confirmed line. REJECTED/PENDING lines must
-- never be flagged confirmed.
CREATE TRIGGER trg_scan_items_review_state_insert BEFORE INSERT ON scan_items
WHEN (NEW.review_state = 'CONFIRMED') <> (NEW.is_confirmed = 1)
BEGIN
  SELECT RAISE(ABORT, 'scan_items.review_state must agree with is_confirmed');
END;

CREATE TRIGGER trg_scan_items_review_state_update BEFORE UPDATE OF review_state, is_confirmed ON scan_items
WHEN (NEW.review_state = 'CONFIRMED') <> (NEW.is_confirmed = 1)
BEGIN
  SELECT RAISE(ABORT, 'scan_items.review_state must agree with is_confirmed');
END;
