import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/query-client';
import { SessionBoundary } from './components/common/SessionBoundary';
import { RouteFallback } from './components/common/RouteFallback';
import { useAuthStore } from './stores/useAuthStore';
import { AppLayout } from './components/layout/AppLayout';
import { isMealPlannerEnabled } from './features/planner/feature';

const PlannerPage = lazy(() => import('./pages/PlannerPage').then((m) => ({ default: m.PlannerPage })));

const LandingPage = lazy(() =>
  import('./pages/LandingPage').then((m) => ({ default: m.LandingPage })),
);
const AuthPage = lazy(() => import('./pages/AuthPage').then((m) => ({ default: m.AuthPage })));
const OnboardingPage = lazy(() =>
  import('./pages/OnboardingPage').then((m) => ({ default: m.OnboardingPage })),
);
const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const InventoryPage = lazy(() =>
  import('./pages/InventoryPage').then((m) => ({ default: m.InventoryPage })),
);
const IngredientDetailPage = lazy(() =>
  import('./pages/IngredientDetailPage').then((m) => ({ default: m.IngredientDetailPage })),
);
const ReconciliationPage = lazy(() =>
  import('./pages/ReconciliationPage').then((m) => ({ default: m.ReconciliationPage })),
);
const ScanPage = lazy(() => import('./pages/ScanPage').then((m) => ({ default: m.ScanPage })));
const ScanResultPage = lazy(() =>
  import('./pages/ScanResultPage').then((m) => ({ default: m.ScanResultPage })),
);
const ReceiptReviewPage = lazy(() =>
  import('./pages/ReceiptReviewPage').then((m) => ({ default: m.ReceiptReviewPage })),
);
const RecipesPage = lazy(() =>
  import('./pages/RecipesPage').then((m) => ({ default: m.RecipesPage })),
);
const RecipeDetailPage = lazy(() =>
  import('./pages/RecipeDetailPage').then((m) => ({ default: m.RecipeDetailPage })),
);
const CookingModePage = lazy(() =>
  import('./pages/CookingModePage').then((m) => ({ default: m.CookingModePage })),
);
const CookingCompletePage = lazy(() =>
  import('./pages/CookingCompletePage').then((m) => ({ default: m.CookingCompletePage })),
);
const ShoppingPage = lazy(() =>
  import('./pages/ShoppingPage').then((m) => ({ default: m.ShoppingPage })),
);
const NotificationsPage = lazy(() =>
  import('./pages/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
);
const ProfilePage = lazy(() =>
  import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage })),
);
const FamilySharingPage = lazy(() =>
  import('./pages/FamilySharingPage').then((m) => ({ default: m.FamilySharingPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const PlusPaywallPage = lazy(() =>
  import('./pages/PlusPaywallPage').then((m) => ({ default: m.PlusPaywallPage })),
);
const WeekDashboardPage = lazy(() =>
  import('./pages/WeekDashboardPage').then((m) => ({ default: m.WeekDashboardPage })),
);
const WeekSetupPage = lazy(() =>
  import('./pages/WeekSetupPage').then((m) => ({ default: m.WeekSetupPage })),
);
const WeekGeneratingPage = lazy(() =>
  import('./pages/WeekGeneratingPage').then((m) => ({ default: m.WeekGeneratingPage })),
);
const MealDetailPage = lazy(() =>
  import('./pages/MealDetailPage').then((m) => ({ default: m.MealDetailPage })),
);
const WeekShoppingPage = lazy(() =>
  import('./pages/WeekShoppingPage').then((m) => ({ default: m.WeekShoppingPage })),
);
const WeekSettingsPage = lazy(() =>
  import('./pages/WeekSettingsPage').then((m) => ({ default: m.WeekSettingsPage })),
);

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed)
      return (
        <main className="min-h-screen p-6 space-y-4 text-center">
          <h1 className="text-xl font-bold" role="alert">
            Không thể mở trang này
          </h1>
          <p>Vui lòng tải lại ứng dụng để thử lại.</p>
          <button
            className="rounded-xl bg-emerald-700 px-4 py-3 text-white"
            onClick={() => window.location.reload()}
          >
            Tải lại
          </button>
        </main>
      );
    return this.props.children;
  }
}

export const App: React.FC = () => {
  const { isOnboarded, userId, householdId } = useAuthStore();

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppErrorBoundary key={`${userId}:${householdId}`}>
          <SessionBoundary>
            <Suspense fallback={<RouteFallback />}>
              <Routes key={`${userId}:${householdId}`}>
                {/* Public / Intro Routes */}
                <Route path="/landing" element={<LandingPage />} />
                <Route path="/auth" element={<AuthPage />} />
                <Route path="/onboarding" element={<OnboardingPage />} />

                {/* Core App Shell */}
                <Route
                  element={
                    userId && householdId ? <AppLayout /> : <Navigate to="/landing" replace />
                  }
                >
                  <Route
                    path="/"
                    element={isOnboarded ? <HomePage /> : <Navigate to="/landing" replace />}
                  />

                  {/* Fridge / Inventory */}
                  <Route path="/fridge" element={<InventoryPage />} />
                  <Route path="/inventory" element={<Navigate to="/fridge" replace />} />
                  <Route path="/ingredients/:id" element={<IngredientDetailPage />} />
                  <Route path="/inventory/:id" element={<IngredientDetailPage />} />
                  <Route path="/inventory-reconciliation" element={<ReconciliationPage />} />

                  {/* AI Scan & Review */}
                  <Route path="/scan" element={<ScanPage />} />
                  <Route path="/scan/:id/review" element={<ScanResultPage />} />
                  <Route path="/scan/receipt-review" element={<ReceiptReviewPage />} />
                  <Route path="/scan/result" element={<ScanResultPage />} />

                  {/* Recipes & Cooking */}
                  <Route path="/recipes" element={<RecipesPage />} />
                  <Route path="/recipes/:slug" element={<RecipeDetailPage />} />
                  <Route path="/recipes/id/:id" element={<RecipeDetailPage />} />
                  <Route path="/cook/:slug" element={<CookingModePage />} />
                  <Route path="/cooking/:id" element={<CookingModePage />} />
                  <Route path="/cooking/complete" element={<CookingCompletePage />} />

                  {/* Frigo Week / Thực đơn tuần */}
                  <Route path="/week" element={<WeekDashboardPage />} />
                  <Route path="/week/setup" element={<WeekSetupPage />} />
                  <Route path="/week/generating" element={<WeekGeneratingPage />} />
                  <Route path="/week/:planId" element={<WeekDashboardPage />} />
                  <Route path="/week/:planId/meal/:mealId" element={<MealDetailPage />} />
                  <Route path="/week/:planId/shopping" element={<WeekShoppingPage />} />
                  <Route path="/week/:planId/settings" element={<WeekSettingsPage />} />
                  <Route path="/planner" element={isMealPlannerEnabled() ? <PlannerPage /> : <Navigate to="/week" replace />} />
                  <Route path="/planner/new" element={isMealPlannerEnabled() ? <PlannerPage /> : <Navigate to="/week" replace />} />
                  <Route path="/planner/:planId" element={isMealPlannerEnabled() ? <PlannerPage /> : <Navigate to="/week" replace />} />
                  <Route path="/planner/:planId/meal/:slotId" element={isMealPlannerEnabled() ? <PlannerPage /> : <Navigate to="/week" replace />} />
                  <Route path="/planner/:planId/shopping" element={isMealPlannerEnabled() ? <PlannerPage /> : <Navigate to="/week" replace />} />

                  {/* Shopping, Profile, Settings, Notifications, Plus, Family */}
                  <Route path="/shopping" element={<ShoppingPage />} />
                  <Route path="/notifications" element={<NotificationsPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/family" element={<FamilySharingPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/plus" element={<PlusPaywallPage />} />
                </Route>

                {/* Catch-all fallback */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </SessionBoundary>
        </AppErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  );
};
