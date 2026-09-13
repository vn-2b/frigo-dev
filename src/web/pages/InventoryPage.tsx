import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { TopBar } from '../components/common/TopBar';
import { IngredientRow } from '../components/common/IngredientRow';
import { EmptyState } from '../components/common/EmptyState';
import { InlineLoading, InlineError } from '../components/common/AsyncState';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { Button } from '../components/common/Button';
import { api } from '../services/api';
import { queryKeys } from '../lib/queryKeys';
import { invalidateInventoryDependents } from '../lib/query-invalidation';
import { Plus, Search, X } from 'lucide-react';
import { clsx } from 'clsx';
import { StandardUnit } from '@frigo/domain';

export const InventoryPage: React.FC = () => {
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; version: number } | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [unit, setUnit] = useState<StandardUnit>('piece');
  const [category, setCategory] = useState('vegetable');
  const [storage, setStorage] = useState('fridge');
  const [expiryDays, setExpiryDays] = useState(5);

  const inventoryQuery = useQuery({
    queryKey: queryKeys.inventory(),
    queryFn: () => api.getInventory(),
  });
  const items = inventoryQuery.data ?? [];
  const loading = inventoryQuery.isPending;

  const updateQty = useMutation({
    mutationFn: ({ id, newQty, version }: { id: string; newQty: number; version: number }) =>
      api.updateInventoryItem(id, { quantity: newQty }, version),
    onSuccess: invalidateInventoryDependents,
    onError: () => setMutationError('Chưa cập nhật được số lượng. Vui lòng thử lại.'),
  });

  const deleteItem = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api.deleteInventoryItem(id, version),
    onSuccess: invalidateInventoryDependents,
    onError: () => setMutationError('Chưa xóa được nguyên liệu. Vui lòng thử lại.'),
  });

  const addItem = useMutation({
    mutationFn: (payload: any) => api.addInventoryItem(payload),
    onSuccess: () => {
      void invalidateInventoryDependents();
      setIsAddModalOpen(false);
      setName('');
      setQuantity(1);
    },
    onError: () => setMutationError('Chưa thêm được nguyên liệu. Vui lòng thử lại.'),
  });

  const handleUpdateQty = (id: string, currentQty: number, delta: number, version: number) => {
    setMutationError(null);
    updateQty.mutate({ id, newQty: Math.max(1, currentQty + delta), version });
  };

  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setMutationError(null);
    // T13: "Chưa rõ" means no expiry evidence exists. Sending a computed date
    // here would manufacture a dated fact the user never supplied.
    const expiryDate = expiryDays > 0
      ? new Date(Date.now() + expiryDays * 86400000).toISOString().split('T')[0]
      : null;
    addItem.mutate({
      name: name.trim(),
      quantity: Number(quantity),
      unit,
      category,
      storage,
      expiryDate,
      // Day chips are estimates, never dated facts.
      expiryEstimated: expiryDate !== null,
    });
  };

  const filteredItems = items.filter((item) => {
    const matchesSearch = item.name.toLowerCase().includes(search.toLowerCase());
    if (!matchesSearch) return false;

    if (filterCategory === 'all') return true;
    if (filterCategory === 'expiring') return item.freshness === 'expiring' || item.freshness === 'use_soon';
    return item.category === filterCategory;
  });

  const expiringCount = items.filter((i) => i.freshness === 'expiring' || i.freshness === 'use_soon').length;
  const vegCount = items.filter((i) => i.category === 'vegetable').length;

  const categories = [
    { id: 'all', label: `Tất cả (${items.length})` },
    { id: 'expiring', label: `Sắp hết (${expiringCount})` },
    { id: 'vegetable', label: `Rau củ (${vegCount})` },
    { id: 'meat', label: 'Thịt' },
    { id: 'egg', label: 'Trứng' },
    { id: 'dairy', label: 'Sữa/Bơ' },
    { id: 'spice', label: 'Gia vị' },
    { id: 'seafood', label: 'Hải sản' },
  ];

  return (
    <div className="min-h-screen bg-[#F8FAF9] pb-36 relative max-w-md sm:max-w-lg md:max-w-2xl mx-auto">
      <TopBar />

      <div className="px-4 pt-3 space-y-4 animate-fade-in">
        {/* Title & Add Action */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-heading font-bold text-2xl text-slate-900 tracking-tight">
              Tủ lạnh của tôi
            </h2>
            <p className="text-xs text-slate-500 mt-1 font-medium">
              <span className="inline-flex items-center gap-1 text-emerald-700 font-bold">
                🧊 {items.length} nguyên liệu
              </span>{' '}
              sẵn sàng nấu
            </p>
          </div>
        </div>

        {/* T13: entry point to the reconciliation surface for evidence that
            needs a human decision. */}
        <button
          type="button"
          onClick={() => navigate('/inventory-reconciliation')}
          className="w-full flex items-center justify-between px-4 py-2.5 rounded-2xl bg-white border border-slate-200/80 shadow-card text-left tap-target cursor-pointer hover:border-emerald-500/40 transition-all"
        >
          <span className="text-xs font-semibold text-slate-700">Đối chiếu tủ lạnh</span>
          <span className="text-[11px] text-emerald-700 font-bold">Xem bằng chứng →</span>
        </button>

        {/* Search */}
        <div className="relative">
          <Search className="w-4.5 h-4.5 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm theo tên nguyên liệu..."
            className="w-full h-12 pl-11 pr-4 bg-white rounded-2xl border border-slate-200/80 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600 text-sm font-medium text-slate-900 placeholder:text-slate-400 shadow-card transition-all"
          />
        </div>

        {/* Category Filters */}
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar py-0.5">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setFilterCategory(c.id)}
              className={clsx(
                'px-4 py-2 rounded-full text-xs font-heading font-bold whitespace-nowrap transition-all tap-target cursor-pointer',
                filterCategory === c.id
                  ? 'bg-[#0F3D2E] text-white shadow-card scale-105'
                  : 'bg-white text-slate-600 border border-slate-200/80 hover:bg-slate-50 hover:text-slate-900'
              )}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Inventory Item List */}
        <div className="space-y-2 pt-1">
          {mutationError && (
            <p className="text-xs text-rose-600 font-medium px-1" role="alert">
              {mutationError}
            </p>
          )}
          {loading ? (
            <InlineLoading label="Đang tải tủ lạnh…" />
          ) : inventoryQuery.isError ? (
            <InlineError error={inventoryQuery.error} onRetry={() => inventoryQuery.refetch()} />
          ) : filteredItems.length === 0 ? (
            <EmptyState
              type="empty-fridge"
              title="Tủ lạnh đang trống"
              description="Hãy bấm quét ảnh tủ lạnh bằng AI hoặc thêm thủ công nguyên liệu bạn vừa mua nhé."
              actionText="Chụp tủ lạnh ngay"
              onAction={() => navigate('/scan')}
            />
          ) : (
            filteredItems.map((item) => (
              <IngredientRow
                key={item.id}
                id={item.id}
                name={item.name}
                quantity={item.quantity}
                unit={item.unit}
                category={item.category}
                storage={item.storage}
                freshness={item.freshness}
                ingredientId={item.ingredientId}
                expiryDate={item.expiryDate}
                expiryKind={item.expiryKind}
                estimatedExpiryDate={item.estimatedExpiryDate}
                onClick={() => navigate(`/ingredients/${item.id}`)}
                onUpdateQuantity={(delta) => handleUpdateQty(item.id, item.quantity, delta, item.version)}
                onDelete={() => setPendingDelete({ id: item.id, version: item.version })}
              />
            ))
          )}
        </div>
      </div>

      {/* Sticky Bottom Floating CTA */}
      <div className="fixed bottom-20 left-0 right-0 max-w-md sm:max-w-lg md:max-w-2xl mx-auto px-4 z-30 pointer-events-none">
        <button
          onClick={() => setIsAddModalOpen(true)}
          className="w-full py-4 px-4 rounded-2xl bg-gradient-to-r from-[#22C55E] to-emerald-600 hover:from-[#1ea750] hover:to-emerald-700 text-white font-heading font-bold text-[15px] shadow-float active:scale-98 transition-all pointer-events-auto flex items-center justify-center gap-2 tap-target"
        >
          <Plus className="w-5.5 h-5.5 stroke-[2.5]" />
          <span>Thêm nguyên liệu</span>
        </button>
      </div>

      {/* Manual Add Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-xs flex items-end justify-center sm:items-center p-0 sm:p-4">
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-200/80 animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-heading font-bold text-base text-slate-900">
                Thêm nguyên liệu vào tủ
              </h3>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 tap-target flex items-center justify-center transition-colors"
                aria-label="Đóng"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddItem} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Tên nguyên liệu
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ví dụ: Thịt ba chỉ, Trứng gà, Cà chua..."
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200/80 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600 font-medium text-sm text-slate-900 placeholder:text-slate-400"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Số lượng
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                    className="w-full h-11 px-3.5 rounded-xl border border-slate-200/80 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600 font-medium text-sm text-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Đơn vị
                  </label>
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as StandardUnit)}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200/80 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600 font-medium text-sm text-slate-900 bg-white"
                  >
                    <option value="g">gam (g)</option>
                    <option value="kg">kg</option>
                    <option value="piece">quả / củ / bìa / miếng</option>
                    <option value="bunch">bó</option>
                    <option value="pack">gói / hộp</option>
                    <option value="ml">ml</option>
                    <option value="l">lít</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Phân loại
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200/80 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600 font-medium text-sm text-slate-900 bg-white"
                  >
                    <option value="vegetable">Rau củ</option>
                    <option value="meat">Thịt</option>
                    <option value="egg">Trứng</option>
                    <option value="seafood">Hải sản</option>
                    <option value="dairy">Sữa / Bơ</option>
                    <option value="spice">Gia vị</option>
                    <option value="grain">Gạo / Mì</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Bảo quản
                  </label>
                  <select
                    value={storage}
                    onChange={(e) => setStorage(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl border border-slate-200/80 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600 font-medium text-sm text-slate-900 bg-white"
                  >
                    <option value="fridge">Ngăn mát</option>
                    <option value="freezer">Ngăn đông</option>
                    <option value="pantry">Tủ đồ khô</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Hạn sử dụng dự kiến
                </label>
                <div className="flex gap-2">
                  {[
                    { days: 0, label: 'Chưa rõ' },
                    { days: 2, label: '2 ngày' },
                    { days: 5, label: '5 ngày' },
                    { days: 10, label: '10 ngày' },
                    { days: 30, label: '1 tháng' },
                  ].map((d) => (
                    <button
                      key={d.days}
                      type="button"
                      onClick={() => setExpiryDays(d.days)}
                      className={clsx(
                        'flex-1 py-2 rounded-lg text-xs font-medium border transition-all tap-target cursor-pointer',
                        expiryDays === d.days
                          ? 'bg-emerald-50 border-emerald-600 text-emerald-900 font-semibold'
                          : 'bg-white border-slate-200/80 text-slate-600 hover:bg-slate-50'
                      )}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="pt-2">
                <Button fullWidth size="lg" type="submit">
                  Lưu vào tủ lạnh
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Xóa nguyên liệu?"
        description="Nguyên liệu này sẽ bị xóa khỏi tủ lạnh của bạn."
        confirmText="Xóa"
        destructive
        onConfirm={() => {
          if (pendingDelete) {
            setMutationError(null);
            deleteItem.mutate(pendingDelete);
          }
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};
