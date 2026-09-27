import { ExceptionType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  DeterministicExceptionClassifier,
  classifyExceptionSafely,
  type ExceptionClassifier,
} from '../src/exceptions/classifier.js';

describe('low-risk exception classifier', () => {
  it('routes ordinary severe exception types to the operator pool by default', async () => {
    const result = await new DeterministicExceptionClassifier().classify({
      type: ExceptionType.FOOD_LOST,
      description: 'Needs ordinary human review',
    });
    expect(result).toMatchObject({ priority: 'HIGH', routeSuggestion: 'OPERATOR_POOL' });
  });

  it('falls back to explicit manual metadata when an adapter throws', async () => {
    const failing: ExceptionClassifier = {
      source: 'JEV_TEST_ADAPTER',
      version: 'test',
      classify: async () => { throw new Error('Jev unavailable'); },
    };
    await expect(classifyExceptionSafely(failing, {
      type: ExceptionType.DELIVERY_DISPUTE,
      description: 'Classifier failure must not block reporting',
    })).resolves.toMatchObject({
      category: ExceptionType.DELIVERY_DISPUTE,
      routeSuggestion: 'OPERATOR_POOL',
      confidenceBps: 0,
      source: 'MANUAL_FALLBACK',
      version: '1',
    });
  });
});
