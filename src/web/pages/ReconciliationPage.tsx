import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { TopBar } from '../components/common/TopBar';
import { Button } from '../components/common/Button';
import { EmptyState } from '../components/common/EmptyState';
import { InlineLoading, InlineError } from '../components/common/AsyncState';
import { api, ApiError } from '../services/api';
import { queryKeys } from '../lib/queryKeys';
import { invalidateInventoryDependents } from '../lib/query-invalidation';
import { presentDomainError, provenanceLabel } from '../lib/inventory-truth';
import type { InventoryObservationView } from '../services/inventory-truth';
import { ScanLine } from 'lucide-react';

// T13 reconciliation surface. It shows what was observed, what the fridge
// currently says and which difference the server's planner found — then
// submits INTENT only. Every decision semantic stays on the server.

const VERDICT_LABEL: Record<string, string> = {
  MATCH: 'Khớp với tủ lạnh',
  NO_ACTION: 'Không cần xử lý',
  STALE_OBSERVATION: 'Bằng chứng đã cũ',
  AMBIGUOUS: 'Chưa xác định được lô',
  CONFLICT: 'Có mâu thuẫn cần bạn quyết định',
  PROPOSE_CORRECTION: 'Đề xuất sửa số lượng',
  PROPOSE_MOVE: 'Đề xuất chuyển vị trí',
  PROPOSE_EXPIRY_UPDATE: 'Đề xuất cập nhật hạn dùng',
  UNSUPPORTED: 'Chưa hỗ trợ tự động',
};

const REASON_LABEL: Record<string, string> = {
  QUANTITY_MISMATCH: 'Số lượng ghi nhận khác với tủ lạnh',
  STORAGE_MISMATCH: 'Vị trí bảo quản khác với tủ lạnh',
  EXPIRY_MISMATCH: 'Hạn dùng khác với tủ lạnh',
  EXPIRY_EVIDENCE_UPGRADE: 'Xác nhận hạn dùng đang là ước tính',
  NO_MATCHING_LOT: 'Chưa có lô tương ứng trong tủ',
  MULTIPLE_CANDIDATES: 'Có nhiều lô trùng tên',
  INCOMPATIBLE_UNIT: 'Đơn vị không quy đổi được',
};

function claimSummary(observation: InventoryObservationView): string {
  const claim = observation.claim as Record<string, unknown>;
  const parts: string[] = [];
  if (claim.quantity !== null && claim.quantity !== undefined) {
    parts.push(`${claim.quantity} ${claim.unit ?? ''}`.trim());
  }
  if (claim.storage) parts.push(String(claim.storage));
  if (claim.expiryDate) {
    parts.push(claim.expiryKind === 'ESTIMATED' ? `hạn ước tính ${claim.expiryDate}` : `hạn ${claim.expiryDate}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Không có số liệu cụ thể';
}

export const ReconciliationPage: React.FC = () => {
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);

  const observationsQuery = useQuery({
    queryKey: queryKeys.inventoryObservations(),
    queryFn: () => api.getInventoryObservations('OPEN'),
    retry: false,
  });

  const decide = useMutation({
    mutationFn: (input: { observation: InventoryObservationView; accept: boolean }) => {
      const { observation, accept } = input;
      if (!accept) {
        return api.decideInventoryObservation({
          observationId: observation.observationId,
          expectedObservationVersion: observation.version,
          decisionType: 'DISMISS',
        });
      }
      // The decision type follows the server's own verdict; the client never
      // invents a mutation of its own.
      const decisionType = observation.verdict === 'PROPOSE_MOVE' ? 'MOVE' : 'CORRECT';
      return api.decideInventoryObservation({
        observationId: observation.observationId,
        expectedObservationVersion: observation.version,
        decisionType,
        proposals: observation.proposals,
      });
    },
    onSuccess: async () => {
      setActionError(null);
      await invalidateInventoryDependents();
      await observationsQuery.refetch();
    },
    onError: async (error: unknown) => {
      const code = error instanceof ApiError ? error.code : null;
      const presentation = presentDomainError(code, 'Chưa xử lý được mục đối chiếu. Vui lòng thử lại.');
      setActionError(presentation.message);
      // Stale or already-decided evidence only makes sense after a reload.
      if (presentation.refetch) await observationsQuery.refetch();
    },
  });

  const observations = observationsQuery.data ?? [];

  return (
    <div className="min-h-screen bg-[#F8FAF9] pb-28 max-w-md mx-auto">
      <TopBar showBack title="Đối chiếu tủ lạnh" subtitle="Bằng chứng từ hóa đơn & ảnh quét" />

      <div className="px-4 pt-3 space-y-3">
        {actionError && (
          <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 font-medium" role="alert">
            {actionError}
          </p>
        )}

        {observationsQuery.isPending ? (
          <InlineLoading label="Đang tải mục cần đối chiếu…" />
        ) : observationsQuery.isError ? (
          <InlineError
            error={observationsQuery.error}
            onRetry={() => void observationsQuery.refetch()}
          />
        ) : observations.length === 0 ? (
          <EmptyState
            title="Không có mục nào cần đối chiếu"
            description="Khi bạn quét hóa đơn hoặc ảnh tủ lạnh, các khác biệt sẽ xuất hiện ở đây."
            actionText="Về tủ lạnh"
            onAction={() => navigate('/fridge')}
          />
        ) : (
          observations.map((observation) => {
            const actionable = observation.proposals.length > 0;
            return (
              <div
                key={observation.observationId}
                data-testid="reconciliation-item"
                className="bg-white rounded-xl p-3.5 border border-slate-200/80 shadow-xs space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <ScanLine className="w-4 h-4 text-emerald-600 shrink-0" />
                    <h4 className="font-heading font-semibold text-sm text-slate-900 truncate">
                      {observation.rawName ?? observation.ingredientId ?? 'Nguyên liệu'}
                    </h4>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-medium shrink-0">
                    {provenanceLabel(observation.dataSource)}
                  </span>
                </div>

                <dl className="text-xs space-y-1">
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500 shrink-0">Ghi nhận</dt>
                    <dd className="text-slate-900 font-medium text-right">{claimSummary(observation)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500 shrink-0">Kết luận</dt>
                    <dd className="text-slate-900 font-medium text-right">
                      {VERDICT_LABEL[observation.verdict ?? ''] ?? 'Đang chờ xử lý'}
                    </dd>
                  </div>
                  {observation.reasons.length > 0 && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500 shrink-0">Khác biệt</dt>
                      <dd className="text-slate-700 text-right">
                        {observation.reasons.map((reason) => REASON_LABEL[reason] ?? reason).join('; ')}
                      </dd>
                    </div>
                  )}
                </dl>

                <div className="flex gap-2 pt-1">
                  <Button
                    fullWidth
                    size="sm"
                    disabled={!actionable || decide.isPending}
                    onClick={() => decide.mutate({ observation, accept: true })}
                  >
                    Áp dụng
                  </Button>
                  <Button
                    fullWidth
                    size="sm"
                    variant="outline"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ observation, accept: false })}
                  >
                    Bỏ qua
                  </Button>
                </div>
                {!actionable && (
                  <p className="text-[11px] text-slate-500">
                    Mục này không có thao tác tự động an toàn; bạn có thể bỏ qua hoặc sửa trực tiếp trong tủ lạnh.
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
