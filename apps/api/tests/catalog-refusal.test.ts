import { describe, expect, it } from 'vitest';
import { assertCatalogRefusalState } from '../src/catalog/risk-correction.js';

describe('actual custody boundary for catalog refusal', () => {
  const task = { status: 'CLAIMED', pickedUpAt: null, riderId: 'rider', order: { status: 'CLAIMED' } };
  it('allows only a current active assignment before rider pickup', () => {
    expect(() => assertCatalogRefusalState(task, { status: 'ACTIVE' }, 'rider')).not.toThrow();
    expect(() => assertCatalogRefusalState(task, { status: 'ABANDONED' }, 'rider')).toThrow();
    expect(() => assertCatalogRefusalState(task, { status: 'ACTIVE' }, 'other')).toThrow();
  });
  it('blocks physical custody and terminal states even when another label is stale', () => {
    expect(() => assertCatalogRefusalState({ ...task, pickedUpAt: new Date() }, { status: 'ACTIVE' }, 'rider')).toThrow();
    for (const status of ['PICKED_UP', 'COMPLETED', 'NO_RIDER_ACCEPTED', 'RISK_REVIEW']) {
      expect(() => assertCatalogRefusalState({ ...task, status }, { status: 'ACTIVE' }, 'rider')).toThrow();
    }
    expect(() => assertCatalogRefusalState({ ...task, order: { status: 'DELIVERED' } }, { status: 'ACTIVE' }, 'rider')).toThrow();
  });
});
