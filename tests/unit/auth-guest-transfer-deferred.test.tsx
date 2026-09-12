// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthPage } from '../../src/web/pages/AuthPage';
import { useAuthStore } from '../../src/web/stores/useAuthStore';
import { getPendingOps, pushOp } from '../../src/web/lib/sync';
import { privateCacheKey } from '../../src/web/lib/private-session';
import { INVENTORY_TRANSFER_DEFERRED, isInventoryTransferDeferred } from '../../src/web/services/auth';
import { ApiError } from '../../src/web/services/http';

// D3 (release review): a web guest converting to an email account must not
// dead-end on the DEC-012 server refusal. The real AuthPage, auth store, api
// layer and outbox run here; only `fetch` is replaced.
const GUEST_USER = 'guest_1789204071396';
const GUEST_HOUSEHOLD = 'hh_guest_1789204071396';
const EMAIL = 'ui-guest@example.test';
const OTP = '884470';
const ACCOUNT = { id: 'usr_new', email: EMAIL, displayName: 'Review Guest', avatarUrl: '/icons/favicon.svg', householdId: 'hh_usr_new' };
const DEFERRED = {
  error: 'Chưa hỗ trợ chuyển dữ liệu từ hộ khách một cách an toàn. Hàng tồn kho vẫn được giữ nguyên trong hộ khách; tài khoản chưa được kích hoạt và mã OTP chưa được sử dụng.',
  code: INVENTORY_TRANSFER_DEFERRED,
};

const fetchMock = vi.fn<typeof fetch>();
let root: Root | undefined;
let container: HTMLDivElement;
let verifyBodies: Record<string, unknown>[];
let verifyResponses: Array<{ status: number; body: unknown }>;
let registerCount: number;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

async function until(assertion: () => void) {
  const deadline = Date.now() + 1_500;
  for (;;) {
    await flush();
    try { assertion(); return; } catch (failure) { if (Date.now() >= deadline) throw failure; }
  }
}

async function mount() {
  root ??= createRoot(container);
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={['/auth?mode=register']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <LocationProbe />
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/onboarding" element={<output data-testid="onboarding">onboarding</output>} />
      </Routes>
    </MemoryRouter>);
  });
  await flush();
}

function button(label: string) {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  expect(found, `button ${label}`).toBeTruthy();
  return found!;
}

function buttonExists(label: string) {
  return [...container.querySelectorAll('button')].some((item) => item.textContent?.trim() === label);
}

async function click(label: string) {
  await act(async () => { button(label).click(); });
  await flush();
}

