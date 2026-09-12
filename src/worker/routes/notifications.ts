import { Hono } from 'hono';
import { Env, AuthContext } from '../types';
import { readInventoryAuthorityMode } from '../../../packages/db/src/inventory-writer-fence';
import { readInventoryAuthority } from '../../../packages/db/src/inventory-read-authority';

export const notificationRoutes = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();

notificationRoutes.get('/notifications', async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const list: any[] = [];

  if (db) {
    try {
      // 1. Check expiring items — T11: adopted households derive freshness
      // from canonical lot authority; the projection is never the source.
      let expiringItems: Array<{ name: string; quantity: number; unit: string }>;
      if (await readInventoryAuthorityMode(db, auth.householdId) === 'native') {
        const { items } = await readInventoryAuthority(db, { householdId: auth.householdId, actorId: auth.userId });
        expiringItems = items
          .filter((item) => item.freshness === 'expiring' || item.freshness === 'use_soon')
          .slice(0, 3)
          .map((item) => ({ name: item.name, quantity: item.quantity, unit: item.unit }));
      } else {
        const expiring = await db.prepare(
          `SELECT name, quantity, unit, freshness FROM inventory_items WHERE household_id = ? AND (freshness = 'expiring' OR freshness = 'use_soon') LIMIT 3`
        ).bind(auth.householdId).all();
        expiringItems = (expiring.results || []) as Array<{ name: string; quantity: number; unit: string }>;
      }

      if (expiringItems.length > 0) {
        for (const it of expiringItems) {
          list.push({
            id: `notif_exp_${it.name}_${Date.now()}`,
            userId: auth.userId,
            title: `${it.name} cần dùng sớm!`,
            message: `Bạn đang có ${it.quantity} ${it.unit} ${it.name} trong tủ lạnh. Hãy chế biến ngay để giữ độ tươi ngon nhé.`,
            type: 'expiring_soon',
            isRead: false,
            createdAt: new Date().toISOString(),
          });
        }
      }

      // 2. Check pending shopping items
      const shopping = await db.prepare(
        `SELECT COUNT(*) as cnt FROM shopping_items si JOIN shopping_lists sl ON si.list_id = sl.id WHERE sl.household_id = ? AND si.is_checked = 0`
      ).bind(auth.householdId).first<{ cnt: number }>();

      if (shopping && shopping.cnt > 0) {
        list.push({
          id: `notif_shop_${Date.now()}`,
          userId: auth.userId,
          title: 'Nhắc nhở danh sách đi chợ',
          message: `Bạn còn ${shopping.cnt} món chưa mua trong danh sách đi chợ.`,
          type: 'shopping_reminder',
          isRead: false,
          createdAt: new Date(Date.now() - 1800000).toISOString(),
        });
      }
    } catch (err) {
      console.warn('Failed querying notifications from D1:', err);
    }
  }

  // Welcome notification if brand new
  if (list.length === 0) {
    list.push({
      id: `notif_welcome_${Date.now()}`,
      userId: auth.userId,
      title: 'Chào mừng bạn đến với Frigo!',
      message: 'Hãy chụp ảnh tủ lạnh hoặc hóa đơn đi chợ để Frigo tự động ghi nhận nguyên liệu cho bạn.',
      type: 'cook_ready',
      isRead: false,
      createdAt: new Date().toISOString(),
    });
  }

  return c.json({ notifications: list });
});
