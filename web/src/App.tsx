import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { UserProvider, useUser } from "./context/UserContext";
import UserSelectPage from "./pages/UserSelectPage";
import FeedPage from "./pages/FeedPage";
import CollectionPage from "./pages/CollectionPage";
import GameDetailPage from "./pages/GameDetailPage";
import PlaysPage from "./pages/PlaysPage";
import PlayDetailPage from "./pages/PlayDetailPage";
import PlayFormPage from "./pages/PlayFormPage";
import InsightsPage from "./pages/InsightsPage";
import SettingsPage from "./pages/SettingsPage";
import BottomNav from "./components/BottomNav";

function Gate({ children }: { children: ReactNode }) {
  const { currentUser, loading } = useUser();
  if (loading) return <div style={{ padding: 24, color: "var(--muted)" }}>불러오는 중...</div>;
  if (!currentUser) return <UserSelectPage />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Gate>
      <Routes>
        <Route path="/" element={<FeedPage />} />
        <Route path="/collection" element={<CollectionPage />} />
        <Route path="/game/:id" element={<GameDetailPage />} />
        <Route path="/plays" element={<PlaysPage />} />
        <Route path="/plays/new" element={<PlayFormPage />} />
        <Route path="/plays/:id/edit" element={<PlayFormPage />} />
        <Route path="/plays/:id" element={<PlayDetailPage />} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <BottomNav />
    </Gate>
  );
}

export default function App() {
  return (
    <UserProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </UserProvider>
  );
}
