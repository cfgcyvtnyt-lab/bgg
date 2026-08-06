import { useState } from "react";
import { useUser } from "../context/UserContext";
import "../styles/Settings.css";

// BGA 계정 연동/동기화는 아직 없다. 아이디만 로컬에 저장해두고 나중에 쓸 자리를 마련한다.
const BGA_KEY = "bgg_bga_username";

export default function SettingsPage() {
  const { users, currentUser, setCurrentUser } = useUser();
  const [bgaUsername, setBgaUsername] = useState(() => localStorage.getItem(BGA_KEY) || "");
  const [saved, setSaved] = useState(false);

  function saveBga() {
    localStorage.setItem(BGA_KEY, bgaUsername.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="page settings-page">
      <div className="page-header"><h1>설정</h1></div>

      <div className="section-title">사용자</div>
      <div className="card user-switch">
        {users.map((u) => (
          <button
            key={u.id}
            className={`user-switch-btn${currentUser?.id === u.id ? " active" : ""}`}
            onClick={() => setCurrentUser(u)}
          >
            {u.name}
          </button>
        ))}
      </div>

      <div className="section-title">BGA 계정</div>
      <div className="card">
        <div className="field">
          <label>BGA 아이디</label>
          <input
            value={bgaUsername}
            onChange={(e) => setBgaUsername(e.target.value)}
            placeholder="Board Game Arena 아이디"
          />
        </div>
        <button className="btn-primary" onClick={saveBga}>저장{saved ? "됨" : ""}</button>
        <p className="muted bga-note">동기화 기능은 아직 준비 중입니다. 아이디만 저장됩니다.</p>
      </div>
    </div>
  );
}
