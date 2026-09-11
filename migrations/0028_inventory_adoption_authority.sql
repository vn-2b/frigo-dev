-- T09F additive adoption authority. Historical v1/v2 receipts, events and
-- mappings are unchanged; activation evidence is a versioned receipt.
CREATE TABLE inventory_adoption_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL UNIQUE REFERENCES households(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  source_inventory_version INTEGER NOT NULL
    CHECK (typeof(source_inventory_version) = 'integer'
      AND source_inventory_version BETWEEN 1 AND 9007199254740991),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
  result_json TEXT NOT NULL
    CHECK (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 262144),
  created_at TEXT NOT NULL
);

CREATE TRIGGER trg_inventory_adoption_receipts_immutable_update
BEFORE UPDATE ON inventory_adoption_receipts BEGIN
  SELECT RAISE(ABORT, 'Adoption receipts are immutable');
END;
CREATE TRIGGER trg_inventory_adoption_receipts_immutable_delete
BEFORE DELETE ON inventory_adoption_receipts
WHEN EXISTS (SELECT 1 FROM households WHERE id = OLD.household_id) BEGIN
  SELECT RAISE(ABORT, 'Adoption receipts are retained for household lifetime');
END;
