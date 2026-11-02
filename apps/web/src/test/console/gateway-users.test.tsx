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
  fireEvent.change(screen.getByPlaceholderText('用户邮箱'), { target: { value: 'none@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: '分配' }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('必须有有效的 Claude 订阅才能分配母号'));
  expect(mocks.api.mock.calls.some(([path, opts]) => path === 'gateway-users' && opts?.method === 'POST')).toBe(false);
});
