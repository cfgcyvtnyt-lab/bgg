import { NavLink } from "react-router-dom";
import "../styles/BottomNav.css";

const TABS = [
  { to: "/", label: "컬렉션", icon: "\u{1F4E6}" },
  { to: "/plays", label: "기록", icon: "\u{1F4DD}" },
  { to: "/insights", label: "인사이트", icon: "\u{1F4CA}" },
  { to: "/settings", label: "설정", icon: "\u{2699}\u{FE0F}" },
];

export default function BottomNav() {
  return (
    <nav className="bottom-nav">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === "/"}
          className={({ isActive }) => `bottom-nav-item${isActive ? " active" : ""}`}
        >
          <span className="bottom-nav-icon">{t.icon}</span>
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
