import { fetchJson } from './http';

// T13 Inventory UX V2 client. These calls read canonical lot truth and submit
// reconciliation INTENT only: the server owns every decision semantic, so no
// authoritative inventory state is ever sent from here.

// The server bounds decisionKey at 160 characters, but a real observation id
// (prefix + household + source type + a digest-collapsed source ref) is longer
// than that on its own. Collapse to a stable digest rather than truncating,
// which would make two different decisions share one idempotency key.
export const MAX_DECISION_KEY = 160;

async function boundedDecisionKey(key: string): Promise<string> {
  if (key.length <= MAX_DECISION_KEY) return key;
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `ux:${hex}`;
}

export interface InventoryLotDetail {
  id: string;
  lotId: string;
  legacyItemId: string | null;
  name: string;
  ingredientId: string | null;
  category: string;
  quantity: number;
  unit: string;
  quantityMilli: number;
  canonicalUnit: string;
  storage: string;
  storageLocationId: string;
  state: 'ACTIVE' | 'CONSUMED' | 'DISCARDED';
  freshness: string;
  expiryKind: 'KNOWN' | 'BEST_BEFORE' | 'USE_BY' | 'ESTIMATED' | 'UNKNOWN';
  expiryAt: string | null;
  estimatedExpiryAt: string | null;
  openedAt: string | null;
  purchasedAt: string | null;
  sourceType: string;
  dataSource: string;
  sourceId: string | null;
  lotVersion: number;
  version: number;
  inventoryVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryObservationView {
  observationId: string;
  sourceType: string;
  sourceRef: string;
  dataSource: string;
  observedAt: string;
  recordedAt: string;
  rawName: string | null;
  ingredientId: string | null;
  lotId: string | null;
  legacyItemId: string | null;
  evidence: string;
  note: string | null;
  status: 'OPEN' | 'RECONCILED' | 'STALE';
  version: number;
  claim: Record<string, unknown>;
  verdict: string | null;
  reasons: string[];
  matchedLotId: string | null;
  proposals: unknown[];
}

export const inventoryTruthApi = {
  getInventoryLot: async (lotId: string): Promise<InventoryLotDetail> => {
    const res = await fetchJson<{ lot: InventoryLotDetail }>(`/inventory/lots/${encodeURIComponent(lotId)}`);
    return res.lot;
  },

  getInventorySummary: async (): Promise<{ inventoryVersion: number; activeCount: number; items: InventoryLotDetail[] }> =>
    fetchJson('/inventory/summary'),

  getInventoryObservations: async (status: 'OPEN' | 'RECONCILED' | 'STALE' = 'OPEN'): Promise<InventoryObservationView[]> => {
    const res = await fetchJson<{ observations: InventoryObservationView[] }>(
      `/inventory/observations?status=${encodeURIComponent(status)}`);
    return res.observations;
  },

  /**
   * Submit a reconciliation decision. The proposals echoed back are the
   * server's own plan; it re-derives and re-validates them, so a stale plan is
   * rejected rather than applied.
   */
  decideInventoryObservation: async (input: {
    observationId: string;
    expectedObservationVersion: number;
    decisionType: 'CORRECT' | 'MOVE' | 'DISMISS';
    proposals?: unknown[];
    decisionKey?: string;
  }) => {
    const decisionKey = input.decisionKey
      // A stable per-attempt key makes a response-loss retry replay the same
      // decision instead of deciding twice.
      ?? await boundedDecisionKey(
        `ux:${input.observationId}:${input.decisionType}:${input.expectedObservationVersion}`);
    return fetchJson<{ success: boolean; idempotentReplay?: boolean; decision: Record<string, unknown> }>(
      `/inventory/observations/${encodeURIComponent(input.observationId)}/decision`,
      {
        method: 'POST',
        body: JSON.stringify({
          decisionKey,
          observationId: input.observationId,
          expectedObservationVersion: input.expectedObservationVersion,
          decisionType: input.decisionType,
          ...(input.decisionType === 'DISMISS' ? {} : { proposals: input.proposals ?? [] }),
        }),
      });
  },
};
