import { useEffect, useState } from "react";
import { useUser } from "../context/UserContext";
import { api } from "../api/client";
import type { LocationCount } from "../api/types";
import "../styles/Settings.css";

// BGA 계정 연동/동기화는 아직 없다. 아이디만 로컬에 저장해두고 나중에 쓸 자리를 마련한다.
const BGA_KEY = "bgg_bga_username";

// 장소 표기를 직접 바꾸는 섹션. name_alias(조회 시점 병합)와 달리 play.location 원본 값을
// UPDATE로 실제 고친다 - 예전 "이름 정리"보다 더 강한 조작이라 확인 다이얼로그를 반드시 거친다.
function LocationManageSection() {
  const [locations, setLocations] = useState<LocationCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setLocations(await api.locations());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function startRename(name: string) {
    setRenaming(name);
    setNewName(name);
  }

  async function confirmRename(from: string) {
    const to = newName.trim();
    if (!to || to === from) { setRenaming(null); return; }
    const count = locations.find((l) => l.name === from)?.count ?? 0;
    if (!window.confirm(`"${from}" → "${to}"로 바꾸면 ${count}판이 바뀝니다. 계속할까요?`)) return;
    setBusy(true);
    try {
      await api.renameLocation(from, to);
      setRenaming(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-title">장소 관리</div>
      <div className="card">
        {loading && <p className="muted center-pad">불러오는 중...</p>}
        {!loading && locations.length === 0 && <p className="muted center-pad">기록된 장소가 없습니다.</p>}

        {!loading && locations.map((l) => (
          <div key={l.name} className="alias-row">
            <div className="alias-row-main">
              <span>{l.name}</span>
              <span className="muted">{l.count}판</span>
            </div>
            {renaming === l.name ? (
              <div className="alias-row-action">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
                <button className="btn-small" disabled={busy} onClick={() => confirmRename(l.name)}>확인</button>
                <button className="btn-small" disabled={busy} onClick={() => setRenaming(null)}>취소</button>
              </div>
            ) : (
              <div className="alias-row-action">
                <button className="btn-small" onClick={() => startRename(l.name)}>이름 바꾸기</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// BGG는 하루 1회 동기화를 권장한다(서버가 429로 강제한다). 그래서 버튼을 누르면
// "정말 지금 할 거냐"를 확인한 뒤 force=1로 그 제한을 우회한다.
function SyncSection() {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function doSync() {
    if (!window.confirm("BGG 서버 정책상 동기화는 하루 1회만 권장됩니다. 지금 강제로 동기화할까요?")) return;
    setSyncing(true);
    setMessage(null);
    try {
      await api.sync(true);
      setMessage("동기화 완료");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "동기화 실패");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <div className="section-title">BGG 동기화</div>
      <div className="card">
        <button className="btn-primary" disabled={syncing} onClick={doSync}>
          {syncing ? "동기화 중..." : "지금 동기화"}
        </button>
        <p className="muted bga-note">평소엔 서버가 하루 1회 자동으로 동기화합니다.</p>
        {message && <p className="muted bga-note">{message}</p>}
      </div>
    </>
  );
}

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

      <SyncSection />
      <LocationManageSection />
    </div>
  );
}
