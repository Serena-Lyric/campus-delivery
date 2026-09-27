import { FoodType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { DeterministicItemClassifier, classifyItemSafely, type ItemClassifier } from '../src/item-classifier/classifier.js';

describe('low-risk item classifier', () => {
  it('returns a typed delivery-oriented suggestion without changing original facts', async () => {
    const result = await new DeterministicItemClassifier().classify({ productName: '珍珠奶茶', merchantCategoryName: '饮品' });
    expect(result).toMatchObject({ suggestedFoodType: FoodType.DRINK, source: 'DETERMINISTIC_FALLBACK' });
    expect(result.handlingTags).toContain('LIQUID');
  });

  it('falls back to UNKNOWN when an adapter fails', async () => {
    const failing: ItemClassifier = { classify: async () => { throw new Error('Jev unavailable'); } };
    await expect(classifyItemSafely(failing, { productName: '未知商品', merchantCategoryName: '其他' }))
      .resolves.toMatchObject({ suggestedFoodType: FoodType.UNKNOWN, source: 'MANUAL_FALLBACK' });
  });
});
