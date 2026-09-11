-- T09 final FEFO v2 backfill compatibility (additive 0029).
-- Historical migrations 0023-0028 are immutable; this migration only recreates
-- the two v2 FEFO authority triggers from 0027. Every retained guard is
-- byte-identical except two backfill incompatibilities:
--   1. The rigid equal-ID assumption (l.id = l.legacy_item_id) is replaced by
--      the authoritative mapping check: a lot may act under its legacy
--      projection identity when LEGACY_BACKFILL provenance, source identity and
--      the immutable adoption receipt prove the mapping with a preserved
--      version offset. Native equal-ID lots keep passing unchanged.
--   2. The prestate projection parity now accepts the exact legacy kg/l
--      display aliases the executor reconciles; the first native write
--      canonicalizes them and every poststate guard stays strict.
-- To stay inside D1's expression-depth limit the replacement checks are
-- separate shallow trigger statements, the technique 0027 itself uses; the
-- deep before-snapshot/poststate guards only lost the replaced terms.
-- Household isolation, projection parity, event evidence and envelope guards
-- are retained fail-closed.
DROP TRIGGER trg_inventory_commands_fefo_authority_insert;
DROP TRIGGER trg_inventory_events_command_fefo_authority_insert;
-- A v2 receipt is a complete, pre-write FEFO allocation witness.
CREATE TRIGGER trg_inventory_commands_fefo_authority_insert
BEFORE INSERT ON inventory_commands
WHEN COALESCE(json_extract(NEW.result_json, '$.schemaVersion'), 1) = 2 BEGIN
  SELECT CASE WHEN typeof(NEW.result_json) <> 'text' OR length(CAST(NEW.result_json AS BLOB)) > 262144
    OR json_valid(NEW.result_json) IS NOT 1
    OR typeof(NEW.fingerprint) <> 'text' OR length(CAST(NEW.fingerprint AS BLOB)) > 16384
    OR json_valid(NEW.fingerprint) IS NOT 1
    THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
  SELECT CASE WHEN length(json_extract(NEW.fingerprint, '$.command.ingredientId')) NOT BETWEEN 1 AND 200
    OR (json_type(NEW.fingerprint, '$.command.reason') IS NOT NULL AND (
      length(json_extract(NEW.fingerprint, '$.command.reason')) NOT BETWEEN 1 AND 1000
      OR length(trim(json_extract(NEW.fingerprint, '$.command.reason'), char(9) || char(10) || char(13) || ' ')) = 0
      OR instr(json_extract(NEW.fingerprint, '$.command.reason'), char(0)) > 0
    )) THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
  SELECT CASE WHEN json_type(NEW.result_json) IS NOT 'object' OR json_type(NEW.fingerprint) IS NOT 'object'
    OR EXISTS (SELECT 1 FROM json_tree(NEW.result_json) GROUP BY fullkey HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM json_tree(NEW.fingerprint) GROUP BY fullkey HAVING count(*) > 1)
    THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
  SELECT CASE WHEN (SELECT count(*) FROM json_each(NEW.result_json)) <> 8
    OR EXISTS (SELECT 1 FROM json_each(NEW.result_json) WHERE key NOT IN
      ('schemaVersion', 'commandId', 'commandType', 'mode', 'ingredientId', 'quantityMilli', 'canonicalUnit', 'effects'))
    OR (SELECT count(*) FROM json_each(NEW.fingerprint)) <> 3
    OR EXISTS (SELECT 1 FROM json_each(NEW.fingerprint) WHERE key NOT IN ('householdId', 'actorId', 'command'))
    OR json_type(NEW.fingerprint, '$.command') IS NOT 'object'
    OR EXISTS (SELECT 1 FROM json_each(NEW.fingerprint, '$.command') WHERE key NOT IN
      ('type', 'mode', 'ingredientId', 'quantityMilli', 'canonicalUnit', 'reason', 'expectedInventoryVersion'))
    OR (SELECT count(*) FROM json_each(NEW.fingerprint, '$.command')) NOT BETWEEN 5 AND 7
    THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
  SELECT CASE WHEN json_type(NEW.result_json, '$.schemaVersion') IS NOT 'integer'
    OR json_extract(NEW.result_json, '$.schemaVersion') IS NOT 2
    OR json_type(NEW.result_json, '$.commandId') IS NOT 'text' OR json_extract(NEW.result_json, '$.commandId') IS NOT NEW.id
    OR json_type(NEW.result_json, '$.commandType') IS NOT 'text' OR json_extract(NEW.result_json, '$.commandType') IS NOT 'USE'
    OR NEW.command_type <> 'USE'
    OR json_type(NEW.result_json, '$.mode') IS NOT 'text' OR json_extract(NEW.result_json, '$.mode') IS NOT 'FEFO'
    OR json_type(NEW.fingerprint, '$.householdId') IS NOT 'text' OR json_extract(NEW.fingerprint, '$.householdId') IS NOT NEW.household_id
    OR json_type(NEW.fingerprint, '$.actorId') IS NOT 'text' OR json_extract(NEW.fingerprint, '$.actorId') IS NOT NEW.actor_id
    OR json_type(NEW.fingerprint, '$.command.type') IS NOT 'text' OR json_extract(NEW.fingerprint, '$.command.type') IS NOT 'USE'
    OR json_type(NEW.fingerprint, '$.command.mode') IS NOT 'text' OR json_extract(NEW.fingerprint, '$.command.mode') IS NOT 'FEFO'
    OR json_type(NEW.result_json, '$.ingredientId') IS NOT 'text'
    OR json_type(NEW.fingerprint, '$.command.ingredientId') IS NOT 'text'
    OR json_extract(NEW.result_json, '$.ingredientId') IS NOT json_extract(NEW.fingerprint, '$.command.ingredientId')
    OR json_type(NEW.result_json, '$.quantityMilli') IS NOT 'integer'
    OR json_extract(NEW.result_json, '$.quantityMilli') NOT BETWEEN 1 AND 9007199254740991
    OR json_extract(NEW.result_json, '$.quantityMilli') IS NOT json_extract(NEW.fingerprint, '$.command.quantityMilli')
    OR json_type(NEW.fingerprint, '$.command.quantityMilli') IS NOT 'integer'
    OR json_extract(NEW.fingerprint, '$.command.quantityMilli') NOT BETWEEN 1 AND 9007199254740991
    OR json_type(NEW.result_json, '$.canonicalUnit') IS NOT 'text'
    OR json_extract(NEW.result_json, '$.canonicalUnit') NOT IN ('g', 'ml', 'piece')
    OR json_extract(NEW.result_json, '$.canonicalUnit') IS NOT json_extract(NEW.fingerprint, '$.command.canonicalUnit')
    OR json_type(NEW.fingerprint, '$.command.canonicalUnit') IS NOT 'text'
    OR json_extract(NEW.fingerprint, '$.command.canonicalUnit') NOT IN ('g', 'ml', 'piece')
    OR (json_type(NEW.fingerprint, '$.command.reason') IS NOT NULL
      AND json_type(NEW.fingerprint, '$.command.reason') IS NOT 'text')
    OR (json_type(NEW.fingerprint, '$.command.expectedInventoryVersion') IS NOT NULL
      AND (json_type(NEW.fingerprint, '$.command.expectedInventoryVersion') IS NOT 'integer'
        OR json_extract(NEW.fingerprint, '$.command.expectedInventoryVersion') NOT BETWEEN 1 AND 9007199254740991
        OR NOT EXISTS (SELECT 1 FROM households h WHERE h.id = NEW.household_id
          AND h.inventory_version = json_extract(NEW.fingerprint, '$.command.expectedInventoryVersion'))))
    THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
  SELECT CASE WHEN json_type(NEW.result_json, '$.effects') IS NOT 'array'
    OR json_array_length(NEW.result_json, '$.effects') NOT BETWEEN 1 AND 32
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.result_json, '$.effects') e
      WHERE json_type(e.value) IS NOT 'object' OR (SELECT count(*) FROM json_each(e.value)) <> 6
        OR EXISTS (SELECT 1 FROM json_each(e.value) WHERE key NOT IN
          ('ordinal', 'legacyItemId', 'before', 'after', 'changed', 'deltaMilli'))
        OR json_type(e.value, '$.ordinal') IS NOT 'integer' OR json_extract(e.value, '$.ordinal') IS NOT CAST(e.key AS INTEGER)
        OR json_type(e.value, '$.legacyItemId') IS NOT 'text'
        OR json_type(e.value, '$.before') IS NOT 'object' OR json_type(e.value, '$.after') IS NOT 'object'
        OR json_type(e.value, '$.changed') IS NOT 'true'
        OR json_type(e.value, '$.deltaMilli') IS NOT 'integer'
        OR json_extract(e.value, '$.deltaMilli') NOT BETWEEN -9007199254740991 AND -1
    )
    OR EXISTS (
      SELECT legacy_item_id FROM (
        SELECT json_extract(value, '$.legacyItemId') AS legacy_item_id
        FROM json_each(NEW.result_json, '$.effects')
      ) GROUP BY legacy_item_id HAVING count(*) > 1
    )
    OR EXISTS (
      SELECT lot_id FROM (
        SELECT json_extract(value, '$.after.id') AS lot_id
        FROM json_each(NEW.result_json, '$.effects')
      ) GROUP BY lot_id HAVING count(*) > 1
    )
    OR (SELECT COALESCE(SUM(-json_extract(value, '$.deltaMilli')), 0)
      FROM json_each(NEW.result_json, '$.effects')) IS NOT json_extract(NEW.result_json, '$.quantityMilli')
    THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;

  -- Every before snapshot must be the current mapped lot and legacy projection.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.result_json, '$.effects') e
    LEFT JOIN inventory_lots l ON l.id = json_extract(e.value, '$.before.id')
      AND l.legacy_item_id = json_extract(e.value, '$.legacyItemId')
    LEFT JOIN inventory_items i ON i.id = l.legacy_item_id AND i.household_id = l.household_id
    LEFT JOIN storage_locations s ON s.id = l.storage_location_id AND s.household_id = l.household_id
    WHERE l.id IS NULL OR i.id IS NULL OR s.id IS NULL
      OR l.household_id IS NOT NEW.household_id
      OR l.ingredient_id IS NOT json_extract(NEW.result_json, '$.ingredientId')
      OR l.canonical_unit IS NOT json_extract(NEW.result_json, '$.canonicalUnit')
      OR l.state IS NOT 'ACTIVE' OR l.quantity_milli <= 0
      OR l.version >= 9007199254740991 OR l.legacy_version IS NULL OR l.legacy_version >= 9007199254740991
      OR json_extract(e.value, '$.before.id') IS NOT l.id
      OR json_extract(e.value, '$.before.householdId') IS NOT l.household_id
      OR json_extract(e.value, '$.before.ingredientId') IS NOT l.ingredient_id
      OR json_extract(e.value, '$.before.rawName') IS NOT l.raw_name
      OR json_extract(e.value, '$.before.quantityMilli') IS NOT l.quantity_milli
      OR json_extract(e.value, '$.before.canonicalUnit') IS NOT l.canonical_unit
      OR json_extract(e.value, '$.before.storageLocationId') IS NOT l.storage_location_id
      OR json_extract(e.value, '$.before.state') IS NOT l.state
      OR json_extract(e.value, '$.before.purchasedAt') IS NOT l.purchased_at
      OR json_extract(e.value, '$.before.openedAt') IS NOT l.opened_at
      OR json_extract(e.value, '$.before.expiryAt') IS NOT l.expiry_at
      OR json_extract(e.value, '$.before.estimatedExpiryAt') IS NOT l.estimated_expiry_at
      OR json_extract(e.value, '$.before.expiryKind') IS NOT l.expiry_kind
      OR json_extract(e.value, '$.before.sourceType') IS NOT l.source_type
      OR json_extract(e.value, '$.before.sourceId') IS NOT l.source_id
      OR json_extract(e.value, '$.before.version') IS NOT l.version
      OR json_extract(e.value, '$.before.createdAt') IS NOT l.created_at
      OR json_extract(e.value, '$.before.updatedAt') IS NOT l.updated_at
      OR json_extract(e.value, '$.before.legacyExpiryAt') IS NOT l.legacy_expiry_at
      OR json_extract(e.value, '$.before.legacyExpiryKind') IS NOT l.legacy_expiry_kind
      OR json_extract(e.value, '$.before.legacyExpirySource') IS NOT l.legacy_expiry_source
      OR json_extract(e.value, '$.before.legacyOpenedAt') IS NOT l.legacy_opened_at
      OR json_extract(e.value, '$.before.legacyVersion') IS NOT l.legacy_version
      OR json_type(e.value, '$.before.purchasePrice') IS NOT CASE WHEN l.currency IS NULL THEN 'null' ELSE 'object' END
      OR json_extract(e.value, '$.before.purchasePrice.currency') IS NOT l.currency
      OR json_extract(e.value, '$.before.purchasePrice.amountMinor') IS NOT l.amount_minor
      OR json_extract(e.value, '$.before.purchasePrice.minorDigits') IS NOT l.minor_digits
      OR i.version IS NOT l.legacy_version
      OR i.name IS NOT l.raw_name OR i.ingredient_id IS NOT l.ingredient_id OR i.storage IS NOT lower(s.type)
  ) THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;

  -- A non-self-mapped lot must be its authoritative adopted mapping: the
  -- immutable adoption receipt proves lot/legacy identity, provenance and a
  -- preserved version offset. Native equal-ID lots pass unchanged.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.result_json, '$.effects') e
    JOIN inventory_lots l ON l.id = json_extract(e.value, '$.before.id')
      AND l.legacy_item_id = json_extract(e.value, '$.legacyItemId')
    WHERE l.id IS NOT l.legacy_item_id AND NOT EXISTS (
      SELECT 1 FROM inventory_adoption_receipts ar
      JOIN json_each(ar.result_json, '$.effects') ae
        ON json_extract(ae.value, '$.lotId') IS l.id
        AND json_extract(ae.value, '$.legacyItemId') IS l.legacy_item_id
      WHERE ar.household_id IS l.household_id
        AND json_extract(ar.result_json, '$.schemaVersion') IS 3
        AND json_extract(ar.result_json, '$.commandType') IS 'ADOPT'
        AND json_extract(ar.result_json, '$.householdId') IS ar.household_id
        AND json_extract(ar.result_json, '$.actorId') IS ar.actor_id
        AND json_extract(ar.result_json, '$.sourceInventoryVersion') IS ar.source_inventory_version
        AND json_extract(ae.value, '$.after.householdId') IS l.household_id
        AND json_extract(ae.value, '$.after.createdAt') IS l.created_at
        AND json_extract(ae.value, '$.after.sourceType') IS 'LEGACY_BACKFILL'
        AND json_extract(ae.value, '$.after.sourceId') IS l.legacy_item_id
        AND json_extract(ae.value, '$.after.version') <= l.version
        AND l.version - json_extract(ae.value, '$.after.version')
          IS l.legacy_version - json_extract(ae.value, '$.after.legacyVersion')
    )
  ) THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
  -- Prestate projection parity accepts the exact legacy kg/l display aliases
  -- the executor reconciles; the first native write canonicalizes them.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.result_json, '$.effects') e
    JOIN inventory_lots l ON l.id = json_extract(e.value, '$.before.id')
      AND l.legacy_item_id = json_extract(e.value, '$.legacyItemId')
    JOIN inventory_items i ON i.id = l.legacy_item_id AND i.household_id = l.household_id
    WHERE NOT ((i.unit IS l.canonical_unit AND i.quantity IS l.quantity_milli / 1000.0)
      OR (i.unit IS 'kg' AND l.canonical_unit IS 'g' AND i.quantity IS l.quantity_milli / 1000000.0)
      OR (i.unit IS 'l' AND l.canonical_unit IS 'ml' AND i.quantity IS l.quantity_milli / 1000000.0))
  ) THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
  -- Full lot objects are strict; after may change only the consumption fields.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.result_json, '$.effects') e
    WHERE (SELECT count(*) FROM json_each(e.value, '$.before')) <> 24
      OR (SELECT count(*) FROM json_each(e.value, '$.after')) <> 24
      OR EXISTS (SELECT 1 FROM json_each(e.value, '$.before') WHERE key NOT IN
        ('id', 'householdId', 'ingredientId', 'rawName', 'quantityMilli', 'canonicalUnit', 'storageLocationId', 'state', 'purchasedAt', 'openedAt', 'expiryAt', 'estimatedExpiryAt', 'expiryKind', 'sourceType', 'sourceId', 'version', 'createdAt', 'updatedAt', 'purchasePrice', 'legacyExpiryAt', 'legacyExpiryKind', 'legacyExpirySource', 'legacyOpenedAt', 'legacyVersion'))
      OR EXISTS (SELECT 1 FROM json_each(e.value, '$.after') WHERE key NOT IN
        ('id', 'householdId', 'ingredientId', 'rawName', 'quantityMilli', 'canonicalUnit', 'storageLocationId', 'state', 'purchasedAt', 'openedAt', 'expiryAt', 'estimatedExpiryAt', 'expiryKind', 'sourceType', 'sourceId', 'version', 'createdAt', 'updatedAt', 'purchasePrice', 'legacyExpiryAt', 'legacyExpiryKind', 'legacyExpirySource', 'legacyOpenedAt', 'legacyVersion'))
  ) THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.result_json, '$.effects') e
    WHERE json_type(e.value, '$.before.id') IS NOT 'text' OR json_type(e.value, '$.after.id') IS NOT 'text'
      OR json_type(e.value, '$.before.householdId') IS NOT 'text' OR json_type(e.value, '$.after.householdId') IS NOT 'text'
      OR json_type(e.value, '$.before.ingredientId') IS NOT 'text' OR json_type(e.value, '$.after.ingredientId') IS NOT 'text'
      OR json_type(e.value, '$.before.rawName') IS NOT 'text' OR json_type(e.value, '$.after.rawName') IS NOT 'text'
      OR json_type(e.value, '$.before.quantityMilli') IS NOT 'integer'
      OR json_type(e.value, '$.before.canonicalUnit') IS NOT 'text' OR json_type(e.value, '$.after.canonicalUnit') IS NOT 'text'
      OR json_type(e.value, '$.before.storageLocationId') IS NOT 'text' OR json_type(e.value, '$.after.storageLocationId') IS NOT 'text'
      OR json_type(e.value, '$.before.state') IS NOT 'text' OR json_type(e.value, '$.after.state') IS NOT 'text'
      OR json_type(e.value, '$.before.purchasedAt') NOT IN ('text', 'null') OR json_type(e.value, '$.after.purchasedAt') NOT IN ('text', 'null')
      OR json_type(e.value, '$.before.openedAt') NOT IN ('text', 'null') OR json_type(e.value, '$.after.openedAt') NOT IN ('text', 'null')
      OR json_type(e.value, '$.before.expiryAt') NOT IN ('text', 'null') OR json_type(e.value, '$.after.expiryAt') NOT IN ('text', 'null')
      OR json_type(e.value, '$.before.estimatedExpiryAt') NOT IN ('text', 'null') OR json_type(e.value, '$.after.estimatedExpiryAt') NOT IN ('text', 'null')
      OR json_type(e.value, '$.before.expiryKind') IS NOT 'text' OR json_type(e.value, '$.after.expiryKind') IS NOT 'text'
      OR json_type(e.value, '$.before.sourceType') IS NOT 'text' OR json_type(e.value, '$.after.sourceType') IS NOT 'text'
      OR json_type(e.value, '$.before.sourceId') NOT IN ('text', 'null') OR json_type(e.value, '$.after.sourceId') NOT IN ('text', 'null')
      OR json_type(e.value, '$.before.version') IS NOT 'integer'
      OR json_type(e.value, '$.before.createdAt') IS NOT 'text' OR json_type(e.value, '$.after.createdAt') IS NOT 'text'
      OR json_type(e.value, '$.before.updatedAt') IS NOT 'text' OR json_type(e.value, '$.after.updatedAt') IS NOT 'text'
      OR json_type(e.value, '$.before.legacyExpiryAt') NOT IN ('text', 'null') OR json_type(e.value, '$.after.legacyExpiryAt') NOT IN ('text', 'null')
      OR json_type(e.value, '$.before.legacyExpiryKind') NOT IN ('text', 'null') OR json_type(e.value, '$.after.legacyExpiryKind') NOT IN ('text', 'null')
      OR json_type(e.value, '$.before.legacyExpirySource') NOT IN ('text', 'null') OR json_type(e.value, '$.after.legacyExpirySource') NOT IN ('text', 'null')
      OR json_type(e.value, '$.before.legacyOpenedAt') NOT IN ('text', 'null') OR json_type(e.value, '$.after.legacyOpenedAt') NOT IN ('text', 'null')
      OR json_type(e.value, '$.before.legacyVersion') IS NOT 'integer'
  ) THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.result_json, '$.effects') e
    WHERE (json_type(e.value, '$.before.purchasePrice') = 'object' AND ((SELECT count(*) FROM json_each(e.value, '$.before.purchasePrice')) <> 3 OR EXISTS (SELECT 1 FROM json_each(e.value, '$.before.purchasePrice') WHERE key NOT IN ('currency', 'amountMinor', 'minorDigits'))))
      OR (json_type(e.value, '$.after.purchasePrice') = 'object' AND ((SELECT count(*) FROM json_each(e.value, '$.after.purchasePrice')) <> 3 OR EXISTS (SELECT 1 FROM json_each(e.value, '$.after.purchasePrice') WHERE key NOT IN ('currency', 'amountMinor', 'minorDigits'))))
      OR (json_type(e.value, '$.before.purchasePrice') = 'object' AND (json_type(e.value, '$.before.purchasePrice.currency') IS NOT 'text' OR json_type(e.value, '$.before.purchasePrice.amountMinor') IS NOT 'integer' OR json_type(e.value, '$.before.purchasePrice.minorDigits') IS NOT 'integer'))
      OR (json_type(e.value, '$.after.purchasePrice') = 'object' AND (json_type(e.value, '$.after.purchasePrice.currency') IS NOT 'text' OR json_type(e.value, '$.after.purchasePrice.amountMinor') IS NOT 'integer' OR json_type(e.value, '$.after.purchasePrice.minorDigits') IS NOT 'integer'))
  ) THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
  -- Separate shape and transition predicates to fit D1's expression-depth limit.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.result_json, '$.effects') e
    WHERE json_extract(e.value, '$.after.id') IS NOT json_extract(e.value, '$.before.id')
      OR json_extract(e.value, '$.after.householdId') IS NOT json_extract(e.value, '$.before.householdId')
      OR json_extract(e.value, '$.after.ingredientId') IS NOT json_extract(e.value, '$.before.ingredientId')
      OR json_extract(e.value, '$.after.rawName') IS NOT json_extract(e.value, '$.before.rawName')
      OR json_extract(e.value, '$.after.canonicalUnit') IS NOT json_extract(e.value, '$.before.canonicalUnit')
      OR json_extract(e.value, '$.after.storageLocationId') IS NOT json_extract(e.value, '$.before.storageLocationId')
      OR json_extract(e.value, '$.after.purchasedAt') IS NOT json_extract(e.value, '$.before.purchasedAt')
      OR json_extract(e.value, '$.after.openedAt') IS NOT json_extract(e.value, '$.before.openedAt')
      OR json_extract(e.value, '$.after.expiryAt') IS NOT json_extract(e.value, '$.before.expiryAt')
      OR json_extract(e.value, '$.after.estimatedExpiryAt') IS NOT json_extract(e.value, '$.before.estimatedExpiryAt')
      OR json_extract(e.value, '$.after.expiryKind') IS NOT json_extract(e.value, '$.before.expiryKind')
      OR json_extract(e.value, '$.after.sourceType') IS NOT json_extract(e.value, '$.before.sourceType')
      OR json_extract(e.value, '$.after.sourceId') IS NOT json_extract(e.value, '$.before.sourceId')
      OR json_extract(e.value, '$.after.createdAt') IS NOT json_extract(e.value, '$.before.createdAt')
      OR json_type(e.value, '$.after.purchasePrice') IS NOT json_type(e.value, '$.before.purchasePrice')
      OR json_extract(e.value, '$.after.purchasePrice.currency') IS NOT json_extract(e.value, '$.before.purchasePrice.currency')
      OR json_extract(e.value, '$.after.purchasePrice.amountMinor') IS NOT json_extract(e.value, '$.before.purchasePrice.amountMinor')
      OR json_extract(e.value, '$.after.purchasePrice.minorDigits') IS NOT json_extract(e.value, '$.before.purchasePrice.minorDigits')
      OR json_extract(e.value, '$.after.legacyExpiryAt') IS NOT json_extract(e.value, '$.before.legacyExpiryAt')
      OR json_extract(e.value, '$.after.legacyExpiryKind') IS NOT json_extract(e.value, '$.before.legacyExpiryKind')
      OR json_extract(e.value, '$.after.legacyExpirySource') IS NOT json_extract(e.value, '$.before.legacyExpirySource')
      OR json_extract(e.value, '$.after.legacyOpenedAt') IS NOT json_extract(e.value, '$.before.legacyOpenedAt')
      OR json_type(e.value, '$.after.quantityMilli') IS NOT 'integer'
      OR json_extract(e.value, '$.after.quantityMilli') IS NOT json_extract(e.value, '$.before.quantityMilli') + json_extract(e.value, '$.deltaMilli')
      OR json_extract(e.value, '$.after.quantityMilli') NOT BETWEEN 0 AND 9007199254740991
      OR json_extract(e.value, '$.after.state') IS NOT CASE WHEN json_extract(e.value, '$.after.quantityMilli') = 0 THEN 'CONSUMED' ELSE 'ACTIVE' END
      OR json_type(e.value, '$.after.version') IS NOT 'integer'
      OR json_extract(e.value, '$.after.version') IS NOT json_extract(e.value, '$.before.version') + 1
      OR json_type(e.value, '$.after.legacyVersion') IS NOT 'integer'
      OR json_extract(e.value, '$.after.legacyVersion') IS NOT json_extract(e.value, '$.before.legacyVersion') + 1
      OR json_extract(e.value, '$.after.updatedAt') IS NOT NEW.created_at
  ) THEN RAISE(ABORT, 'Inventory FEFO command evidence mismatch') END;
