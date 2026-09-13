import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { TopBar } from '../components/common/TopBar';
import { StatusChip } from '../components/common/StatusChip';
import { Button } from '../components/common/Button';
import { InlineLoading, InlineError } from '../components/common/AsyncState';
import { api, ApiError } from '../services/api';
import { queryKeys } from '../lib/queryKeys';
import { invalidateInventoryDependents } from '../lib/query-invalidation';
import { presentDomainError, presentExpiry, presentPurchaseDate, provenanceLabel } from '../lib/inventory-truth';
import { ALL_RECIPES } from '@frigo/recipes';
import { getIngredientImage } from '../lib/ingredient-images';
import { Clock, ChefHat, Calendar, Layers, ArrowRight, PackageOpen, Receipt } from 'lucide-react';
import { clsx } from 'clsx';

const EXPIRY_TONE_CLASS: Record<string, string> = {
  unknown: 'bg-slate-100 text-slate-700 border-slate-200',
  expired: 'bg-rose-50 text-rose-800 border-rose-200',
  expiring: 'bg-amber-50 text-amber-900 border-amber-200',
  estimated: 'bg-sky-50 text-sky-900 border-sky-200',
  fresh: 'bg-emerald-50 text-emerald-900 border-emerald-200',
};

const STORAGE_LABEL: Record<string, string> = {
  fridge: 'Ngăn mát tủ lạnh', freezer: 'Ngăn đông đá', pantry: 'Tủ đồ khô',
};

