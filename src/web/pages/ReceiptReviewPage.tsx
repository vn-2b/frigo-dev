import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TopBar } from '../components/common/TopBar';
import { QuantityStepper } from '../components/common/QuantityStepper';
import { Button } from '../components/common/Button';
import { api } from '../services/api';
import { useWeekStore } from '../stores/useWeekStore';
import { getIngredientImage } from '../lib/ingredient-images';
import { CheckCircle2, ShoppingBag, Trash2, Store, Calendar, CalendarCheck } from 'lucide-react';
import { StandardUnit } from '@frigo/domain';
import { clsx } from 'clsx';
import { capturePrivateSession } from '../lib/private-session';
import { invalidateInventoryDependents } from '../lib/query-invalidation';
import { presentConfidence, presentDomainError, presentPrice, presentPurchaseDate } from '../lib/inventory-truth';
import { ApiError } from '../services/http';

interface ReceiptItemState {
  id: string;
  rawName: string;
  canonicalId?: string;
  estimatedQuantity: number;
  unit: StandardUnit;
  unitPriceVnd?: number;
  totalPriceVnd?: number;
  category?: string;
  storage: 'fridge' | 'freezer' | 'pantry';
  /** Provider-reported confidence; undefined means the model reported none. */
  confidence?: number;
  /** Raw OCR extraction, retained separately from the confirmed value. */
  rawEvidence?: { rawName?: string; estimatedQuantity?: number; unit?: StandardUnit };
  /** Explicit reviewer rejection, recorded durably by the server. */
  rejected?: boolean;
}

export const ReceiptReviewPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const receiptScanId = searchParams.get('scanId');
  return <ReceiptReview key={receiptScanId || ''} receiptScanId={receiptScanId} />;
};

