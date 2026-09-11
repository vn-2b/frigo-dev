import { findCanonicalIngredient, computeFreshness } from '@frigo/domain';
import { privateCacheKey } from '../lib/private-session';
import { fetchJson, isOffline, queueWrite, getHouseholdId, readCachedInventory, guardPrivateSession } from './http';

export function isOfflineScanId(scanId: string): boolean {
  return scanId.startsWith('scan_offline_') || scanId.startsWith('receipt_offline_');
}

function queueOfflineScanConfirmation(scanId: string, items: any[]) {
  const householdId = getHouseholdId();
  const now = new Date().toISOString();
  const source = scanId.startsWith('receipt_') ? 'receipt' : 'scan';
  const current = readCachedInventory(householdId);
  const imported: any[] = [];

  items.forEach((item: any, index: number) => {
    const name = String(item.rawName || item.name || 'Nguyên liệu mới').trim();
    const canonical = findCanonicalIngredient(name);
    const rawQuantity = Number(item.estimatedQuantity ?? item.quantity);
    const quantity = Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1;
    const unit = item.unit || canonical?.defaultUnit || 'piece';
    const storage = item.storage || 'fridge';
    const stablePart = String(item.id || index).replace(/[^a-zA-Z0-9_-]/g, '_');
    const id = `offline_${scanId}_${stablePart}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const body = {
      id,
      name,
      quantity,
      unit,
      category: item.category || canonical?.category || 'other',
      storage,
      expiryDate: item.expiryDate,
      dataSource: source,
    };

    queueWrite(
      '/inventory',
      'POST',
      JSON.stringify(body),
      `Lưu ${name} từ ${source === 'receipt' ? 'hóa đơn' : 'bản quét'}`,
      `inventory:${id}`
    );
    imported.push({
      ...body,
      householdId,
      ingredientId: canonical?.id || '',
      freshness: computeFreshness(item.expiryDate),
      version: 1,
      addedDate: now,
      updatedAt: now,
      pendingSync: true,
    });
  });

  const importedById = new Map(imported.map((item) => [item.id, item]));
  const updated = [...imported, ...current.filter((item) => !importedById.has(item.id))];
  localStorage.setItem(privateCacheKey('inventory', householdId), JSON.stringify(updated));
  return {
    success: true,
    items: updated,
    pendingSync: true,
    importedItemsCount: imported.length,
  };
}

export const scansApi = {
  scanFridge: async (imageBase64: string, scanType = 'fridge', commandId?: string) => {
    const assertCurrent = guardPrivateSession();
    try {
      const res = await fetchJson<{ scan: any }>('/scans/fridge', {
        method: 'POST',
        headers: { 'Idempotency-Key': commandId || crypto.randomUUID() },
        body: JSON.stringify({ imageBase64, scanType }),
      });
      assertCurrent();
      return res.scan;
    } catch (err) {
      assertCurrent();
      if (commandId || !isOffline(err)) throw err;
      // Vision requires the server; an offline draft contains only manually reviewed items.
      return {
        id: `scan_offline_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        status: 'ready',
        offline: true,
        items: [],
      };
    }
  },

  scanReceipt: async (imageBase64: string, commandId?: string) => {
    const assertCurrent = guardPrivateSession();
    try {
      const res = await fetchJson<{ receipt?: any; scan?: any }>('/scans/receipt', {
        method: 'POST',
        headers: { 'Idempotency-Key': commandId || crypto.randomUUID() },
        body: JSON.stringify({ imageBase64 }),
      });
      assertCurrent();
      // Async queue responses expose the same scan DTO under `scan`; keep
      // sync receipt responses backward compatible via `receipt`.
      return res.receipt || res.scan;
    } catch (err) {
      assertCurrent();
      if (commandId || !isOffline(err)) throw err;
      // No merchant, amounts, or ingredients are inferred without OCR.
      return {
        id: `receipt_offline_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        status: 'ready',
        offline: true,
        items: [],
      };
    }
  },

  getScan: async (scanId: string) => {
    const res = await fetchJson<{ scan: any }>(`/scans/${encodeURIComponent(scanId)}`);
    return res.scan;
  },

  confirmScan: async (scanId: string, items: any[]) => {
    const assertCurrent = guardPrivateSession();
    const hhId = getHouseholdId();

    // Offline scans have no server-side scan row to confirm. Import their
    // reviewed items as normal inventory mutations, each with a stable id,
    // so the outbox can replay them after connectivity returns.
    if (isOfflineScanId(scanId)) {
      return queueOfflineScanConfirmation(scanId, items);
    }

    const path = `/scans/${scanId}/confirm`;
    const init = { method: 'POST', body: JSON.stringify({ items }) };
    let res: Record<string, unknown> | null;
    try {
      res = await fetchJson<Record<string, unknown> | null>(path, init);
    } catch (err) {
      assertCurrent();
      const bodyTransportFailure = err instanceof TypeError || (err instanceof Error && err.name === 'AbortError');
      if (!isOffline(err) && !bodyTransportFailure) throw err;
      // Confirmation may commit before fetch or its response body fails.
      queueWrite(path, init.method, init.body, 'Xác nhận bản quét khi có kết nối', `scan-confirm:${scanId}`);
      return {
        success: true,
        pendingSync: true,
        items: readCachedInventory(hhId),
      };
    }
    assertCurrent();
    if (res && res.items) {
      localStorage.setItem(privateCacheKey('inventory', hhId), JSON.stringify(res.items));
    }
    return res;
  },
};