END;

-- Each FEFO event must be the receipt effect written to the mapped lot/projection.
CREATE TRIGGER trg_inventory_events_command_fefo_authority_insert
BEFORE INSERT ON inventory_events
WHEN NEW.command_id IS NOT NULL
  AND COALESCE((SELECT json_extract(result_json, '$.schemaVersion') FROM inventory_commands WHERE id = NEW.command_id), 1) = 2 BEGIN
  SELECT CASE WHEN typeof(NEW.metadata) <> 'text' OR length(CAST(NEW.metadata AS BLOB)) > 262144
    OR json_valid(NEW.metadata) IS NOT 1
    OR NOT EXISTS (SELECT 1 FROM inventory_commands c WHERE c.id = NEW.command_id
      AND c.household_id = NEW.household_id AND c.command_type = 'USE'
      AND typeof(c.result_json) = 'text' AND json_valid(c.result_json) = 1
      AND typeof(c.fingerprint) = 'text' AND json_valid(c.fingerprint) = 1)
    THEN RAISE(ABORT, 'Inventory FEFO command event evidence mismatch') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_tree(NEW.metadata) GROUP BY fullkey HAVING count(*) > 1)
    OR EXISTS (
      SELECT 1 FROM inventory_commands c WHERE c.id = NEW.command_id AND (
        EXISTS (SELECT 1 FROM json_tree(c.result_json) GROUP BY fullkey HAVING count(*) > 1)
        OR EXISTS (SELECT 1 FROM json_tree(c.fingerprint) GROUP BY fullkey HAVING count(*) > 1)
      )
    ) THEN RAISE(ABORT, 'Inventory FEFO command event evidence mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    WITH effect AS (
      SELECT c.id, c.household_id, c.actor_id, c.client_key, c.fingerprint, c.result_json, c.created_at,
        e.key AS effect_key, e.value AS effect
      FROM inventory_commands c
      JOIN json_each(c.result_json, '$.effects') e
      WHERE c.id = NEW.command_id AND c.household_id = NEW.household_id
        AND json_type(c.result_json, '$.schemaVersion') = 'integer'
        AND json_extract(c.result_json, '$.schemaVersion') = 2
        AND json_extract(c.result_json, '$.commandType') = 'USE'
        AND json_extract(c.result_json, '$.mode') = 'FEFO'
        AND json_extract(e.value, '$.legacyItemId') = NEW.inventory_item_id
        AND json_extract(e.value, '$.ordinal') = CAST(e.key AS INTEGER)
    ), expected AS (
      SELECT effect.*, json_object(
        'schemaVersion', 2, 'householdId', household_id, 'actorId', actor_id,
        'commandId', id, 'commandType', 'USE', 'mode', 'FEFO',
        'ordinal', json_extract(effect, '$.ordinal'),
        'effectCount', json_array_length(result_json, '$.effects'),
        'before', json_extract(effect, '$.before'), 'after', json_extract(effect, '$.after'),
        'deltaMilli', json_extract(effect, '$.deltaMilli'),
        'source', json_object('type', json_extract(effect, '$.after.sourceType'), 'id', json_extract(effect, '$.after.sourceId')),
        'timestamp', created_at, 'clientKey', client_key, 'fingerprint', fingerprint,
        'allocation', json_array(json_object('lotId', json_extract(effect, '$.after.id'),
          'deltaMilli', json_extract(effect, '$.deltaMilli'), 'canonicalUnit', json_extract(effect, '$.after.canonicalUnit')))
      ) AS expected_metadata
      FROM effect
    )
    SELECT 1 FROM expected e
    WHERE NEW.created_at = e.created_at
      AND NEW.event_type = 'MANUAL_UPDATE'
      AND NEW.reason IS json_extract(e.fingerprint, '$.command.reason')
      AND NEW.quantity_delta = json_extract(e.effect, '$.deltaMilli') / 1000.0
      AND NEW.unit = json_extract(e.effect, '$.after.canonicalUnit')
      AND NEW.unit IN ('g', 'ml', 'piece')
      AND NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(NEW.metadata)
        EXCEPT SELECT fullkey, type, atom FROM json_tree(e.expected_metadata))
      AND NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(e.expected_metadata)
        EXCEPT SELECT fullkey, type, atom FROM json_tree(NEW.metadata))
  ) THEN RAISE(ABORT, 'Inventory FEFO command event evidence mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM inventory_commands c
    JOIN json_each(c.result_json, '$.effects') e
    JOIN inventory_lots l ON l.legacy_item_id = NEW.inventory_item_id AND l.household_id = c.household_id
    JOIN inventory_items i ON i.id = l.legacy_item_id AND i.household_id = l.household_id
    JOIN storage_locations s ON s.id = l.storage_location_id AND s.household_id = l.household_id
    WHERE c.id = NEW.command_id AND c.household_id = NEW.household_id
      AND json_extract(e.value, '$.legacyItemId') = NEW.inventory_item_id
      AND json_extract(e.value, '$.ordinal') = CAST(e.key AS INTEGER)
      AND json_extract(e.value, '$.after.id') = l.id
      AND json_extract(e.value, '$.after.householdId') = l.household_id
      AND json_extract(e.value, '$.after.ingredientId') IS l.ingredient_id
      AND json_extract(e.value, '$.after.rawName') IS l.raw_name
      AND json_extract(e.value, '$.after.quantityMilli') IS l.quantity_milli
      AND json_extract(e.value, '$.after.canonicalUnit') IS l.canonical_unit
      AND json_extract(e.value, '$.after.storageLocationId') IS l.storage_location_id
      AND json_extract(e.value, '$.after.state') IS l.state
      AND json_extract(e.value, '$.after.version') IS l.version
      AND json_extract(e.value, '$.after.legacyVersion') IS l.legacy_version
      AND json_extract(e.value, '$.after.purchasedAt') IS l.purchased_at
      AND json_extract(e.value, '$.after.openedAt') IS l.opened_at
      AND json_extract(e.value, '$.after.expiryAt') IS l.expiry_at
      AND json_extract(e.value, '$.after.estimatedExpiryAt') IS l.estimated_expiry_at
      AND json_extract(e.value, '$.after.expiryKind') IS l.expiry_kind
      AND json_extract(e.value, '$.after.sourceType') IS l.source_type
      AND json_extract(e.value, '$.after.sourceId') IS l.source_id
      AND json_extract(e.value, '$.after.createdAt') IS l.created_at
      AND json_extract(e.value, '$.after.updatedAt') IS l.updated_at
      AND json_type(e.value, '$.after.purchasePrice') IS CASE WHEN l.currency IS NULL THEN 'null' ELSE 'object' END
      AND json_extract(e.value, '$.after.purchasePrice.currency') IS l.currency
      AND json_extract(e.value, '$.after.purchasePrice.amountMinor') IS l.amount_minor
      AND json_extract(e.value, '$.after.purchasePrice.minorDigits') IS l.minor_digits
      AND json_extract(e.value, '$.after.legacyExpiryAt') IS l.legacy_expiry_at
      AND json_extract(e.value, '$.after.legacyExpiryKind') IS l.legacy_expiry_kind
      AND json_extract(e.value, '$.after.legacyExpirySource') IS l.legacy_expiry_source
      AND json_extract(e.value, '$.after.legacyOpenedAt') IS l.legacy_opened_at
      AND i.quantity = l.quantity_milli / 1000.0
      AND i.unit = l.canonical_unit AND i.version = l.legacy_version
      AND i.name IS l.raw_name AND i.ingredient_id IS l.ingredient_id
      AND i.storage IS lower(s.type)
  ) THEN RAISE(ABORT, 'Inventory FEFO command event evidence mismatch') END;
  -- The written lot must be its authoritative mapping: native equal-ID or a
  -- proven adopted synthetic mapping with a preserved version offset.
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM inventory_commands c
    JOIN json_each(c.result_json, '$.effects') e
      ON json_extract(e.value, '$.legacyItemId') = NEW.inventory_item_id
      AND json_extract(e.value, '$.ordinal') = CAST(e.key AS INTEGER)
    JOIN inventory_lots l ON l.id = json_extract(e.value, '$.after.id')
      AND l.household_id = c.household_id
    WHERE c.id = NEW.command_id AND c.household_id = NEW.household_id
      AND (l.id IS l.legacy_item_id OR EXISTS (
        SELECT 1 FROM inventory_adoption_receipts ar
        JOIN json_each(ar.result_json, '$.effects') ae
          ON json_extract(ae.value, '$.lotId') IS l.id
          AND json_extract(ae.value, '$.legacyItemId') IS l.legacy_item_id
        WHERE ar.household_id IS l.household_id
          AND json_extract(ar.result_json, '$.schemaVersion') IS 3
          AND json_extract(ar.result_json, '$.commandType') IS 'ADOPT'
          AND json_extract(ar.result_json, '$.householdId') IS ar.household_id
          AND json_extract(ar.result_json, '$.actorId') IS ar.actor_id
          AND json_extract(ar.result_json, '$.sourceInventoryVersion') IS ar.source_inventory_version
          AND json_extract(ae.value, '$.after.householdId') IS l.household_id
          AND json_extract(ae.value, '$.after.createdAt') IS l.created_at
          AND json_extract(ae.value, '$.after.sourceType') IS 'LEGACY_BACKFILL'
          AND json_extract(ae.value, '$.after.sourceId') IS l.legacy_item_id
          AND json_extract(ae.value, '$.after.version') <= l.version
          AND l.version - json_extract(ae.value, '$.after.version')
            IS l.legacy_version - json_extract(ae.value, '$.after.legacyVersion')
      ))
  ) THEN RAISE(ABORT, 'Inventory FEFO command event evidence mismatch') END;
END;
