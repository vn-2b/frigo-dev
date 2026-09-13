import { z } from 'zod';
import { Context, Next } from 'hono';

// 1. Auth Schemas
export const RegisterSchema = z.object({
  name: z.string().trim().min(2, 'Tên phải có ít nhất 2 ký tự').max(60, 'Tên tối đa 60 ký tự'),
  email: z.string().trim().email('Địa chỉ email không hợp lệ').max(100),
  password: z.string().min(6, 'Mật khẩu phải có ít nhất 6 ký tự').max(100, 'Mật khẩu tối đa 100 ký tự'),
});

export const LoginSchema = z.object({
  email: z.string().trim().email('Địa chỉ email không hợp lệ'),
  password: z.string().min(1, 'Vui lòng nhập mật khẩu'),
});

export const VerifyOtpSchema = z.object({
  email: z.string().trim().email('Địa chỉ email không hợp lệ'),
  code: z.string().trim().regex(/^\d{6}$/, 'Mã OTP phải gồm đúng 6 chữ số'),
  purpose: z.enum(['register', 'forgot_password', 'login']),
  // Retained request contract; inventory transfers are explicitly deferred.
  migrateFromHouseholdId: z
    .string()
    .regex(/^hh_guest_[a-z0-9]+$/i, 'ID household guest không hợp lệ')
    .optional(),
});

export const ForgotPasswordSchema = z.object({
  email: z.string().trim().email('Địa chỉ email không hợp lệ'),
});

export const ResetPasswordSchema = z.object({
  email: z.string().trim().email('Địa chỉ email không hợp lệ'),
  code: z.string().trim().regex(/^\d{6}$/, 'Mã OTP phải gồm đúng 6 chữ số'),
  newPassword: z.string().min(6, 'Mật khẩu mới phải có ít nhất 6 ký tự').max(100),
});

export const ResendOtpSchema = z.object({
  email: z.string().trim().email('Địa chỉ email không hợp lệ'),
  purpose: z.enum(['register', 'forgot_password', 'login']),
});

export const GoogleAuthSchema = z.object({
  credential: z.string().min(10, 'Google credential token không hợp lệ').optional(),
  userInfo: z.object({
    email: z.string().email(),
    name: z.string().optional(),
    sub: z.string().optional(),
    picture: z.string().optional(),
  }).optional(),
}).refine(data => data.credential || data.userInfo, {
  message: 'Vui lòng cung cấp credential token hoặc userInfo từ Google',
});

// 2. Inventory Schemas
export const InventoryCreateSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, 'Tên nguyên liệu không được để trống').max(100, 'Tên nguyên liệu tối đa 100 ký tự'),
  quantity: z.coerce.number().positive('Số lượng phải lớn hơn 0').max(10000, 'Số lượng quá lớn'),
  unit: z.enum(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice']).default('piece'),
  category: z.string().trim().max(30).default('other'),
  storage: z.enum(['fridge', 'freezer', 'pantry']).default('fridge'),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Định dạng ngày hết hạn phải là YYYY-MM-DD').nullable().optional(),
  // T13: a day-chip estimate is ESTIMATED evidence; only an explicitly picked
  // date becomes a KNOWN dated fact.
  expiryEstimated: z.boolean().optional(),
  dataSource: z.string().max(20).default('manual'),
});

