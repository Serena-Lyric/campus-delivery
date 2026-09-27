import { FoodType } from '@prisma/client';

export type ItemClassification = {
  suggestedFoodType: FoodType;
  handlingTags: string[];
  source: string;
  version: string;
  confidenceBps: number;
};

export interface ItemClassifier {
  classify(input: { productName: string; merchantCategoryName: string }): Promise<ItemClassification>;
}

export class DeterministicItemClassifier implements ItemClassifier {
  async classify(input: { productName: string; merchantCategoryName: string }): Promise<ItemClassification> {
    const text = `${input.productName} ${input.merchantCategoryName}`.toLowerCase();
    const match = (words: string[]) => words.some((word) => text.includes(word));
    if (match(['茶', '饮', '咖啡', '奶', 'juice', 'drink'])) {
      return { suggestedFoodType: FoodType.DRINK, handlingTags: ['LIQUID'], source: 'DETERMINISTIC_FALLBACK', version: '1', confidenceBps: 8000 };
    }
    if (match(['汤', '粥', 'soup'])) {
      return { suggestedFoodType: FoodType.SOUP, handlingTags: ['LIQUID', 'SPILL_RISK'], source: 'DETERMINISTIC_FALLBACK', version: '1', confidenceBps: 8000 };
    }
    if (match(['面', '粉', 'noodle'])) {
      return { suggestedFoodType: FoodType.NOODLE, handlingTags: [], source: 'DETERMINISTIC_FALLBACK', version: '1', confidenceBps: 8000 };
    }
    if (match(['蛋糕', '甜点', '糕点', 'cake', 'dessert'])) {
      return { suggestedFoodType: FoodType.CAKE_DESSERT, handlingTags: ['CRUSH_RISK'], source: 'DETERMINISTIC_FALLBACK', version: '1', confidenceBps: 8000 };
    }
    if (match(['饭', '便当', 'rice'])) {
      return { suggestedFoodType: FoodType.RICE_MEAL, handlingTags: [], source: 'DETERMINISTIC_FALLBACK', version: '1', confidenceBps: 8000 };
    }
    return { suggestedFoodType: FoodType.UNKNOWN, handlingTags: [], source: 'DETERMINISTIC_FALLBACK', version: '1', confidenceBps: 0 };
  }
}

export class ManualItemClassifierFallback implements ItemClassifier {
  async classify(): Promise<ItemClassification> {
    return { suggestedFoodType: FoodType.UNKNOWN, handlingTags: [], source: 'MANUAL_FALLBACK', version: '1', confidenceBps: 0 };
  }
}

export async function classifyItemSafely(
  classifier: ItemClassifier,
  input: { productName: string; merchantCategoryName: string },
): Promise<ItemClassification> {
  try {
    return await classifier.classify(input);
  } catch {
    return new ManualItemClassifierFallback().classify();
  }
}
