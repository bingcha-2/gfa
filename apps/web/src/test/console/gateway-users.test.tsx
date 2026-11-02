import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ api: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/console/client-api', () => ({ apiRequest: mocks.api, getErrorMessage: (e: Error) => e.message }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.error } }));
import GatewayUsersPage from '@/app/(console)/console/(dashboard)/(product)/gateway-users/page';
it('shows subscription state and refuses to submit an ineligible allocation', async () => {
  mocks.api.mockImplementation(async (path: string) => {
    if (path.includes('eligibility?')) return { eligible: false, message: '必须有有效的 Claude 订阅才能分配母号' };
    if (path.endsWith('/settings')) return { shareUsd: 165, defaultUserShares: 1, defaultTotalShares: 6 };
    return [{ id: 'u', email: 'old@example.test', subscriptionValid: false, shares: 1, limitUsd: 165, usedUsd: 0, remainingUsd: 165, totalUsedUsd: 0, totalRequests: 0, enabled: true }];
  });
  render(<GatewayUsersPage />);
  expect(await screen.findByText('无有效订阅')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '分配用户' }));
  fireEvent.change(screen.getByPlaceholderText('用户邮箱'), { target: { value: 'none@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: '分配' }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('必须有有效的 Claude 订阅才能分配母号'));
  expect(mocks.api.mock.calls.some(([path, opts]) => path === 'gateway-users' && opts?.method === 'POST')).toBe(false);
});

it('renders both effective plan windows instead of the legacy share limit', async () => {
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/settings')
    ? { shareUsd: 165, defaultUserShares: 1, defaultTotalShares: 6 }
    : [{ id: 'u', email: 'plan@example.test', subscriptionValid: true, shares: 1,
      limitUsd: 165, usedUsd: 999, totalUsedUsd: 3, totalRequests: 2, enabled: true,
      quotaWindows: [{ period: '5h', usedUsd: 2, limitUsd: null, resetAt: null },
        { period: '7d', usedUsd: 3, limitUsd: 100, resetAt: 1800000000000 }] }]);
  render(<GatewayUsersPage />);
  expect(await screen.findByText('$2.00 / 不限额')).toBeInTheDocument();
  expect(screen.getByText('$3.00 / $100.00')).toBeInTheDocument();
  expect(screen.queryByText('$999.00 / $165.00')).not.toBeInTheDocument();
  expect(screen.getByText('五小时额度')).toBeInTheDocument();
  expect(screen.getByText('每周额度')).toBeInTheDocument();
});

it('saves independent overrides and can restore the plan without resetting usage', async () => {
  mocks.api.mockClear();
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/settings')
    ? { defaultUserShares: 1, defaultTotalShares: 6 }
    : [{ id: 'u', email: 'edit@example.test', subscriptionValid: true, subscriptionId: 's', quotaSource: 'plan',
      quotaOverrides: { fiveHour: null, weekly: null }, quotaWindows: [], totalUsedUsd: 2, totalRequests: 1, enabled: true }]);
  render(<GatewayUsersPage />);
  fireEvent.click(await screen.findByRole('button', { name: '管理' }));
  fireEvent.click(await screen.findByRole('button', { name: '调整额度' }));
  fireEvent.change(screen.getByLabelText('五小时上限（美元）'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: '保存额度' }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('gateway-users/u/quota', { method: 'PUT', body: { subscriptionId: 's', fiveHour: 0, weekly: null } }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '调整用户额度' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: '调整额度' }));
  fireEvent.click(screen.getByRole('button', { name: '恢复套餐额度' }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('gateway-users/u/quota', { method: 'PUT', body: { subscriptionId: 's', fiveHour: null, weekly: null } }));
  expect(mocks.api.mock.calls.some(([path]) => path.endsWith('/reset'))).toBe(false);
  expect(screen.queryByText('每份额度(美元)')).not.toBeInTheDocument();
});

it('filters users and keeps maintenance actions out of the table', async () => {
  mocks.api.mockResolvedValue([{ id: 'u', email: 'find@example.test', enabled: true, subscriptionValid: true, subscriptionName: 'Claude 专享', subscriptionExpiresAt: '2026-12-01T00:00:00Z', quotaWindows: [{period:'5h', usedUsd: 2, limitUsd: 10, resetAt: null}] }]);
  render(<GatewayUsersPage />);
  expect(await screen.findByText('Claude 专享')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');
  expect(screen.queryByRole('button', { name: '更换 Key' })).not.toBeInTheDocument();
  expect(screen.queryByText('份数')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('搜索用户'), { target: {value: 'missing'} });
  expect(screen.getByText('没有匹配的用户')).toBeInTheDocument();
});
