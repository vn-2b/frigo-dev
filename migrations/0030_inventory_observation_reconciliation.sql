-- T10 additive observation/reconciliation persistence. Historical migrations
-- 0023-0029 are immutable. Observations are durable evidence about stock:
-- nothing here writes inventory_items, inventory_lots or inventory_events, and
-- stock changes happen only through explicit reconciliation decisions that
-- compose existing T09 lot-authority commands inside one atomic batch.
CREATE TABLE inventory_observations (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('MANUAL', 'SCAN', 'RECEIPT', 'SHOPPING', 'HEURISTIC')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  fingerprint TEXT NOT NULL
    CHECK (json_valid(fingerprint) AND length(CAST(fingerprint AS BLOB)) <= 4096),
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  ingredient_id TEXT REFERENCES ingredients(id),
  raw_name TEXT CHECK (raw_name IS NULL OR length(raw_name) BETWEEN 1 AND 200),
  lot_id TEXT REFERENCES inventory_lots(id),
  legacy_item_id TEXT REFERENCES inventory_items(id),
  quantity REAL CHECK (quantity IS NULL OR (typeof(quantity) = 'real' AND quantity >= 0)),
  unit TEXT CHECK (unit IS NULL OR unit IN ('g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice')),
  quantity_milli INTEGER
    CHECK (quantity_milli IS NULL OR (typeof(quantity_milli) = 'integer'
      AND quantity_milli BETWEEN 0 AND 9007199254740991)),
  canonical_unit TEXT CHECK (canonical_unit IS NULL
    OR canonical_unit IN ('g', 'ml', 'piece', 'pack', 'bunch', 'slice')),
  storage TEXT CHECK (storage IS NULL OR storage IN ('fridge', 'freezer', 'pantry')),
  expiry_date TEXT,
  expiry_kind TEXT CHECK (expiry_kind IS NULL
    OR expiry_kind IN ('KNOWN', 'BEST_BEFORE', 'USE_BY', 'ESTIMATED')),
  opened_at TEXT,
  evidence TEXT NOT NULL
    CHECK (evidence IN ('UNKNOWN', 'ESTIMATED', 'OBSERVED', 'CONFIRMED', 'VERIFIED')),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  authoritative_inventory_version INTEGER NOT NULL
    CHECK (typeof(authoritative_inventory_version) = 'integer'
      AND authoritative_inventory_version BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RECONCILED', 'STALE')),
  version INTEGER NOT NULL
    CHECK (typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (household_id, source_type, source_ref),
  CHECK ((quantity IS NULL) = (unit IS NULL)),
  CHECK ((quantity_milli IS NULL) = (canonical_unit IS NULL)),
  CHECK ((expiry_date IS NULL) = (expiry_kind IS NULL)),
  CHECK (quantity IS NULL OR quantity_milli IS NOT NULL),
  CHECK (quantity_milli IS NULL OR quantity_milli > 0 OR quantity = 0),
  CHECK (ingredient_id IS NOT NULL OR raw_name IS NOT NULL
    OR lot_id IS NOT NULL OR legacy_item_id IS NOT NULL),
  CHECK (quantity IS NOT NULL OR storage IS NOT NULL OR expiry_date IS NOT NULL
    OR opened_at IS NOT NULL),
  CHECK (NOT (evidence = 'UNKNOWN' AND quantity IS NOT NULL)),
  CHECK (expiry_kind IS NULL OR expiry_kind <> 'ESTIMATED' OR evidence = 'ESTIMATED'),
  CHECK (evidence = 'ESTIMATED' OR expiry_kind IS NOT 'ESTIMATED')
);

CREATE TABLE inventory_reconciliation_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES inventory_observations(id),
  decision_key TEXT NOT NULL CHECK (length(decision_key) BETWEEN 1 AND 200),
  fingerprint TEXT NOT NULL
    CHECK (json_valid(fingerprint) AND length(CAST(fingerprint AS BLOB)) <= 16384),
  decision_type TEXT NOT NULL CHECK (decision_type IN ('CORRECT', 'MOVE', 'DISMISS')),
  proposed_verdict TEXT NOT NULL
    CHECK (proposed_verdict IN ('MATCH', 'NO_ACTION', 'STALE_OBSERVATION', 'AMBIGUOUS', 'CONFLICT',
      'PROPOSE_CORRECTION', 'PROPOSE_MOVE', 'PROPOSE_EXPIRY_UPDATE', 'UNSUPPORTED')),
  actor_id TEXT NOT NULL REFERENCES users(id),
  expected_observation_version INTEGER NOT NULL
    CHECK (typeof(expected_observation_version) = 'integer'
      AND expected_observation_version BETWEEN 1 AND 9007199254740991),
  command_id TEXT REFERENCES inventory_commands(id),
  result_json TEXT
    CHECK (result_json IS NULL OR (json_valid(result_json)
      AND length(CAST(result_json AS BLOB)) <= 262144)),
  created_at TEXT NOT NULL,
  UNIQUE (household_id, decision_key)
);

CREATE INDEX idx_inventory_reconciliation_decisions_observation
  ON inventory_reconciliation_decisions(observation_id);

-- Observation identity/provenance is immutable; only the reconciliation
-- lifecycle (status + optimistic version) may change, OPEN -> RECONCILED/STALE.
CREATE TRIGGER trg_inventory_observations_immutable_insert
BEFORE INSERT ON inventory_observations
WHEN EXISTS (SELECT 1 FROM inventory_observations
  WHERE household_id = NEW.household_id AND source_type = NEW.source_type
    AND source_ref = NEW.source_ref) BEGIN
  SELECT RAISE(ABORT, 'Observation identity already exists');
END;
CREATE TRIGGER trg_inventory_observations_immutable_update
BEFORE UPDATE ON inventory_observations BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.household_id IS NOT OLD.household_id
    OR NEW.source_type IS NOT OLD.source_type OR NEW.source_ref IS NOT OLD.source_ref
    OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.observed_at IS NOT OLD.observed_at
    OR NEW.recorded_at IS NOT OLD.recorded_at OR NEW.ingredient_id IS NOT OLD.ingredient_id
    OR NEW.raw_name IS NOT OLD.raw_name OR NEW.lot_id IS NOT OLD.lot_id
    OR NEW.legacy_item_id IS NOT OLD.legacy_item_id OR NEW.quantity IS NOT OLD.quantity
    OR NEW.unit IS NOT OLD.unit OR NEW.quantity_milli IS NOT OLD.quantity_milli
    OR NEW.canonical_unit IS NOT OLD.canonical_unit OR NEW.storage IS NOT OLD.storage
    OR NEW.expiry_date IS NOT OLD.expiry_date OR NEW.expiry_kind IS NOT OLD.expiry_kind
    OR NEW.opened_at IS NOT OLD.opened_at OR NEW.evidence IS NOT OLD.evidence
    OR NEW.note IS NOT OLD.note
    OR NEW.authoritative_inventory_version IS NOT OLD.authoritative_inventory_version
    OR NEW.created_at IS NOT OLD.created_at
  THEN RAISE(ABORT, 'Observation evidence is immutable') END;
  SELECT CASE WHEN NEW.version IS NOT OLD.version + 1
    OR NOT (OLD.status = 'OPEN' AND NEW.status IN ('RECONCILED', 'STALE'))
  THEN RAISE(ABORT, 'Invalid observation lifecycle transition') END;
END;
CREATE TRIGGER trg_inventory_observations_immutable_delete
BEFORE DELETE ON inventory_observations
WHEN EXISTS (SELECT 1 FROM households WHERE id = OLD.household_id) BEGIN
  SELECT RAISE(ABORT, 'Observations are retained for household lifetime');
END;
CREATE TRIGGER trg_inventory_observations_lot_household_insert
BEFORE INSERT ON inventory_observations
WHEN NEW.lot_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM inventory_lots
    WHERE id = NEW.lot_id AND household_id = NEW.household_id)
  THEN RAISE(ABORT, 'Observation lot household mismatch') END;
  SELECT CASE WHEN NEW.legacy_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inventory_lots
    WHERE id = NEW.lot_id AND legacy_item_id = NEW.legacy_item_id)
  THEN RAISE(ABORT, 'Observation lot mapping mismatch') END;
