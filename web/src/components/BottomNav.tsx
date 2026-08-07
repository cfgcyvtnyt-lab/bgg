import { NavLink } from "react-router-dom";
import "../styles/BottomNav.css";

// 기록은 원래 U+1F4DD(메모)였는데 그 글리프만 무게중심이 왼쪽으로 2.2px 치우쳐 있어
// (나머지는 0.5px 안쪽) 아래 글자가 오른쪽으로 밀려 보였다. CSS로 밀면 폰트마다
// 글리프가 달라서 아이폰에서 되레 어긋나므로, 좌우 대칭인 클립보드로 바꿨다.
const TABS = [
  { to: "/", label: "피드", icon: "\u{1F3E0}" },
  { to: "/collection", label: "컬렉션", icon: "\u{1F4E6}" },
  { to: "/plays", label: "기록", icon: "\u{1F4CB}" },
  { to: "/insights", label: "인사이트", icon: "\u{1F4CA}" },
  { to: "/settings", label: "설정", icon: "\u{2699}\u{FE0F}" },
];

// 아래 탭을 누르면 그 화면을 맨 위부터 보여준다.
// 탭은 지우지 않고 살려두므로 스크롤이 그대로 남는데(App.tsx 참고), 뒤로 가기로 돌아올 때는
// 그게 맞지만 탭을 직접 누른 건 "처음부터 보겠다"는 뜻에 가깝다. 위로 갈 방법도 있어야 한다.
// 아직 안 열린 탭은 이 순간 화면에 없으므로 그려진 다음 프레임에 옮긴다.
// 탭은 지우지 않고 살려두므로(App.tsx 참고) 스크롤도 목록도 그대로 남는다.
// 뒤로 가기로 돌아올 때는 그게 맞지만, 탭을 직접 누른 건 "처음부터 보겠다"는 뜻이다.
// 스크롤만 올리면 무한 스크롤로 쌓인 수백 개가 그대로 남아 화면이 계속 무겁다.
// 그래서 목록도 첫 페이지로 되돌리라고 알린다.
export const TAB_RESET_EVENT = "bgg:tab-reset";

function resetTab(path: string) {
  const go = () => {
    const pane = document.querySelector<HTMLElement>(`.app-pane[data-pane="${path}"]`);
    if (pane) pane.scrollTop = 0;
  };
  go();
  // 아직 안 열린 탭은 이 순간 화면에 없다. 그려진 뒤에 한 번 더 시도한다.
  setTimeout(go, 0);
  window.dispatchEvent(new CustomEvent(TAB_RESET_EVENT, { detail: path }));
}

export default function BottomNav() {
  return (
    <nav className="bottom-nav">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === "/"}
          className={({ isActive }) => `bottom-nav-item${isActive ? " active" : ""}`}
          onClick={() => resetTab(t.to)}
        >
          <span className="bottom-nav-icon">{t.icon}</span>
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
