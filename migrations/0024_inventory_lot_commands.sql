-- T09 live command metadata. Historical T08 snapshots remain unadopted.
ALTER TABLE households ADD COLUMN inventory_version INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(inventory_version) = 'integer' AND inventory_version BETWEEN 1 AND 9007199254740991);

CREATE TABLE inventory_commands (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  client_key TEXT NOT NULL CHECK (length(client_key) BETWEEN 1 AND 200),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
  command_type TEXT NOT NULL CHECK (command_type IN ('CREATE', 'USE', 'DISCARD', 'OPEN', 'MOVE', 'CORRECT')),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  UNIQUE (household_id, client_key)
);

ALTER TABLE inventory_lots ADD COLUMN legacy_item_id TEXT REFERENCES inventory_items(id);
CREATE UNIQUE INDEX idx_inventory_lots_projection ON inventory_lots(legacy_item_id)
  WHERE legacy_item_id IS NOT NULL;
ALTER TABLE inventory_events ADD COLUMN command_id TEXT REFERENCES inventory_commands(id);
CREATE UNIQUE INDEX idx_inventory_events_command_lot ON inventory_events(command_id, inventory_item_id)
  WHERE command_id IS NOT NULL;

CREATE TRIGGER trg_inventory_commands_immutable_insert
BEFORE INSERT ON inventory_commands
WHEN EXISTS (SELECT 1 FROM inventory_commands
  WHERE id = NEW.id OR (household_id = NEW.household_id AND client_key = NEW.client_key)) BEGIN
  SELECT RAISE(ABORT, 'Inventory command receipt already exists');
END;
CREATE TRIGGER trg_inventory_commands_immutable_update
BEFORE UPDATE ON inventory_commands BEGIN
  SELECT RAISE(ABORT, 'Inventory command receipts are immutable');
END;
CREATE TRIGGER trg_inventory_commands_immutable_delete
BEFORE DELETE ON inventory_commands
WHEN EXISTS (SELECT 1 FROM households WHERE id = OLD.household_id) BEGIN
  SELECT RAISE(ABORT, 'Inventory command receipts are retained for household lifetime');
END;

CREATE TRIGGER trg_inventory_lots_live_insert
BEFORE INSERT ON inventory_lots WHEN NEW.legacy_item_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM inventory_items WHERE id = NEW.legacy_item_id AND household_id = NEW.household_id
  ) THEN RAISE(ABORT, 'Lot projection household mismatch') END;
  SELECT CASE WHEN (NEW.state = 'ACTIVE' AND NEW.quantity_milli <= 0)
    OR (NEW.state <> 'ACTIVE' AND NEW.quantity_milli <> 0)
    THEN RAISE(ABORT, 'Invalid live lot lifecycle') END;
  SELECT CASE WHEN NEW.ingredient_id IS NULL AND length(trim(NEW.raw_name, char(9) || char(10) || char(13) || ' ')) = 0
    THEN RAISE(ABORT, 'New live lot identity required') END;
END;
CREATE TRIGGER trg_inventory_lots_no_live_replace
BEFORE INSERT ON inventory_lots
WHEN EXISTS (SELECT 1 FROM inventory_lots WHERE
  (id = NEW.id AND (legacy_item_id IS NOT NULL OR NEW.legacy_item_id IS NOT NULL))
  OR (legacy_item_id IS NOT NULL AND legacy_item_id = NEW.legacy_item_id)) BEGIN
  SELECT RAISE(ABORT, 'Live lots cannot be replaced');
END;
CREATE TRIGGER trg_inventory_lots_backfill_after_live
BEFORE INSERT ON inventory_lots
WHEN NEW.source_type = 'LEGACY_BACKFILL' AND EXISTS (
  SELECT 1 FROM inventory_lots WHERE household_id = NEW.household_id AND legacy_item_id IS NOT NULL
) BEGIN
  SELECT RAISE(ABORT, 'Backfill cannot run after live lot activation');
END;
CREATE TRIGGER trg_inventory_lots_live_update
BEFORE UPDATE ON inventory_lots WHEN NEW.legacy_item_id IS NOT NULL OR OLD.legacy_item_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM inventory_items WHERE id = NEW.legacy_item_id AND household_id = NEW.household_id
  ) THEN RAISE(ABORT, 'Lot projection household mismatch') END;
  SELECT CASE WHEN OLD.legacy_item_id IS NOT NULL AND (
    NEW.legacy_item_id IS NOT OLD.legacy_item_id OR NEW.id IS NOT OLD.id
    OR NEW.household_id IS NOT OLD.household_id OR NEW.source_type IS NOT OLD.source_type
    OR NEW.source_id IS NOT OLD.source_id OR NEW.version <> OLD.version + 1
  ) THEN RAISE(ABORT, 'Live lot mapping/provenance/version is immutable or stale') END;
  SELECT CASE WHEN (NEW.state = 'ACTIVE' AND NEW.quantity_milli <= 0)
    OR (NEW.state <> 'ACTIVE' AND NEW.quantity_milli <> 0)
    THEN RAISE(ABORT, 'Invalid live lot lifecycle') END;
