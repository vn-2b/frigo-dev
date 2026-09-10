-- Evidence must match the stock written in the same transaction, not only itself.
CREATE TRIGGER trg_inventory_events_command_poststate_insert
BEFORE INSERT ON inventory_events WHEN NEW.command_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM inventory_commands c
    JOIN inventory_lots l ON l.legacy_item_id = NEW.inventory_item_id AND l.household_id = c.household_id
    JOIN inventory_items i ON i.id = l.legacy_item_id AND i.household_id = l.household_id
    JOIN storage_locations s ON s.id = l.storage_location_id AND s.household_id = l.household_id
    WHERE c.id = NEW.command_id AND c.household_id = NEW.household_id
      AND json_extract(c.result_json, '$.effects[0].after.id') = l.id
      AND json_extract(c.result_json, '$.effects[0].after.householdId') = l.household_id
      AND json_extract(c.result_json, '$.effects[0].after.ingredientId') IS l.ingredient_id
      AND json_extract(c.result_json, '$.effects[0].after.rawName') = l.raw_name
      AND json_extract(c.result_json, '$.effects[0].after.quantityMilli') = l.quantity_milli
      AND json_extract(c.result_json, '$.effects[0].after.canonicalUnit') = l.canonical_unit
      AND json_extract(c.result_json, '$.effects[0].after.storageLocationId') = l.storage_location_id
      AND json_extract(c.result_json, '$.effects[0].after.state') = l.state
      AND json_extract(c.result_json, '$.effects[0].after.version') = l.version
      AND json_extract(c.result_json, '$.effects[0].after.legacyVersion') IS l.legacy_version
      AND json_extract(c.result_json, '$.effects[0].after.purchasedAt') IS l.purchased_at
      AND json_extract(c.result_json, '$.effects[0].after.openedAt') IS l.opened_at
      AND json_extract(c.result_json, '$.effects[0].after.expiryAt') IS l.expiry_at
      AND json_extract(c.result_json, '$.effects[0].after.estimatedExpiryAt') IS l.estimated_expiry_at
      AND json_extract(c.result_json, '$.effects[0].after.expiryKind') = l.expiry_kind
      AND json_extract(c.result_json, '$.effects[0].after.sourceType') = l.source_type
      AND json_extract(c.result_json, '$.effects[0].after.sourceId') IS l.source_id
      AND json_extract(c.result_json, '$.effects[0].after.createdAt') = l.created_at
      AND json_extract(c.result_json, '$.effects[0].after.updatedAt') = l.updated_at
      AND json_extract(c.result_json, '$.effects[0].after.purchasePrice.currency') IS l.currency
      AND json_extract(c.result_json, '$.effects[0].after.purchasePrice.amountMinor') IS l.amount_minor
      AND json_extract(c.result_json, '$.effects[0].after.purchasePrice.minorDigits') IS l.minor_digits
      AND json_extract(c.result_json, '$.effects[0].after.legacyExpiryAt') IS l.legacy_expiry_at
      AND json_extract(c.result_json, '$.effects[0].after.legacyExpiryKind') IS l.legacy_expiry_kind
      AND json_extract(c.result_json, '$.effects[0].after.legacyExpirySource') IS l.legacy_expiry_source
      AND json_extract(c.result_json, '$.effects[0].after.legacyOpenedAt') IS l.legacy_opened_at
      AND i.quantity = l.quantity_milli / 1000.0
      AND i.unit = l.canonical_unit AND i.version = l.legacy_version
      AND i.name = l.raw_name AND i.ingredient_id IS l.ingredient_id
      AND i.storage = lower(s.type)
  ) THEN RAISE(ABORT, 'Inventory command event evidence mismatch') END;
END;