END;
CREATE TRIGGER trg_inventory_observations_lot_household_update
BEFORE UPDATE ON inventory_observations
WHEN NEW.lot_id IS NOT OLD.lot_id OR NEW.legacy_item_id IS NOT OLD.legacy_item_id BEGIN
  SELECT RAISE(ABORT, 'Observation lot evidence is immutable');
END;
CREATE TRIGGER trg_inventory_observations_projection_household_insert
BEFORE INSERT ON inventory_observations
WHEN NEW.legacy_item_id IS NOT NULL AND NEW.lot_id IS NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM inventory_items
    WHERE id = NEW.legacy_item_id AND household_id = NEW.household_id)
  THEN RAISE(ABORT, 'Observation projection household mismatch') END;
END;

-- A decision may only be recorded when its observation is still OPEN at the
-- recorded optimistic version; the abort fails the whole atomic reconciliation
-- batch, so an applied decision always implies the observation state it saw.
CREATE TRIGGER trg_inventory_reconciliation_decisions_observation_guard
BEFORE INSERT ON inventory_reconciliation_decisions BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM inventory_observations o
    WHERE o.id = NEW.observation_id AND o.household_id = NEW.household_id
      AND o.status = 'OPEN' AND o.version = NEW.expected_observation_version)
  THEN RAISE(ABORT, 'Observation is not open at the expected version') END;
  SELECT CASE WHEN NEW.command_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM inventory_commands c
    WHERE c.id = NEW.command_id AND c.household_id = NEW.household_id)
  THEN RAISE(ABORT, 'Reconciliation decision command household mismatch') END;
  SELECT CASE WHEN NEW.decision_type <> 'DISMISS' AND (NEW.command_id IS NULL OR NEW.result_json IS NULL)
  THEN RAISE(ABORT, 'A stock-affecting decision requires its command receipt') END;
  SELECT CASE WHEN NEW.decision_type = 'DISMISS' AND NEW.command_id IS NOT NULL
  THEN RAISE(ABORT, 'A dismissal decision cannot carry a stock command') END;
END;
CREATE TRIGGER trg_inventory_reconciliation_decisions_immutable_update
BEFORE UPDATE ON inventory_reconciliation_decisions BEGIN
  SELECT RAISE(ABORT, 'Reconciliation decisions are immutable');
END;
CREATE TRIGGER trg_inventory_reconciliation_decisions_immutable_delete
BEFORE DELETE ON inventory_reconciliation_decisions
WHEN EXISTS (SELECT 1 FROM households WHERE id = OLD.household_id) BEGIN
  SELECT RAISE(ABORT, 'Reconciliation decisions are retained for household lifetime');
END;
