import { AIProvider, VisionScanParams } from '../types';
import { VisionScanResult } from '../schemas';
import { findCanonicalIngredient } from '@frigo/domain';

export class MockAIProvider implements AIProvider {
  name = 'mock';

  async vision(_params: VisionScanParams): Promise<VisionScanResult> {
    // Realistic mock fridge items as specified in requirements
    const rawItems = [
      { raw_name: 'Thịt ba chỉ', estimated_quantity: 400, unit: 'g' as const, confidence: 0.94, storage: 'fridge' as const },
      { raw_name: 'Trứng gà', estimated_quantity: 6, unit: 'piece' as const, confidence: 0.96, storage: 'fridge' as const },
      { raw_name: 'Cà chua', estimated_quantity: 4, unit: 'piece' as const, confidence: 0.91, storage: 'fridge' as const },
      { raw_name: 'Rau muống', estimated_quantity: 1, unit: 'bunch' as const, confidence: 0.88, storage: 'fridge' as const },
      { raw_name: 'Đậu phụ', estimated_quantity: 2, unit: 'piece' as const, confidence: 0.92, storage: 'fridge' as const },
    ];

    const items = rawItems.map(item => {
      const canonical = findCanonicalIngredient(item.raw_name);
      return {
        ...item,
        canonical_id: canonical?.id,
        category: canonical?.category || 'other',
      };
    });

    return { items };
  }

  async receiptScan(_params: VisionScanParams): Promise<import('../schemas').ReceiptScanResult> {
    const rawItems = [
      { raw_name: 'Thịt ba chỉ MeatDeli', estimated_quantity: 500, unit: 'g' as const, unit_price_vnd: 85000, total_price_vnd: 85000, storage: 'fridge' as const },
      { raw_name: 'Trứng gà Ba Huân hộp 10', estimated_quantity: 10, unit: 'piece' as const, unit_price_vnd: 34000, total_price_vnd: 34000, storage: 'fridge' as const },
      { raw_name: 'Cà chua Đà Lạt', estimated_quantity: 4, unit: 'piece' as const, unit_price_vnd: 4500, total_price_vnd: 18000, storage: 'fridge' as const },
      { raw_name: 'Bắp cải trắng', estimated_quantity: 1, unit: 'piece' as const, unit_price_vnd: 22000, total_price_vnd: 22000, storage: 'fridge' as const },
      { raw_name: 'Nước mắm Nam Ngư 500ml', estimated_quantity: 500, unit: 'ml' as const, unit_price_vnd: 38000, total_price_vnd: 38000, storage: 'pantry' as const },
    ];

    const items = rawItems.map(item => {
      const canonical = findCanonicalIngredient(item.raw_name);
      return {
        ...item,
        canonical_id: canonical?.id,
        category: canonical?.category || 'other',
        confidence: 0.95,
      };
    });

    return {
      merchant_name: 'WinMart+ Trần Não',
      invoice_number: 'HD-2026-09058',
      // Must match the YYYY-MM-DD contract the real providers emit; a locale
      // string is an ambiguous date that the receipt truth mapper drops.
      purchase_date: new Date().toISOString().slice(0, 10),
      total_amount_vnd: 197000,
      items,
    };
  }

  async normalizeIngredient(rawName: string): Promise<{ canonicalId: string | null; confidence: number }> {
    const canonical = findCanonicalIngredient(rawName);
    return {
      canonicalId: canonical?.id || null,
      confidence: canonical ? 0.95 : 0,
    };
  }

  async rankRecipes(recipeTitles: string[], _userIngredients: string[]): Promise<string[]> {
    return recipeTitles;
  }

  async chat(prompt: string): Promise<string> {
    return `[Mock AI Assistant]: Tôi có thể gợi ý bạn chế biến các món ngon từ nguyên liệu trong tủ lạnh. Prompt nhận được: ${prompt}`;
  }
}
