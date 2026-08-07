import { HashRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { UserProvider, useUser } from "./context/UserContext";
import UserSelectPage from "./pages/UserSelectPage";
import FeedPage from "./pages/FeedPage";
import BottomNav from "./components/BottomNav";

// 첫 화면(피드)만 같이 받고 나머지는 그 화면에 들어갈 때 받는다.
// 예전엔 전부 한 덩어리(370KB)라 피드만 보려 해도 인사이트·표 모드·도전과제까지 다 받았다.
const CollectionPage = lazy(() => import("./pages/CollectionPage"));
const GameDetailPage = lazy(() => import("./pages/GameDetailPage"));
const PlaysPage = lazy(() => import("./pages/PlaysPage"));
const PlayDetailPage = lazy(() => import("./pages/PlayDetailPage"));
const PlayFormPage = lazy(() => import("./pages/PlayFormPage"));
const InsightsPage = lazy(() => import("./pages/InsightsPage"));
const ChallengesPage = lazy(() => import("./pages/ChallengesPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const SleevesPage = lazy(() => import("./pages/SleevesPage"));
const BgaImportPage = lazy(() => import("./pages/BgaImportPage"));

function Gate({ children }: { children: ReactNode }) {
  const { currentUser, loading } = useUser();
  if (loading) return <div className="page center-pad muted">불러오는 중...</div>;
  if (!currentUser) return <UserSelectPage />;
  return <>{children}</>;
}

const Loading = <div className="page center-pad muted">불러오는 중...</div>;

/**
 * 하단 탭 다섯 개는 한 번 열면 그대로 살려둔다.
 *
 * 예전에는 화면을 옮길 때마다 목록을 지웠다가 다시 만들었다. 그러면 돌아왔을 때 새로 만든
 * 화면이라 맨 위에서 시작하고, 그 뒤에 "아까 그 자리로 가라"고 시켜야 했다. 아무리 빨라도
 * 맨 위에 있던 순간이 눈에 걸린다.
 *
 * 이제는 지우지 않고 화면 밖으로 치워둘 뿐이라 스크롤이 그대로 남는다. 되돌릴 게 없으니
 * 움직임도 없다. 각 탭이 자기 스크롤 상자를 갖는 이유가 이것이다 - 창 하나를 같이 쓰면
 * 위치가 하나뿐이라 탭마다 따로 기억할 수가 없다.
 */
const TABS: { path: string; render: () => ReactNode }[] = [
  { path: "/", render: () => <FeedPage /> },
  { path: "/collection", render: () => <CollectionPage /> },
  { path: "/plays", render: () => <PlaysPage /> },
  { path: "/insights", render: () => <InsightsPage /> },
  { path: "/settings", render: () => <SettingsPage /> },
];

function AppShell() {
  const { pathname } = useLocation();
  // 계정을 전환하면 탭 화면을 통째로 다시 만든다. 탭을 살려두는 구조라 이게 없으면
  // 기록·인사이트·컬렉션 평점이 예전 계정 것으로 남는다(화면이 안 사라지니 다시 안 불러온다).
  const { currentUser } = useUser();
  const userKey = currentUser?.id ?? 0;
  const activeTab = TABS.find((t) => t.path === pathname)?.path ?? null;
  const detailPaneRef = useRef<HTMLDivElement>(null);

  // 상세 화면이 바뀌면 맨 위부터 보여준다. 그리기 전에 옮겨야 튀지 않는다.
  useLayoutEffect(() => {
    if (!activeTab && detailPaneRef.current) detailPaneRef.current.scrollTop = 0;
  }, [pathname, activeTab]);

  // 안 가본 탭은 만들지 않는다. 그래야 코드 쪼개기가 살아 있고 첫 진입도 가볍다.
  // 한 번 간 탭은 이후로 계속 살려둔다.
  const [opened, setOpened] = useState<string[]>(() => (activeTab ? [activeTab] : ["/"]));
  useEffect(() => {
    if (activeTab && !opened.includes(activeTab)) setOpened((prev) => [...prev, activeTab]);
  }, [activeTab, opened]);

  return (
    <>
      {/* 화면들은 이 영역 안에서만 스크롤한다. 탭바는 이 바깥에 있어서
          화면 끝이 어디인지 따질 필요 없이 항상 맨 아래에 붙는다. */}
      <div className="app-panes">
      {TABS.filter((t) => opened.includes(t.path)).map((t) => (
        <div key={`${userKey}:${t.path}`} data-pane={t.path} className={`app-pane${activeTab === t.path ? " active" : ""}`}>
          <Suspense fallback={Loading}>{t.render()}</Suspense>
        </div>
      ))}

      {/* 상세·입력 화면은 매번 새로 만든다. 게임마다 내용이 다르니 살려둘 이유가 없다.
          다만 상자는 하나를 돌려쓰므로, 화면이 바뀔 때 스크롤을 직접 맨 위로 돌려야 한다
          (안 그러면 스크롤해서 보던 게임 상세에서 다른 상세로 갈 때 중간부터 보인다). */}
      {!activeTab && (
        <div className="app-pane active" ref={detailPaneRef}>
          <Suspense fallback={Loading}>
            <Routes>
              <Route path="/game/:id" element={<GameDetailPage />} />
              <Route path="/plays/new" element={<PlayFormPage />} />
              <Route path="/plays/:id/edit" element={<PlayFormPage />} />
              <Route path="/plays/:id" element={<PlayDetailPage />} />
              <Route path="/challenges" element={<ChallengesPage />} />
              <Route path="/sleeves" element={<SleevesPage />} />
              <Route path="/bga" element={<BgaImportPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </div>
      )}
      </div>

      <BottomNav />
    </>
  );
}

export default function App() {
  return (
    <UserProvider>
      <HashRouter>
        <Gate>
          <AppShell />
        </Gate>
      </HashRouter>
    </UserProvider>
  );
}