const ReceiptReview: React.FC<{ receiptScanId: string | null }> = ({ receiptScanId }) => {
  const navigate = useNavigate();
  const currentPlan = useWeekStore((s) => s.currentPlan);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // History survives logout. Only the authorized scan endpoint may supply receipt data.
  const [liveReceipt, setLiveReceipt] = useState<any>({
    id: receiptScanId || '', status: receiptScanId ? 'pending' : 'failed', items: [],
  });
  const [pollError, setPollError] = useState<string | null>(
    receiptScanId ? null : 'Không tìm thấy bản quét hóa đơn. Vui lòng quay lại và quét ảnh mới.'
  );
  const isPending = liveReceipt.status === 'pending' || liveReceipt.status === 'processing';
  const isReady = liveReceipt.status === 'ready' || liveReceipt.status === 'confirmed';

  // Async receipt scans arrive as a pending DTO. Poll the tenant-scoped scan
  // endpoint until the queue processor publishes ready/failed state.
  useEffect(() => {
    if (!liveReceipt.id || !isPending) return;
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      try {
        const next = await api.getScan(liveReceipt.id);
        if (cancelled) return;
        setLiveReceipt(next);
        if (next.status === 'pending' || next.status === 'processing') {
          attempts += 1;
          if (attempts < 60) window.setTimeout(poll, 1000);
          else setPollError('Bản quét đang mất nhiều thời gian hơn dự kiến. Vui lòng thử lại sau.');
        } else if (next.status === 'failed') {
          setPollError('Không thể đọc hóa đơn. Vui lòng thử lại với ảnh rõ nét hơn.');
        }
      } catch {
        if (!cancelled) setPollError('Không thể cập nhật trạng thái hóa đơn. Vui lòng tải lại trang.');
      }
    };
    const timer = window.setTimeout(poll, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [liveReceipt.id, isPending]);

  const [items, setItems] = useState<ReceiptItemState[]>([]);
  useEffect(() => {
    if (Array.isArray(liveReceipt.items) && liveReceipt.items.length > 0) {
      setItems(liveReceipt.items);
    }
  }, [liveReceipt.items]);
  // Rejected lines stay in the request (the server records the rejection)
  // but they are not part of what will enter the fridge.
  const acceptedItems = items.filter((it) => !it.rejected);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const handleUpdateQty = (id: string, delta: number) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id === id) {
          const newQty = Math.max(1, it.estimatedQuantity + delta);
          const newTotal = it.unitPriceVnd ? it.unitPriceVnd * (it.unit === 'g' ? newQty / 1000 : newQty) : undefined;
          return { ...it, estimatedQuantity: newQty, totalPriceVnd: newTotal };
        }
        return it;
      })
    );
  };

  // T13: rejecting a line is durable review evidence, so it is toggled and
  // submitted explicitly rather than silently dropped from the request.
  const handleToggleReject = (id: string) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, rejected: !it.rejected } : it)));
  };

  const handleRename = (id: string, rawName: string) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, rawName } : it)));
  };

  const handleStorage = (id: string, storage: 'fridge' | 'freezer' | 'pantry') => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, storage } : it)));
  };

  const handleImportToFridge = async () => {
    if (acceptedItems.length === 0 || !isReady) return;
    const isCurrent = capturePrivateSession();
    setIsSubmitting(true);
    try {
      await api.confirmScan(liveReceipt.id, items);
      if (!mounted.current || !isCurrent()) return;
      void invalidateInventoryDependents();
      setSuccessToast('Đã nhập nguyên liệu hóa đơn vào tủ lạnh thành công!');
      setTimeout(() => {
        if (mounted.current && isCurrent()) navigate('/fridge');
      }, 1200);
    } catch (err) {
      if (!mounted.current || !isCurrent()) return;
      // Recoverable domain states get specific guidance, never raw JSON.
      const code = err instanceof ApiError ? err.code : null;
      setPollError(presentDomainError(code, 'Chưa nhập được nguyên liệu. Vui lòng thử lại.').message);
      setIsSubmitting(false);
    }
  };

  const handleReconcileWeeklyPlan = async () => {
    if (acceptedItems.length === 0 || !isReady) return;
    const isCurrent = capturePrivateSession();
    setIsSubmitting(true);
    try {
      await api.confirmScan(liveReceipt.id, items);
      if (!mounted.current || !isCurrent()) return;
      setSuccessToast('Đã đối chiếu hóa đơn & cập nhật tủ lạnh!');
      setTimeout(() => {
        if (!mounted.current || !isCurrent()) return;
        if (currentPlan) {
          navigate(`/week/${currentPlan.id}/shopping`);
        } else {
          navigate('/week');
        }
      }, 1200);
    } catch (err) {
      console.error('Failed to reconcile with week plan:', err);
      setIsSubmitting(false);
    }
  };

  const calculatedTotal = acceptedItems.reduce((sum, it) => sum + (it.totalPriceVnd || 0), 0);

  return (
    <div className="min-h-screen bg-[#F8FAF9] pb-32 max-w-md mx-auto">
      <TopBar showBack title="Chi tiết Hóa đơn" subtitle="Bóc tách tự động bởi AI Vision" />

      {/* Success Toast */}
      {successToast && (
        <div className="fixed top-16 left-4 right-4 z-50 bg-slate-900 text-white px-4 py-3 rounded-xl shadow-lg flex items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-200 max-w-md mx-auto border border-white/10">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          <p className="text-xs font-semibold leading-tight">{successToast}</p>
        </div>
      )}

      <div className="px-4 pt-3 space-y-4">
        {isPending && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Hóa đơn đang được AI xử lý nền. Trang sẽ tự cập nhật khi hoàn tất...
          </div>
        )}
        {pollError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {pollError}
          </div>
        )}
        {/* Receipt Header Card */}
        <div className="bg-white rounded-xl p-4 border border-slate-200/80 shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-700 shrink-0">
                <Store className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-heading font-bold text-sm text-slate-900">
                  {liveReceipt.merchantName || 'Không rõ cửa hàng'}
                </h3>
                <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                  <Calendar className="w-3 h-3 text-slate-400" />
                  <span>{presentPurchaseDate(liveReceipt.purchaseDate)}</span>
                  {liveReceipt.invoiceNumber && <span>• {liveReceipt.invoiceNumber}</span>}
                </p>
              </div>
            </div>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200/60">
              AI OCR
            </span>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
            <span className="text-xs text-slate-500">Tổng thanh toán:</span>
            <span className="font-heading font-bold text-lg text-slate-900">
              {presentPrice(calculatedTotal || liveReceipt.totalAmountVnd)}
            </span>
          </div>
        </div>

        {/* Extracted Items Count */}
        <div className="flex items-center justify-between px-1">
          <h4 className="font-heading font-semibold text-sm text-slate-900">
            Hàng hóa nhận diện ({items.length} món)
          </h4>
          <span className="text-xs text-slate-500">Chạm để chỉnh số lượng</span>
        </div>

        {/* Items List */}
        <div className="space-y-2.5">
          {items.map((item) => {
            const confidence = presentConfidence(item.confidence);
            const corrected = item.rawEvidence
              && (item.rawEvidence.estimatedQuantity !== undefined
                && item.rawEvidence.estimatedQuantity !== item.estimatedQuantity);
            return (
              <div
                key={item.id}
                data-testid="receipt-line"
                className={clsx('bg-white rounded-xl p-3 border shadow-xs space-y-2',
                  item.rejected ? 'border-rose-200 bg-rose-50/40 opacity-70' : 'border-slate-200/80')}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-lg bg-slate-50 border border-slate-100 p-1.5 shrink-0 flex items-center justify-center">
                      <img
                        src={getIngredientImage(item.canonicalId || item.rawName)}
                        alt={item.rawName}
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <label className="sr-only" htmlFor={`receipt-name-${item.id}`}>Tên sản phẩm</label>
                      <input
                        id={`receipt-name-${item.id}`}
                        value={item.rawName}
                        onChange={(event) => handleRename(item.id, event.target.value)}
                        disabled={item.rejected}
                        className="w-full font-heading font-semibold text-sm text-slate-900 bg-transparent border-b border-transparent focus:border-emerald-500 focus:outline-none disabled:text-slate-400"
                      />
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {/* Missing price reads as unknown; never 0đ. */}
                        <span className="text-xs font-semibold text-emerald-700" data-testid="receipt-price">
                          {presentPrice(item.totalPriceVnd)}
                        </span>
                        <span
                          data-testid="receipt-confidence"
                          className={clsx('text-[10px] px-1.5 py-0.5 rounded font-semibold border',
                            confidence.tone === 'unknown' ? 'bg-slate-100 text-slate-600 border-slate-200'
                              : confidence.tone === 'low' ? 'bg-rose-50 text-rose-800 border-rose-200'
                                : confidence.tone === 'medium' ? 'bg-amber-50 text-amber-900 border-amber-200'
                                  : 'bg-emerald-50 text-emerald-800 border-emerald-200/60')}
                        >
                          {confidence.label}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <QuantityStepper
                      quantity={item.estimatedQuantity}
                      unit={item.unit}
                      onIncrement={() => handleUpdateQty(item.id, item.unit === 'g' ? 100 : 1)}
                      onDecrement={() => handleUpdateQty(item.id, item.unit === 'g' ? -100 : -1)}
                    />
                    <button
                      type="button"
                      onClick={() => handleToggleReject(item.id)}
                      aria-label={item.rejected ? `Khôi phục ${item.rawName}` : `Bỏ qua ${item.rawName}`}
                      aria-pressed={Boolean(item.rejected)}
                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors tap-target"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <label className="sr-only" htmlFor={`receipt-storage-${item.id}`}>Nơi bảo quản</label>
                  <select
                    id={`receipt-storage-${item.id}`}
                    value={item.storage}
                    disabled={item.rejected}
                    onChange={(event) => handleStorage(item.id, event.target.value as 'fridge' | 'freezer' | 'pantry')}
                    className="text-[11px] px-2 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-700 font-medium"
                  >
                    <option value="fridge">Tủ mát</option>
                    <option value="freezer">Tủ đông</option>
                    <option value="pantry">Tủ khô</option>
                  </select>
                  {corrected && (
                    <span className="text-[10px] text-slate-500" data-testid="receipt-raw-evidence">
                      AI đọc: {item.rawEvidence?.estimatedQuantity} {item.rawEvidence?.unit ?? item.unit}
                    </span>
                  )}
                  {item.rejected && (
                    <span className="text-[10px] font-semibold text-rose-700">Đã bỏ qua khỏi tủ lạnh</span>
                  )}
                </div>
              </div>
            );
          })}

          {items.length === 0 && (
            <div className="text-center py-10 bg-white rounded-xl p-6 border border-slate-200/80">
              <p className="text-xs text-slate-400">Không còn món nào trong hóa đơn</p>
            </div>
          )}
        </div>
      </div>

      {/* Floating Action Bottom */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white/95 backdrop-blur-md border-t border-slate-200/80 z-40 max-w-md mx-auto space-y-2 shadow-lg">
        <Button
          fullWidth
          size="lg"
            disabled={acceptedItems.length === 0 || isSubmitting || !isReady}
          onClick={handleImportToFridge}
          className="flex items-center justify-center gap-2"
        >
          <ShoppingBag className="w-4 h-4" />
          <span>Nhập {acceptedItems.length} món vào Tủ lạnh</span>
        </Button>

        {currentPlan && (
          <Button
            fullWidth
            variant="outline"
            size="md"
          disabled={acceptedItems.length === 0 || isSubmitting || !isReady}
            onClick={handleReconcileWeeklyPlan}
            className="flex items-center justify-center gap-2 text-slate-800"
          >
            <CalendarCheck className="w-4 h-4 text-emerald-600" />
            <span>Đối chiếu & Đánh dấu đi chợ tuần</span>
          </Button>
        )}
      </div>
    </div>
  );
};