function setNative(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function fillRegisterForm() {
  const inputs = [...container.querySelectorAll<HTMLInputElement>('form input')];
  const byPlaceholder = (placeholder: string) => inputs.find((input) => input.placeholder === placeholder)!;
  await act(async () => {
    setNative(byPlaceholder('Nguyễn Văn A'), 'Review Guest');
    setNative(byPlaceholder('ban@example.com'), EMAIL);
    setNative(byPlaceholder('••••••••'), 'strong-password-1');
  });
  await flush();
}

async function enterOtp() {
  const boxes = [...container.querySelectorAll<HTMLInputElement>('form input[inputmode="numeric"]')];
  expect(boxes).toHaveLength(6);
  for (const [index, digit] of OTP.split('').entries()) {
    await act(async () => { setNative(boxes[index], digit); });
  }
  await flush();
}

async function registerAndReachOtp() {
  await mount();
  await click('Đăng ký tài khoản');
  await fillRegisterForm();
  await click('Tạo tài khoản & Nhận mã OTP');
  await until(() => expect(container.textContent).toContain('Xác thực mã OTP'));
  expect(registerCount).toBe(1);
  await enterOtp();
}

function guestState() {
  return {
    userId: localStorage.getItem('frigo_user_id'),
    householdId: localStorage.getItem('frigo_household_id'),
    isGuest: localStorage.getItem('frigo_is_guest'),
    store: { userId: useAuthStore.getState().userId, householdId: useAuthStore.getState().householdId, isGuest: useAuthStore.getState().isGuest },
    inventoryCache: localStorage.getItem(`frigo_cache_v2:${GUEST_USER}:${GUEST_HOUSEHOLD}:inventory`),
    pending: getPendingOps().map(({ path, householdId, userId, body }) => ({ path, householdId, userId, body })),
  };
}

function seedGuestSession() {
  localStorage.setItem('frigo_user_id', GUEST_USER);
  localStorage.setItem('frigo_household_id', GUEST_HOUSEHOLD);
  localStorage.setItem('frigo_is_guest', 'true');
  useAuthStore.setState({ userId: GUEST_USER, householdId: GUEST_HOUSEHOLD, isGuest: true, displayName: 'Khách ghé thăm' });
  localStorage.setItem(privateCacheKey('inventory', GUEST_HOUSEHOLD), JSON.stringify([{ id: 'guest-eggs', name: 'Trứng gà', quantity: 10 }]));
  pushOp({ path: '/inventory', method: 'POST', body: '{"id":"offline_item"}', label: 'guest item', userId: GUEST_USER, householdId: GUEST_HOUSEHOLD });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear(); sessionStorage.clear();
  verifyBodies = []; verifyResponses = []; registerCount = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/config')) return response({ turnstileSiteKey: null });
    if (url.endsWith('/auth/register')) {
      registerCount += 1;
      return response({ success: true, message: 'Mã OTP đã được tạo', email: EMAIL, devOtp: OTP });
    }
    if (url.endsWith('/auth/verify-otp')) {
      verifyBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const next = verifyResponses.shift();
      if (!next) throw new Error(`unexpected verify-otp call #${verifyBodies.length}`);
      return response(next.body, next.status);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  container.remove();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('D3 guest → email registration with deferred inventory transfer', () => {
  it('A. a non-guest registration verifies the OTP once, without any transfer field, and opens the account session', async () => {
    verifyResponses.push({ status: 200, body: { success: true, message: 'ok', user: ACCOUNT } });
    await registerAndReachOtp();
    await click('Xác thực & Hoàn tất');
    await until(() => expect(container.textContent).toContain('Xác thực tài khoản thành công!'));
    expect(verifyBodies).toEqual([{ email: EMAIL, code: OTP, purpose: 'register' }]);
    expect(container.querySelector('[data-testid="transfer-deferred"]')).toBeNull();
    expect(localStorage.getItem('frigo_user_id')).toBe(ACCOUNT.id);
    expect(localStorage.getItem('frigo_is_guest')).toBe('false');
    await until(() => expect(container.querySelector('[data-testid="onboarding"]')).toBeTruthy());
  });

  it('B+D. the first guest attempt sends the transfer field; the 409 deferral is shown as an explicit choice, not as a wrong OTP, and the guest session is untouched', async () => {
    seedGuestSession();
    const before = guestState();
    verifyResponses.push({ status: 409, body: DEFERRED });
    await registerAndReachOtp();
    await click('Xác thực & Hoàn tất');
    await until(() => expect(container.querySelector('[data-testid="transfer-deferred"]')).toBeTruthy());
    expect(verifyBodies).toEqual([{ email: EMAIL, code: OTP, purpose: 'register', migrateFromHouseholdId: GUEST_HOUSEHOLD }]);
    const notice = container.querySelector('[data-testid="transfer-deferred"]')!.textContent ?? '';
    expect(notice).toContain('chưa thể chuyển dữ liệu');
    expect(notice).toContain('không bị xóa');
    expect(notice).toContain('tiếp tục tạo tài khoản');
    expect(buttonExists('Tiếp tục không chuyển dữ liệu khách')).toBe(true);
    expect(buttonExists('Xác thực & Hoàn tất')).toBe(false);
    expect(container.textContent).not.toContain('HTTP 409');
    expect(container.textContent).not.toContain(INVENTORY_TRANSFER_DEFERRED);
    expect(container.textContent).not.toContain('Mã OTP không đúng');
    // OTP digits stay in place for the explicit retry.
    expect([...container.querySelectorAll<HTMLInputElement>('form input[inputmode="numeric"]')].map((box) => box.value).join('')).toBe(OTP);
    expect(guestState()).toEqual(before);
    expect(localStorage.getItem('frigo_is_guest')).toBe('true');
    expect(container.querySelector('[data-testid="onboarding"]')).toBeNull();
  });

  it('C+F. continuing without transfer retries the same OTP without migrateFromHouseholdId and only then establishes the account session', async () => {
    seedGuestSession();
    const before = guestState();
    verifyResponses.push({ status: 409, body: DEFERRED });
    verifyResponses.push({ status: 200, body: { success: true, message: 'ok', user: ACCOUNT } });
    await registerAndReachOtp();
    await click('Xác thực & Hoàn tất');
    await until(() => expect(container.querySelector('[data-testid="transfer-deferred"]')).toBeTruthy());
    expect(guestState()).toEqual(before);
    await click('Tiếp tục không chuyển dữ liệu khách');
    await until(() => expect(container.textContent).toContain('Xác thực tài khoản thành công!'));
    expect(verifyBodies).toHaveLength(2);
    expect(verifyBodies[1]).toEqual({ email: EMAIL, code: OTP, purpose: 'register' });
    expect(verifyBodies[1]).not.toHaveProperty('migrateFromHouseholdId');
    expect(container.querySelector('[data-testid="transfer-deferred"]')).toBeNull();
    // Account session established only now; nothing claims the guest data moved.
    expect(localStorage.getItem('frigo_user_id')).toBe(ACCOUNT.id);
    expect(localStorage.getItem('frigo_household_id')).toBe(ACCOUNT.householdId);
    expect(localStorage.getItem('frigo_is_guest')).toBe('false');
    expect(useAuthStore.getState()).toMatchObject({ userId: ACCOUNT.id, householdId: ACCOUNT.householdId, isGuest: false });
    expect(container.textContent).not.toContain('đã được chuyển');
    // The guest outbox entry was NOT rebound to the new account (no migration happened).
    expect(getPendingOps().filter((op) => op.householdId === ACCOUNT.householdId)).toEqual([]);
    await until(() => expect(container.querySelector('[data-testid="onboarding"]')).toBeTruthy());
  });

  it('E. a failed continue-without-transfer retry leaves the guest session intact and never half-authenticates', async () => {
    seedGuestSession();
    const before = guestState();
    verifyResponses.push({ status: 409, body: DEFERRED });
    verifyResponses.push({ status: 400, body: { error: 'Mã OTP đã hết hạn. Vui lòng bấm gửi lại mã mới.' } });
    await registerAndReachOtp();
    await click('Xác thực & Hoàn tất');
    await until(() => expect(container.querySelector('[data-testid="transfer-deferred"]')).toBeTruthy());
    await click('Tiếp tục không chuyển dữ liệu khách');
    await until(() => expect(container.textContent).toContain('Mã OTP đã hết hạn'));
    expect(verifyBodies[1]).not.toHaveProperty('migrateFromHouseholdId');
    expect(guestState()).toEqual(before);
    expect(localStorage.getItem('frigo_is_guest')).toBe('true');
    expect(useAuthStore.getState().isGuest).toBe(true);
    expect(container.querySelector('[data-testid="onboarding"]')).toBeNull();
  });

  it('keeps unrelated OTP failures on the normal error path (no deferral state)', async () => {
    seedGuestSession();
    verifyResponses.push({ status: 400, body: { error: 'Mã OTP không chính xác hoặc đã được sử dụng' } });
    await registerAndReachOtp();
    await click('Xác thực & Hoàn tất');
    await until(() => expect(container.textContent).toContain('Mã OTP không chính xác'));
    expect(container.querySelector('[data-testid="transfer-deferred"]')).toBeNull();
    expect(buttonExists('Xác thực & Hoàn tất')).toBe(true);
    expect(localStorage.getItem('frigo_is_guest')).toBe('true');
  });

  it('classifies only the DEC-012 envelope as a deferral', () => {
    expect(isInventoryTransferDeferred(new ApiError('http', `HTTP 409: ${JSON.stringify(DEFERRED)}`, 409))).toBe(true);
    expect(isInventoryTransferDeferred(new ApiError('http', 'HTTP 409: {"error":"other","code":"CONFLICT"}', 409))).toBe(false);
    expect(isInventoryTransferDeferred(new ApiError('http', `HTTP 400: ${JSON.stringify(DEFERRED)}`, 400))).toBe(false);
    expect(isInventoryTransferDeferred(new ApiError('offline', 'Không có kết nối mạng', undefined, { retryable: true }))).toBe(false);
    expect(isInventoryTransferDeferred(new ApiError('auth', 'HTTP 401: {"code":"INVENTORY_TRANSFER_DEFERRED"}', 401))).toBe(false);
    expect(isInventoryTransferDeferred(new Error(INVENTORY_TRANSFER_DEFERRED))).toBe(false);
    expect(new ApiError('http', 'HTTP 409: not-json', 409).code).toBeNull();
  });
});
