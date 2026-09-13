// Query-key factory. Every server-state key embeds the owning user+household
// so cached data can never leak across account or household switches.
import { getCurrentScope } from '../services/http';

function scope(): [string, string] {
  const { userId, householdId } = getCurrentScope();
  return [userId, householdId];
}

export const queryKeys = {
  me: () => ['me', ...scope()] as const,
  inventory: () => ['inventory', ...scope()] as const,
  inventoryLot: (lotId: string) => ['inventory', ...scope(), 'lot', lotId] as const,
  inventoryObservations: () => ['inventory', ...scope(), 'observations'] as const,
  recommendationLists: () => ['recommendations', ...scope()] as const,
  recommendations: (params: {
    noBuy: boolean;
    cuisine: string | null;
    category?: string | null;
    region?: string | null;
    maxTime?: number;
  }) => ['recommendations', ...scope(), params] as const,
  recipes: () => ['recipe', ...scope()] as const,
  recipe: (idOrSlug: string) => ['recipe', ...scope(), idOrSlug] as const,
  weekPlans: () => ['weekPlan', ...scope()] as const,
  currentWeekPlan: () => ['weekPlan', ...scope(), 'current'] as const,
  weekPlan: (planId: string) => ['weekPlan', ...scope(), planId] as const,
  mealPlanningPlan: (planId: string) => ['mealPlanningPlan', ...scope(), planId] as const,
  currentMealPlanningPlan: () => ['mealPlanningPlan', ...scope(), 'current'] as const,
  mealPlanningShopping: (planId: string) => ['mealPlanningShopping', ...scope(), planId] as const,
  mealPlanningAlternatives: (planId: string, slotId: string) =>
    ['mealPlanningAlternatives', ...scope(), planId, slotId] as const,
  mealPlanningAlternativesForPlan: (planId: string) =>
    ['mealPlanningAlternatives', ...scope(), planId] as const,
  notifications: () => ['notifications', ...scope()] as const,
  shoppingList: () => ['shoppingList', ...scope()] as const,
};
