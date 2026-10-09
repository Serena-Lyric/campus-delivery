import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { CategoryBody, ProductBody } from '../src/catalog/service.js';

describe('merchant catalog input constraints', () => {
  it('accepts display text without permitting authoritative risk fields', () => {
    const input = { categoryId: '40000000-0000-4000-8000-000000000001', name: '招牌', sortOrder: 0, priceMinor: 1500, isAvailable: true, marketingTags: ['人气'], deliveryCategoryCode: 'CAKE' };
    expect(Value.Check(ProductBody, input)).toBe(true);
    expect(Value.Check(ProductBody, { ...input, coreFragile: false })).toBe(false);
    expect(Value.Check(ProductBody, { ...input, priceMinor: -1 })).toBe(false);
    expect(Value.Check(ProductBody, { ...input, name: ' ' })).toBe(false);
    expect(Value.Check(CategoryBody, { name: '自由分组', sortOrder: 1 })).toBe(true);
  });
});
