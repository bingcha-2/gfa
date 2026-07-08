import { describe, expect, it } from 'vitest';

import { eventWeightedCost, CODEX_FAST_CU_MULTIPLIER } from '../token-billing';

describe('eventWeightedCost 快速档乘数', () => {
  const base = { modelKey: 'gpt-5-codex', inputTokens: 1000, outputTokens: 500, cachedInputTokens: 100 };

  it('标准档(无 serviceTier)= 基础 CU', () => {
    const std = eventWeightedCost(base);
    expect(std).toBeGreaterThan(0);
    expect(eventWeightedCost({ ...base, serviceTier: '' })).toBe(std);
    expect(eventWeightedCost({ ...base, serviceTier: 'default' })).toBe(std);
  });

  it('快速档(priority)= 基础 × 1.5', () => {
    const std = eventWeightedCost(base);
    expect(eventWeightedCost({ ...base, serviceTier: 'priority' })).toBeCloseTo(std * CODEX_FAST_CU_MULTIPLIER, 6);
    expect(eventWeightedCost({ ...base, serviceTier: 'Priority' })).toBeCloseTo(std * CODEX_FAST_CU_MULTIPLIER, 6);
  });

  it('无 input/output 的 legacy 事件也套用乘数', () => {
    const legacy = { modelKey: 'gpt-5-codex', totalTokens: 200 };
    const std = eventWeightedCost(legacy);
    expect(eventWeightedCost({ ...legacy, serviceTier: 'priority' })).toBeCloseTo(std * CODEX_FAST_CU_MULTIPLIER, 6);
  });
});
