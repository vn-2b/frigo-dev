// T13 Inventory UX V2 presentation truth. These helpers are the single place
// the UI turns Inventory Truth semantics into Vietnamese user-facing language.
// They never invent a fact: UNKNOWN expiry is shown as unknown (not "fresh"),
// an ESTIMATED date is labelled as an estimate, and a missing price/date reads
// as "không có" instead of 0₫ or today.

export type ExpiryKind = 'KNOWN' | 'BEST_BEFORE' | 'USE_BY' | 'ESTIMATED' | 'UNKNOWN';

export interface ExpiryPresentation {
  /** Stable token for tests and styling. */
  tone: 'unknown' | 'expired' | 'expiring' | 'estimated' | 'fresh';
  label: string;
  /** The date to show, or null when there is genuinely none. */
  date: string | null;
  /** True when the date is an estimate rather than a dated fact. */
  estimated: boolean;
}

function daysUntil(date: string, now: number): number {
  return Math.ceil((Date.parse(`${date}T00:00:00Z`) - now) / 86_400_000);
}

/**
 * Expiry presentation. An UNKNOWN expiry is never rendered as "fresh": with no
 * date there is no basis for a freshness claim, so it is shown as unknown and
 * invites a correction.
 */
export function presentExpiry(item: {
  expiryKind?: string | null; expiryAt?: string | null; estimatedExpiryDate?: string | null;
  estimatedExpiryAt?: string | null; expiryDate?: string | null;
}, now: number = Date.now()): ExpiryPresentation {
  const kind = (item.expiryKind ?? 'UNKNOWN') as ExpiryKind;
  const estimatedDate = item.estimatedExpiryAt ?? item.estimatedExpiryDate ?? null;
  const knownDate = item.expiryAt ?? (kind === 'ESTIMATED' ? null : item.expiryDate ?? null);

  if (kind === 'UNKNOWN' || (!knownDate && !estimatedDate)) {
    return { tone: 'unknown', label: 'Chưa rõ hạn dùng', date: null, estimated: false };
  }
  if (kind === 'ESTIMATED') {
    const date = estimatedDate ?? item.expiryDate ?? null;
    if (!date) return { tone: 'unknown', label: 'Chưa rõ hạn dùng', date: null, estimated: false };
    const days = daysUntil(date, now);
    if (days < 0) return { tone: 'expired', label: `Ước tính đã quá hạn (${date})`, date, estimated: true };
    if (days <= 2) return { tone: 'expiring', label: `Ước tính sắp hết hạn (${date})`, date, estimated: true };
    return { tone: 'estimated', label: `Hạn ước tính ${date}`, date, estimated: true };
  }
  const date = knownDate ?? estimatedDate;
  if (!date) return { tone: 'unknown', label: 'Chưa rõ hạn dùng', date: null, estimated: false };
  const days = daysUntil(date, now);
  if (days < 0) return { tone: 'expired', label: `Đã quá hạn ${date}`, date, estimated: false };
  if (days <= 2) return { tone: 'expiring', label: `Sắp hết hạn ${date}`, date, estimated: false };
  return { tone: 'fresh', label: `Hạn dùng ${date}`, date, estimated: false };
}

const PROVENANCE_LABELS: Record<string, string> = {
  receipt: 'Từ hóa đơn',
  scan: 'Từ ảnh tủ lạnh',
  manual: 'Nhập thủ công',
  shopping: 'Từ đi chợ',
  legacy: 'Dữ liệu cũ',
};

/** Friendly provenance label; an unrecognized source is not guessed at. */
export function provenanceLabel(dataSource?: string | null): string {
  if (!dataSource) return 'Không rõ nguồn';
  return PROVENANCE_LABELS[dataSource] ?? 'Nguồn khác';
}

/** Money that is genuinely unknown must never render as 0₫. */
export function presentPrice(amountVnd?: number | null): string {
  if (amountVnd === null || amountVnd === undefined || !Number.isFinite(amountVnd)) {
    return 'Không có giá';
  }
  return `${Number(amountVnd).toLocaleString('vi-VN')}đ`;
}

/** A missing purchase date reads as unknown, never as today. */
export function presentPurchaseDate(date?: string | null): string {
  return date ? date : 'Không rõ ngày mua';
}

/** Model confidence the provider did not report is unknown, not high. */
export function presentConfidence(confidence?: number | null): {
  label: string; tone: 'unknown' | 'low' | 'medium' | 'high';
} {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) {
    return { label: 'Độ tin cậy: chưa rõ', tone: 'unknown' };
  }
  const percent = Math.round(confidence * 100);
  if (confidence < 0.5) return { label: `Độ tin cậy thấp ${percent}%`, tone: 'low' };
  if (confidence < 0.8) return { label: `Độ tin cậy ${percent}%`, tone: 'medium' };
  return { label: `Độ tin cậy ${percent}%`, tone: 'high' };
}

/**
 * Recoverable domain states get specific, actionable Vietnamese text. `refetch`
 * marks the states where the client must reload authoritative state before the
 * user retries, instead of resubmitting a stale command.
 */
export interface DomainErrorPresentation { message: string; refetch: boolean }

const DOMAIN_ERRORS: Record<string, DomainErrorPresentation> = {
  INVENTORY_AUTHORITY_REQUIRED: {
    message: 'Tủ lạnh này chưa bật quản lý theo lô. Hãy bật trước khi dùng tính năng này.',
    refetch: false,
  },
  CONFLICT: {
    message: 'Nguyên liệu vừa được cập nhật ở nơi khác. Đã tải lại trạng thái mới nhất, vui lòng thử lại.',
    refetch: true,
  },
  STALE_SNAPSHOT: {
    message: 'Thông tin đã thay đổi kể từ lúc bạn mở. Đã tải lại dữ liệu mới, vui lòng kiểm tra lại.',
    refetch: true,
  },
  ALREADY_DECIDED: {
    message: 'Mục đối chiếu này đã được xử lý trước đó.',
    refetch: true,
  },
  UNIT_MISMATCH: {
    message: 'Không thể quy đổi đơn vị này sang đơn vị đang lưu trong tủ.',
    refetch: false,
  },
  INSUFFICIENT_INVENTORY: {
    message: 'Số lượng trong tủ không đủ cho thao tác này.',
    refetch: true,
  },
  IDEMPOTENCY_CONFLICT: {
    message: 'Yêu cầu này đã được dùng cho một thao tác khác. Vui lòng tải lại và thử lại.',
    refetch: true,
  },
  NOT_ACTIONABLE: {
    message: 'Bằng chứng này hiện không có thao tác nào phù hợp.',
    refetch: true,
  },
  REVIVE_REQUIRED: {
    message: 'Lô này đã kết thúc. Cần khôi phục với số lượng cụ thể trước khi sửa.',
    refetch: true,
  },
  VALIDATION_ERROR: { message: 'Dữ liệu chưa hợp lệ. Vui lòng kiểm tra lại.', refetch: false },
  NOT_FOUND: { message: 'Không tìm thấy mục này.', refetch: true },
  FORBIDDEN: { message: 'Bạn không có quyền với mục này.', refetch: false },
};

/**
 * Map an ApiError code to user-readable text. Unknown codes fall back to a
 * generic message only when no specific domain code is available — never
 * raw JSON.
 */
export function presentDomainError(code: string | null | undefined,
  fallback = 'Thao tác chưa thực hiện được. Vui lòng thử lại.'): DomainErrorPresentation {
  if (!code) return { message: fallback, refetch: false };
  return DOMAIN_ERRORS[code] ?? { message: fallback, refetch: false };
}
