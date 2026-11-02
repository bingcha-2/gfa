import { render, screen } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/console/client-api', () => ({ apiRequest: mocks.api, getErrorMessage: (e: Error) => e.message }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import GatewayAccountsPage from '@/app/(console)/console/(dashboard)/(product)/gateway-accounts/page';
it('shows mother type and actual observation time without exposing freshness codes', async () => {
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/settings')
    ? { baseUrl: 'https://test.invalid', hasOpKey: true }
    : [{ id: 'm', accountName: 'mother@example.test', accountType: 'Max 20x', status: 'ready',
      models: [], enabled: true, totalShares: 6, allocatedShares: 1, userCount: 1,
      usage: [{ share: { windows: { '5h': { remaining: .92, freshness: 'unknown', readingAt: 1800000000000 }, '7d': { remaining: null } } } }] }]);
  render(<GatewayAccountsPage />);
  expect(await screen.findByText('Max 20x')).toBeInTheDocument();
  expect(screen.getByText('剩余 92.0%')).toBeInTheDocument();
  expect(screen.getByText(/^更新于 /)).toBeInTheDocument();
  expect(screen.getByText('暂未获取')).toBeInTheDocument();
  expect(screen.queryByText(/unknown/)).not.toBeInTheDocument();
});
