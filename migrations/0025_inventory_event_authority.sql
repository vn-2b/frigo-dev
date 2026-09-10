-- Validate new native evidence without rewriting retained receipts or historical events.
CREATE TRIGGER trg_inventory_events_command_authority_insert
BEFORE INSERT ON inventory_events WHEN NEW.command_id IS NOT NULL BEGIN
  -- Separate JSON validity checks keep malformed input out of JSON extraction.
  SELECT CASE WHEN typeof(NEW.metadata) <> 'text' OR json_valid(NEW.metadata) IS NOT 1
    THEN RAISE(ABORT, 'Inventory command event evidence mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM inventory_commands c WHERE c.id = NEW.command_id
      AND c.household_id = NEW.household_id
      AND typeof(c.result_json) = 'text' AND json_valid(c.result_json) = 1
      AND typeof(c.fingerprint) = 'text' AND json_valid(c.fingerprint) = 1
  ) THEN RAISE(ABORT, 'Inventory command event evidence mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    WITH evidence AS (
      SELECT c.*, json_object(
        'schemaVersion', 1, 'householdId', c.household_id, 'actorId', c.actor_id,
        'commandId', c.id, 'commandType', c.command_type,
        'before', json_extract(c.result_json, '$.effects[0].before'),
        'after', json_extract(c.result_json, '$.effects[0].after'),
        'deltaMilli', json_extract(c.result_json, '$.effects[0].deltaMilli'),
        'source', json_object(
          'type', json_extract(c.result_json, '$.effects[0].after.sourceType'),
          'id', json_extract(c.result_json, '$.effects[0].after.sourceId')),
        'timestamp', c.created_at, 'clientKey', c.client_key, 'fingerprint', c.fingerprint,
        'allocation', json_array(json_object(
          'lotId', json_extract(c.result_json, '$.effects[0].after.id'),
          'deltaMilli', json_extract(c.result_json, '$.effects[0].deltaMilli'),
          'canonicalUnit', json_extract(c.result_json, '$.effects[0].after.canonicalUnit')))
      ) AS expected_metadata
      FROM inventory_commands c
      JOIN inventory_lots l ON l.legacy_item_id = NEW.inventory_item_id AND l.household_id = c.household_id
      WHERE c.id = NEW.command_id AND c.household_id = NEW.household_id
        AND json_type(c.result_json) = 'object' AND json_type(c.fingerprint) = 'object'
        AND json_type(c.fingerprint, '$.command') = 'object'
        AND json_extract(c.fingerprint, '$.householdId') = c.household_id
        AND json_extract(c.fingerprint, '$.actorId') = c.actor_id
        AND json_extract(c.fingerprint, '$.command.type') = c.command_type
        AND json_extract(c.fingerprint, '$.command.lotId') = l.id
        AND json_extract(c.result_json, '$.commandId') = c.id
        AND json_extract(c.result_json, '$.commandType') = c.command_type
        AND json_extract(c.result_json, '$.lotId') = l.id
        -- Schema version 1 is the native single-lot command contract, not FEFO.
        AND json_type(c.result_json, '$.effects') = 'array'
        AND json_array_length(c.result_json, '$.effects') = 1
        AND json_type(c.result_json, '$.effects[0]') = 'object'
        AND json_type(c.result_json, '$.effects[0].changed') = 'true'
        AND json_type(c.result_json, '$.effects[0].after') = 'object'
        AND json_extract(c.result_json, '$.effects[0].after.id') = l.id
        AND json_extract(c.result_json, '$.effects[0].after.householdId') = c.household_id
        AND json_type(c.result_json, '$.version') = 'integer'
        AND json_extract(c.result_json, '$.version') BETWEEN 1 AND 9007199254740991
        AND json_type(c.result_json, '$.effects[0].after.version') = 'integer'
        AND json_extract(c.result_json, '$.effects[0].after.version') = json_extract(c.result_json, '$.version')
        AND json_extract(c.result_json, '$.effects[0].after.updatedAt') = c.created_at
        AND NEW.created_at = c.created_at
        AND json_type(c.result_json, '$.effects[0].after.quantityMilli') = 'integer'
        AND json_extract(c.result_json, '$.effects[0].after.quantityMilli') BETWEEN 0 AND 9007199254740991
        AND json_type(c.result_json, '$.effects[0].after.sourceType') = 'text'
        AND json_type(c.result_json, '$.effects[0].after.sourceId') IN ('text', 'null')
        AND json_type(c.result_json, '$.effects[0].deltaMilli') = 'integer'
        AND json_extract(c.result_json, '$.effects[0].deltaMilli') BETWEEN -9007199254740991 AND 9007199254740991
        AND json_extract(c.result_json, '$.effects[0].deltaMilli') =
          json_extract(c.result_json, '$.effects[0].after.quantityMilli')
          - CASE WHEN c.command_type = 'CREATE' THEN 0 ELSE json_extract(c.result_json, '$.effects[0].before.quantityMilli') END
        AND NEW.quantity_delta = json_extract(c.result_json, '$.effects[0].deltaMilli') / 1000.0
        AND NEW.unit = json_extract(c.result_json, '$.effects[0].after.canonicalUnit')
        AND NEW.unit IN ('g', 'ml', 'piece', 'pack', 'bunch', 'slice')
        AND NEW.event_type = CASE c.command_type WHEN 'CREATE' THEN 'ADD' WHEN 'DISCARD' THEN 'DISCARD' ELSE 'MANUAL_UPDATE' END
        -- Reason stays in the legacy column and is bound to the fingerprint's intent.
        AND NEW.reason IS json_extract(c.fingerprint, '$.command.reason')
        AND CASE WHEN c.command_type = 'CORRECT' THEN
          json_type(c.fingerprint, '$.command.reason') = 'text'
          AND length(trim(json_extract(c.fingerprint, '$.command.reason'), char(9) || char(10) || char(13) || ' ')) > 0
          WHEN c.command_type IN ('USE', 'DISCARD') THEN
            json_type(c.fingerprint, '$.command.reason') IS NULL OR json_type(c.fingerprint, '$.command.reason') = 'text'
          ELSE json_type(c.fingerprint, '$.command.reason') IS NULL END
        AND CASE WHEN c.command_type = 'CREATE' THEN
          json_type(c.result_json, '$.effects[0].before') = 'null'
          AND json_extract(c.result_json, '$.version') = 1
          ELSE json_type(c.result_json, '$.effects[0].before') = 'object'
            AND json_extract(c.result_json, '$.effects[0].before.id') = l.id
            AND json_extract(c.result_json, '$.effects[0].before.householdId') = c.household_id
            AND json_extract(c.result_json, '$.effects[0].before.canonicalUnit') = NEW.unit
            AND json_type(c.result_json, '$.effects[0].before.quantityMilli') = 'integer'
            AND json_extract(c.result_json, '$.effects[0].before.quantityMilli') BETWEEN 0 AND 9007199254740991
            AND json_type(c.result_json, '$.effects[0].before.version') = 'integer'
            AND json_extract(c.result_json, '$.effects[0].before.version') BETWEEN 1 AND 9007199254740990
            AND json_extract(c.result_json, '$.effects[0].before.version') + 1 = json_extract(c.result_json, '$.version')
            AND json_extract(c.fingerprint, '$.command.expectedVersion') = json_extract(c.result_json, '$.effects[0].before.version')
            AND json_extract(c.result_json, '$.effects[0].before.sourceType') = json_extract(c.result_json, '$.effects[0].after.sourceType')
            AND json_extract(c.result_json, '$.effects[0].before.sourceId') IS json_extract(c.result_json, '$.effects[0].after.sourceId') END
    )
    SELECT 1 FROM evidence e
    -- Compare JSON structure, not serialization order; reject ambiguous duplicate keys.
    WHERE NOT EXISTS (
      SELECT fullkey, type, atom FROM json_tree(NEW.metadata)
      EXCEPT SELECT fullkey, type, atom FROM json_tree(e.expected_metadata)
    ) AND NOT EXISTS (
      SELECT fullkey, type, atom FROM json_tree(e.expected_metadata)
      EXCEPT SELECT fullkey, type, atom FROM json_tree(NEW.metadata)
    ) AND NOT EXISTS (
      SELECT fullkey FROM json_tree(NEW.metadata) GROUP BY fullkey HAVING count(*) > 1
    ) AND NOT EXISTS (
      SELECT fullkey FROM json_tree(e.result_json) GROUP BY fullkey HAVING count(*) > 1
    ) AND NOT EXISTS (
      SELECT fullkey FROM json_tree(e.fingerprint) GROUP BY fullkey HAVING count(*) > 1
    )
  ) THEN RAISE(ABORT, 'Inventory command event evidence mismatch') END;
END;