export const InventoryUpdateSchema = z
  .object({
    // The client sends the revision it read so the server can reject stale
    // offline edits instead of silently overwriting a newer projection.
    version: z.coerce.number().int().positive(),
    name: z.string().trim().min(1).max(100).optional(),
    quantity: z.coerce.number().positive().max(10000).optional(),
    unit: z.enum(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice']).optional(),
    category: z.string().trim().max(30).optional(),
    storage: z.enum(['fridge', 'freezer', 'pantry']).optional(),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    expiryEstimated: z.boolean().optional(),
  })
  .refine(
    (body) => Object.keys(body).some((key) => key !== 'version'),
    'Cần ít nhất một trường để cập nhật'
  );

// 3. Scan Schemas
export const ScanConfirmSchema = z.object({
  items: z.array(z.object({
    id: z.string().optional(),
    name: z.string().trim().min(1).optional(),
    rawName: z.string().trim().min(1).optional(),
    // Keep these fields optional so a client can confirm a persisted scan item
    // by id and let the server hydrate the AI estimate. Defaults here used to
    // overwrite the stored unit/category/storage (for example, g -> piece).
    quantity: z.coerce.number().positive().max(10000).optional(),
    estimatedQuantity: z.coerce.number().positive().max(10000).optional(),
    unit: z.enum(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice']).optional(),
    category: z.string().trim().max(30).optional(),
    storage: z.enum(['fridge', 'freezer', 'pantry']).optional(),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    // T13: the client states how the date was chosen. A day-chip estimate is
    // ESTIMATED evidence; only an explicitly picked date becomes KNOWN.
    expiryEstimated: z.boolean().optional(),
    // T13: explicit per-line rejection, distinct from "not submitted".
    rejected: z.boolean().optional(),
    // T13: the review UI round-trips the scan DTO it was given, so a field the
    // server itself emitted as null (an unmapped ingredient) must be accepted
    // as "absent" rather than rejected as a validation error.
    canonicalId: z.string().trim().max(100).nullable().optional(),
  }))
    .min(1, 'Cần ít nhất một nguyên liệu để xác nhận')
    .max(50, 'Tối đa 50 nguyên liệu mỗi lần xác nhận')
    .superRefine((items, ctx) => {
      items.forEach((item, index) => {
        // A row without an id is a deliberate manual addition and therefore
        // still needs a label. Rows with an id may be hydrated from scan_items.
        if (!item.id && !item.name && !item.rawName) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'name'],
            message: 'Nguyên liệu thủ công cần có tên',
          });
        }
      });
    }),
});

// Cooking is a state-changing command: reject malformed or negative
// deductions before any inventory projection is touched.
export const CookingCompleteSchema = z.object({
  commandId: z.string().trim().regex(/^[A-Za-z0-9:_-]{8,200}$/).optional(),
  servings: z.coerce.number().int().positive().max(100).default(2),
  deductions: z
    .array(
      z.object({
        ingredientId: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(100).optional(),
        quantityDeducted: z.coerce.number().finite().nonnegative().max(100000),
        unit: z
          .enum(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice'])
          .optional(),
      })
    )
    .max(100),
});

// 4. Shopping Schemas
export const ShoppingItemCreateSchema = z.object({
  id: z.string().trim().min(8).max(160).optional(),
  name: z.string().trim().min(1, 'Tên mặt hàng không được để trống').max(100),
  quantity: z.coerce.number().positive().default(1),
  unit: z.string().trim().max(20).default('piece'),
  ingredientId: z.string().optional(),
  sourceRecipeId: z.string().optional(),
  sourceRecipeTitle: z.string().optional(),
});

export const ShoppingItemUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  quantity: z.coerce.number().positive().optional(),
  isChecked: z.boolean().optional(),
  cannotBuy: z.boolean().optional(),
});

// Validation helper middleware for Hono
export function validateBody<T>(schema: z.ZodSchema<T>) {
  return async (c: Context, next: Next) => {
    try {
      const rawBody = await c.req.json().catch(() => ({}));
      const result = schema.safeParse(rawBody);
      if (!result.success) {
        const errorMessages = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        return c.json({
          error: `Dữ liệu không hợp lệ: ${errorMessages}`,
          code: 'VALIDATION_ERROR',
          details: result.error.flatten(),
        }, 400);
      }
      c.set('validatedBody', result.data);
      await next();
    } catch (err: any) {
      return c.json({ error: 'Lỗi phân tích cú pháp JSON', code: 'INVALID_JSON' }, 400);
    }
  };
}
