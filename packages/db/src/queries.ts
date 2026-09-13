// Query helpers for Frigo D1 Database

export const SQL = {
  // Inventory
  GET_INVENTORY: `SELECT * FROM inventory_items WHERE household_id = ? ORDER BY added_date DESC`,
  GET_INVENTORY_ITEM: `SELECT * FROM inventory_items WHERE id = ? AND household_id = ?`,
  INSERT_INVENTORY_ITEM: `INSERT INTO inventory_items (id, household_id, ingredient_id, name, quantity, unit, category, storage, expiry_date, added_date, freshness, data_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  UPDATE_INVENTORY_ITEM: `UPDATE inventory_items SET name = ?, ingredient_id = ?, quantity = ?, unit = ?, category = ?, storage = ?, expiry_date = ?, freshness = ?, version = version + 1, updated_at = datetime('now') WHERE id = ? AND household_id = ? AND version = ?`,
  DELETE_INVENTORY_ITEM: `DELETE FROM inventory_items WHERE id = ? AND household_id = ?`,
  
  // Event Sourcing
  INSERT_INVENTORY_EVENT: `INSERT INTO inventory_events (id, household_id, inventory_item_id, event_type, quantity_delta, unit, reason, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  
  // Scans. T13: every writer persists the raw OCR/vision extraction
  // (ocr_*) alongside the reviewable working values, so a later user
  // correction cannot destroy the original evidence. ocr_confidence is NULL
  // when the provider reported none — the legacy NOT NULL `confidence`
  // column cannot express that.
  CREATE_SCAN: `INSERT INTO scans (id, user_id, household_id, image_key, status, scan_type) VALUES (?, ?, ?, ?, ?, ?)`,
  GET_SCAN: `SELECT * FROM scans WHERE id = ?`,
  UPDATE_SCAN_STATUS: `UPDATE scans SET status = ?, updated_at = datetime('now') WHERE id = ?`,
  INSERT_SCAN_ITEM: `INSERT INTO scan_items (id, scan_id, raw_name, canonical_id, estimated_quantity, unit, confidence, category, storage, ocr_raw_name, ocr_quantity, ocr_unit, ocr_confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  INSERT_RECEIPT_SCAN_ITEM: `INSERT INTO scan_items (id, scan_id, raw_name, canonical_id, estimated_quantity, unit, confidence, category, storage, unit_price_vnd, total_price_vnd, ocr_raw_name, ocr_quantity, ocr_unit, ocr_confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  GET_SCAN_ITEMS: `SELECT * FROM scan_items WHERE scan_id = ?`,
  
  // Recipes
  GET_RECIPES: `SELECT * FROM recipes`,
  GET_RECIPE_BY_ID: `SELECT * FROM recipes WHERE id = ? OR slug = ?`,
  
  // Shopping list
  GET_SHOPPING_ITEMS: `SELECT si.* FROM shopping_items si JOIN shopping_lists sl ON si.list_id = sl.id WHERE sl.household_id = ? ORDER BY si.is_checked ASC, si.created_at DESC`,
  INSERT_SHOPPING_ITEM: `INSERT INTO shopping_items (id, list_id, ingredient_id, name, quantity, unit, is_checked, source_recipe_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  UPDATE_SHOPPING_ITEM: `UPDATE shopping_items SET is_checked = ?, quantity = ?, updated_at = datetime('now') WHERE id = ?`,
  DELETE_SHOPPING_ITEM: `DELETE FROM shopping_items WHERE id = ?`,

  // Notifications
  GET_NOTIFICATIONS: `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
  
  // User Preferences & Profiles
  GET_USER_PROFILE: `SELECT u.id, u.email, u.is_guest, p.display_name, p.avatar_url, h.id as household_id, h.name as household_name FROM users u LEFT JOIN profiles p ON u.id = p.user_id LEFT JOIN household_members hm ON u.id = hm.user_id AND hm.household_id = ? LEFT JOIN households h ON hm.household_id = h.id WHERE u.id = ?`,
  GET_USER_PREFERENCES: `SELECT * FROM user_preferences WHERE user_id = ?`,
  UPDATE_USER_PREFERENCES: `UPDATE user_preferences SET household_size = ?, spicy_level = ?, favorite_cuisines = ?, dietary_restrictions = ?, updated_at = datetime('now') WHERE user_id = ?`,
  
  // AI Requests Tracking
  LOG_AI_REQUEST: `INSERT INTO ai_requests (id, user_id, task, provider, model, input_tokens, output_tokens, latency_ms, estimated_cost, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
};