export const IngredientDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [expiryDraft, setExpiryDraft] = useState('');
  const [storageDraft, setStorageDraft] = useState('');

  // Adopted households read canonical lot truth; the legacy projection is
  // never the source for provenance or expiry semantics.
  const lotQuery = useQuery({
    queryKey: queryKeys.inventoryLot(id ?? ''),
    queryFn: () => api.getInventoryLot(id as string),
    enabled: Boolean(id),
    retry: false,
  });

  const legacyQuery = useQuery({
    queryKey: queryKeys.inventory(),
    queryFn: () => api.getInventory(),
    // Only needed when the household has no lot authority yet.
    enabled: Boolean(id) && lotQuery.isError,
  });

  const lot = lotQuery.data ?? null;
  const legacyItem = lot ? null : (legacyQuery.data ?? []).find((entry: any) => entry.id === id) ?? null;
  const item: any = lot ?? legacyItem;

  const mutate = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      if (!item) throw new Error('missing item');
      return api.updateInventoryItem(item.id, updates, item.version);
    },
    onSuccess: async () => {
      setActionError(null);
      setEditing(false);
      await invalidateInventoryDependents();
      await lotQuery.refetch();
    },
    onError: async (error: unknown) => {
      const code = error instanceof ApiError ? error.code : null;
      const presentation = presentDomainError(code, 'Chưa cập nhật được nguyên liệu. Vui lòng thử lại.');
      setActionError(presentation.message);
      // A stale/conflict state is only recoverable after reloading authority.
      if (presentation.refetch) {
        await invalidateInventoryDependents();
        await lotQuery.refetch();
      }
    },
  });

  if (lotQuery.isPending && !legacyItem) {
    return (
      <div className="min-h-screen bg-[#F8FAF9] max-w-md mx-auto">
        <TopBar showBack title="Chi tiết nguyên liệu" />
        <div className="p-6"><InlineLoading label="Đang tải nguyên liệu…" /></div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="min-h-screen bg-[#F8FAF9] max-w-md mx-auto">
        <TopBar showBack title="Chi tiết nguyên liệu" />
        <div className="p-6 text-center">
          {legacyQuery.isError ? (
            <InlineError error={legacyQuery.error} onRetry={() => void legacyQuery.refetch()} />
          ) : (
            <p className="text-xs text-slate-500">Không tìm thấy nguyên liệu này trong tủ.</p>
          )}
          <Button className="mt-4" onClick={() => navigate('/fridge')}>Về tủ lạnh</Button>
        </div>
      </div>
    );
  }

  const expiry = presentExpiry(item);
  const matchingRecipes = ALL_RECIPES.filter((recipe) =>
    recipe.ingredients.some((ingredient) =>
      ingredient.ingredientId === item.ingredientId
      || ingredient.name.toLowerCase() === String(item.name).toLowerCase()));

  const startEdit = () => {
    setActionError(null);
    setExpiryDraft(expiry.date ?? '');
    setStorageDraft(item.storage ?? 'fridge');
    setEditing(true);
  };

  return (
    <div className="min-h-screen bg-[#F8FAF9] pb-12 max-w-md mx-auto">
      <TopBar showBack title={item.name} subtitle="Thông tin nguyên liệu" />

      <div className="px-4 pt-4 space-y-4">
        <div className="bg-white rounded-xl p-4 flex items-center gap-4 border border-slate-200/80 shadow-xs">
          <div className="w-16 h-16 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center p-2 overflow-hidden shrink-0">
            <img src={getIngredientImage(item.ingredientId, item.name)} alt={item.name} className="w-full h-full object-contain" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-heading font-bold text-xl text-slate-900 leading-tight">{item.name}</h3>
              <StatusChip status={item.freshness} />
            </div>
            <p className="text-sm font-semibold text-emerald-700">{item.quantity} {item.unit}</p>
          </div>
        </div>

        {actionError && (
          <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 font-medium" role="alert">
            {actionError}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white rounded-xl p-3.5 border border-slate-200/80 shadow-xs">
            <div className="flex items-center gap-1.5 text-slate-500 mb-1">
              <Layers className="w-4 h-4 text-emerald-600" />
              <span className="text-[11px] font-semibold">Vị trí</span>
            </div>
            <p className="font-heading font-semibold text-sm text-slate-900">
              {STORAGE_LABEL[item.storage] ?? 'Ngăn mát tủ lạnh'}
            </p>
          </div>

          <div className="bg-white rounded-xl p-3.5 border border-slate-200/80 shadow-xs">
            <div className="flex items-center gap-1.5 text-slate-500 mb-1">
              <Calendar className="w-4 h-4 text-emerald-600" />
              <span className="text-[11px] font-semibold">Hạn sử dụng</span>
            </div>
            <p className={clsx('font-heading font-semibold text-xs px-2 py-1 rounded-lg border inline-block',
              EXPIRY_TONE_CLASS[expiry.tone])} data-testid="lot-expiry">
              {expiry.label}
            </p>
          </div>
        </div>

        {lot && (
          <div className="bg-white rounded-xl p-3.5 border border-slate-200/80 shadow-xs space-y-2">
            <div className="flex items-center gap-1.5 text-slate-500">
              <Receipt className="w-4 h-4 text-emerald-600" />
              <span className="text-[11px] font-semibold">Nguồn gốc &amp; lô</span>
            </div>
            <dl className="grid grid-cols-2 gap-y-1.5 text-xs">
              <dt className="text-slate-500">Nguồn</dt>
              <dd className="text-slate-900 font-semibold text-right" data-testid="lot-provenance">
                {provenanceLabel(lot.dataSource)}
              </dd>
              <dt className="text-slate-500">Ngày mua</dt>
              <dd className="text-slate-900 font-semibold text-right">{presentPurchaseDate(lot.purchasedAt)}</dd>
              <dt className="text-slate-500">Đã mở</dt>
              <dd className="text-slate-900 font-semibold text-right">{lot.openedAt ? lot.openedAt.slice(0, 10) : 'Chưa mở'}</dd>
              <dt className="text-slate-500">Mã lô</dt>
              <dd className="text-slate-900 font-mono text-[10px] text-right break-all">{lot.lotId}</dd>
              <dt className="text-slate-500">Phiên bản lô</dt>
              <dd className="text-slate-900 font-semibold text-right">v{lot.lotVersion}</dd>
            </dl>
          </div>
        )}

        {!editing ? (
          <Button fullWidth variant="outline" onClick={startEdit} className="flex items-center justify-center gap-2">
            <PackageOpen className="w-4 h-4 text-emerald-600" />
            <span>Sửa hạn dùng &amp; vị trí</span>
          </Button>
        ) : (
          <form
            className="bg-white rounded-xl p-4 border border-slate-200/80 shadow-xs space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const updates: Record<string, unknown> = {};
              if (expiryDraft !== (expiry.date ?? '')) {
                updates.expiryDate = expiryDraft || null;
                // The date picker is an explicit dated fact, so the correction
                // establishes KNOWN expiry rather than another estimate.
                updates.expiryEstimated = false;
              }
              if (storageDraft !== item.storage) updates.storage = storageDraft;
              if (Object.keys(updates).length === 0) { setEditing(false); return; }
              mutate.mutate(updates);
            }}
          >
            <div>
              <label htmlFor="lot-expiry-input" className="block text-xs font-semibold text-slate-700 mb-1">
                Hạn sử dụng chính xác
              </label>
              <input
                id="lot-expiry-input"
                type="date"
                value={expiryDraft}
                onChange={(event) => setExpiryDraft(event.target.value)}
                className="w-full h-11 px-3 rounded-xl border border-slate-200/80 text-sm font-medium text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Ngày bạn chọn được lưu là hạn dùng đã biết chắc chắn.
              </p>
            </div>
            <div>
              <label htmlFor="lot-storage-input" className="block text-xs font-semibold text-slate-700 mb-1">
                Chuyển vị trí bảo quản
              </label>
              <select
                id="lot-storage-input"
                value={storageDraft}
                onChange={(event) => setStorageDraft(event.target.value)}
                className="w-full h-11 px-3 rounded-xl border border-slate-200/80 text-sm font-medium text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
              >
                <option value="fridge">Ngăn mát</option>
                <option value="freezer">Ngăn đông</option>
                <option value="pantry">Tủ đồ khô</option>
              </select>
            </div>
            <div className="flex gap-2">
              <Button type="submit" fullWidth disabled={mutate.isPending}>
                {mutate.isPending ? 'Đang lưu…' : 'Lưu thay đổi'}
              </Button>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>Hủy</Button>
            </div>
          </form>
        )}

        <div className="pt-2">
          <h4 className="font-heading font-bold text-base text-slate-900 flex items-center gap-1.5 mb-3">
            <ChefHat className="w-4 h-4 text-emerald-600" />
            <span>Món ngon có thể nấu ({matchingRecipes.length})</span>
          </h4>

          <div className="space-y-2.5">
            {matchingRecipes.map((recipe) => (
              <div
                key={recipe.id}
                onClick={() => navigate(`/recipes/${recipe.slug}`)}
                className="bg-white rounded-xl p-3 flex items-center gap-3.5 border border-slate-200/80 shadow-xs cursor-pointer hover:border-emerald-500/40 active:scale-[0.99] transition-all"
              >
                <img src={recipe.imageUrl} alt={recipe.title} className="w-14 h-14 rounded-lg object-cover shrink-0 border border-slate-100" />
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200/60 uppercase">
                    {recipe.cuisine}
                  </span>
                  <h5 className="font-heading font-semibold text-sm text-slate-900 truncate mt-1">{recipe.title}</h5>
                  <span className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
                    <Clock className="w-3 h-3 text-slate-400" />
                    <span>{recipe.cookTimeMinutes} phút</span>
                  </span>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-400" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