END;
CREATE TRIGGER trg_inventory_lots_live_delete
BEFORE DELETE ON inventory_lots
WHEN OLD.legacy_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM households WHERE id = OLD.household_id) BEGIN
  SELECT RAISE(ABORT, 'Live lots retain terminal history');
END;
CREATE TRIGGER trg_inventory_items_projection_owner
BEFORE UPDATE OF household_id, id ON inventory_items
WHEN EXISTS (SELECT 1 FROM inventory_lots WHERE legacy_item_id = OLD.id)
  AND (NEW.household_id IS NOT OLD.household_id OR NEW.id IS NOT OLD.id) BEGIN
  SELECT RAISE(ABORT, 'Mapped inventory requires explicit ownership policy');
END;
CREATE TRIGGER trg_inventory_items_projection_replace
BEFORE INSERT ON inventory_items
WHEN EXISTS (SELECT 1 FROM inventory_lots WHERE legacy_item_id = NEW.id) BEGIN
  SELECT RAISE(ABORT, 'Mapped inventory cannot be replaced');
END;

CREATE TRIGGER trg_inventory_events_command_insert
BEFORE INSERT ON inventory_events WHEN NEW.command_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM inventory_commands WHERE id = NEW.command_id AND household_id = NEW.household_id
  ) THEN RAISE(ABORT, 'Inventory event command household mismatch') END;
  SELECT CASE WHEN NEW.inventory_item_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM inventory_lots WHERE legacy_item_id = NEW.inventory_item_id AND household_id = NEW.household_id
  ) THEN RAISE(ABORT, 'Inventory event requires owned lot projection') END;
END;
CREATE TRIGGER trg_inventory_events_command_update
BEFORE UPDATE ON inventory_events WHEN OLD.command_id IS NOT NULL OR NEW.command_id IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'Command inventory events are immutable');
END;
CREATE TRIGGER trg_inventory_events_command_replace
BEFORE INSERT ON inventory_events
WHEN EXISTS (SELECT 1 FROM inventory_events WHERE
  (id = NEW.id AND (command_id IS NOT NULL OR NEW.command_id IS NOT NULL))
  OR (command_id IS NOT NULL AND command_id = NEW.command_id AND inventory_item_id = NEW.inventory_item_id)) BEGIN
  SELECT RAISE(ABORT, 'Command inventory events cannot be replaced');
END;
CREATE TRIGGER trg_inventory_events_command_delete
BEFORE DELETE ON inventory_events
WHEN OLD.command_id IS NOT NULL AND EXISTS (SELECT 1 FROM households WHERE id = OLD.household_id) BEGIN
  SELECT RAISE(ABORT, 'Command inventory events retain household history');
END;

-- The coarse revision fences candidate phantoms, including location changes.
CREATE TRIGGER trg_inventory_items_revision_insert AFTER INSERT ON inventory_items BEGIN
  UPDATE households SET inventory_version = inventory_version + 1 WHERE id = NEW.household_id;
END;
CREATE TRIGGER trg_inventory_items_revision_update AFTER UPDATE ON inventory_items BEGIN
  UPDATE households SET inventory_version = inventory_version + 1 WHERE id IN (OLD.household_id, NEW.household_id);
END;
CREATE TRIGGER trg_inventory_items_revision_delete AFTER DELETE ON inventory_items BEGIN
  UPDATE households SET inventory_version = inventory_version + 1 WHERE id = OLD.household_id;
END;
CREATE TRIGGER trg_inventory_lots_revision_insert AFTER INSERT ON inventory_lots BEGIN
  UPDATE households SET inventory_version = inventory_version + 1 WHERE id = NEW.household_id;
END;
CREATE TRIGGER trg_inventory_lots_revision_update AFTER UPDATE ON inventory_lots BEGIN
  UPDATE households SET inventory_version = inventory_version + 1 WHERE id IN (OLD.household_id, NEW.household_id);
END;
CREATE TRIGGER trg_inventory_lots_revision_delete AFTER DELETE ON inventory_lots BEGIN
  UPDATE households SET inventory_version = inventory_version + 1 WHERE id = OLD.household_id;
END;
CREATE TRIGGER trg_storage_locations_revision_insert AFTER INSERT ON storage_locations BEGIN
  UPDATE households SET inventory_version = inventory_version + 1 WHERE id = NEW.household_id;
END;
CREATE TRIGGER trg_storage_locations_revision_update AFTER UPDATE ON storage_locations BEGIN
  UPDATE households SET inventory_version = inventory_version + 1 WHERE id IN (OLD.household_id, NEW.household_id);
END;
CREATE TRIGGER trg_storage_locations_revision_delete AFTER DELETE ON storage_locations BEGIN
  UPDATE households SET inventory_version = inventory_version + 1 WHERE id = OLD.household_id;
END;
