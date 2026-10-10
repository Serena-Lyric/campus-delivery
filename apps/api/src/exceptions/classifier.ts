import { ExceptionCasePriority, ExceptionType } from '@prisma/client';

export type ExceptionClassification = {
  category: ExceptionType;
  subtype: string | null;
  priority: ExceptionCasePriority;
  routeSuggestion: 'OPERATOR_POOL' | 'SUPER_ADMIN_REVIEW';
  confidenceBps: number;
};

export interface ExceptionClassifier {
  readonly source: string;
  readonly version: string;
  classify(input: { type: ExceptionType; description: string }): Promise<ExceptionClassification>;
}

export class DeterministicExceptionClassifier implements ExceptionClassifier {
  readonly source = 'DETERMINISTIC_FALLBACK';
  readonly version = '1';

  async classify(input: { type: ExceptionType; description: string }): Promise<ExceptionClassification> {
    const high = input.type === ExceptionType.SEVERE_FOOD_DAMAGE
      || input.type === ExceptionType.FOOD_LOST
      || input.type === ExceptionType.DELIVERY_DISPUTE
      || input.type === ExceptionType.PICKUP_CUSTODY_DISPUTE;
    const medium = input.type === ExceptionType.RIDER_DELIVERY_EXCEPTION
      || input.type === ExceptionType.CUSTOMER_UNREACHABLE;
    return {
      category: input.type,
      subtype: null,
      priority: high ? ExceptionCasePriority.HIGH : medium ? ExceptionCasePriority.MEDIUM : ExceptionCasePriority.UNKNOWN,
      routeSuggestion: 'OPERATOR_POOL',
      confidenceBps: 10_000,
    };
  }
}

export type SourcedExceptionClassification = ExceptionClassification & {
  source: string;
  version: string;
};

export async function classifyExceptionSafely(
  classifier: ExceptionClassifier,
  input: { type: ExceptionType; description: string },
): Promise<SourcedExceptionClassification> {
  try {
    return { ...await classifier.classify(input), source: classifier.source, version: classifier.version };
  } catch {
    const fallback = new ManualFallbackClassifier();
    return { ...await fallback.classify(input), source: fallback.source, version: fallback.version };
  }
}

export class ManualFallbackClassifier implements ExceptionClassifier {
  readonly source = 'MANUAL_FALLBACK';
  readonly version = '1';

  async classify(input: { type: ExceptionType; description: string }): Promise<ExceptionClassification> {
    return {
      category: input.type,
      subtype: null,
      priority: ExceptionCasePriority.UNKNOWN,
      routeSuggestion: 'OPERATOR_POOL',
      confidenceBps: 0,
    };
  }
}
