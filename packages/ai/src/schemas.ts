import { z } from 'zod';

export const StandardUnitSchema = z.enum([
  'g',
  'kg',
  'ml',
  'l',
  'piece',
  'pack',
  'bunch',
  'slice'
]);

export const DetectedIngredientSchema = z.object({
  raw_name: z.string().min(1, 'Tên nguyên liệu không được để trống'),
  estimated_quantity: z.number().positive('Số lượng phải lớn hơn 0'),
  unit: StandardUnitSchema,
  confidence: z.number().min(0).max(1),
  canonical_id: z.string().optional(),
  category: z.string().optional(),
  storage: z.enum(['fridge', 'freezer', 'pantry']).optional().default('fridge'),
});

export const VisionScanResultSchema = z.object({
  items: z.array(DetectedIngredientSchema),
});

export const ReceiptItemSchema = z.object({
  raw_name: z.string().min(1, 'Tên sản phẩm không được để trống'),
  estimated_quantity: z.number().positive('Số lượng phải lớn hơn 0'),
  unit: StandardUnitSchema,
  unit_price_vnd: z.number().nonnegative().optional(),
  total_price_vnd: z.number().nonnegative().optional(),
  canonical_id: z.string().optional(),
  category: z.string().optional(),
  storage: z.enum(['fridge', 'freezer', 'pantry']).optional().default('fridge'),
  // T13: a missing confidence is unknown, not high. Defaulting to 0.9 claimed
  // certainty the model never expressed, so absence must stay absent.
  confidence: z.number().min(0).max(1).optional(),
});

export const ReceiptScanResultSchema = z.object({
  // T13: no fabricated merchant. An unread merchant name stays absent rather
  // than becoming a plausible-looking "Siêu thị".
  merchant_name: z.string().optional(),
  invoice_number: z.string().optional(),
  purchase_date: z.string().optional(),
  total_amount_vnd: z.number().nonnegative().optional(),
  items: z.array(ReceiptItemSchema),
});

export type DetectedIngredient = z.infer<typeof DetectedIngredientSchema>;
export type VisionScanResult = z.infer<typeof VisionScanResultSchema>;
export type ReceiptItem = z.infer<typeof ReceiptItemSchema>;
export type ReceiptScanResult = z.infer<typeof ReceiptScanResultSchema>;

export interface AIUsageLog {
  userId?: string;
  task: 'fridge_scan' | 'receipt_scan' | 'ingredient_normalization' | 'recipe_rank' | 'chat';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCost: number;
  status: 'success' | 'error' | 'fallback';
  createdAt: string;
}
