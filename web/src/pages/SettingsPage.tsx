import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useUser } from "../context/UserContext";
import { api } from "../api/client";
import type { LocationCount, User } from "../api/types";
import "../styles/Settings.css";

// BGA 계정 연동/동기화는 아직 없다. 아이디만 로컬에 저장해두고 나중에 쓸 자리를 마련한다.
const BGA_KEY = "bgg_bga_username";
// 서버가 실제로 쓴 적 있는 장소만 내려주므로, 아직 기록에 안 쓰인 "새 장소 이름"은
// 여기 로컬에 따로 보관해서 목록에 같이 보여준다. 실제 play.location에는 기록 시점에 반영된다.
const EXTRA_LOCATIONS_KEY = "bgg_extra_locations";

function loadExtraLocations(): string[] {
  try {
    const raw = localStorage.getItem(EXTRA_LOCATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// BGG는 하루 1회 동기화를 권장한다(서버가 429로 강제한다). 그래서 버튼을 누르면
// "정말 지금 할 거냐"를 확인한 뒤 force=1로 그 제한을 우회한다.
function SyncButton() {
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
    <div className="account-subsection">
      <div className="account-subsection-label">BGG 동기화</div>
      <button className="btn-primary" disabled={syncing} onClick={doSync}>
        {syncing ? "동기화 중..." : "지금 동기화"}
      </button>
      <p className="muted bga-note">평소엔 서버가 하루 1회 자동으로 동기화합니다.</p>
      {message && <p className="muted bga-note">{message}</p>}
    </div>
  );
}

// 계정 섹션: 사용자 전환, 프로필 사진, BGA 아이디, BGG 동기화, 대표 장소를 한 곳에 모은다.
function AccountSection({ locations }: { locations: LocationCount[] }) {
  const { users, currentUser, setCurrentUser } = useUser();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [bgaUsername, setBgaUsername] = useState(() => localStorage.getItem(BGA_KEY) || "");
  const [saved, setSaved] = useState(false);
  const [locBusy, setLocBusy] = useState(false);

  function saveBga() {
    localStorage.setItem(BGA_KEY, bgaUsername.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function onAvatarPicked(files: FileList | null) {
    const file = files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file || !currentUser) return;
    setUploadError(null);
    setUploading(true);
    try {
      const updated = await api.uploadAvatar(currentUser.id, file);
      setCurrentUser({ ...currentUser, ...updated } as User);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "업로드 실패");
    } finally {
      setUploading(false);
    }
  }

  async function onDefaultLocationChange(value: string) {
    if (!currentUser) return;
    setLocBusy(true);
    try {
      const updated = await api.updateUser(currentUser.id, { default_location: value || null });
      setCurrentUser({ ...currentUser, ...updated } as User);
    } finally {
      setLocBusy(false);
    }
  }

  return (
    <>
      <div className="section-title">계정</div>
      <div className="card">
        <div className="account-subsection">
          <div className="account-subsection-label">사용자</div>
          <div className="user-switch">
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
        </div>

        <div className="account-subsection">
          <div className="account-subsection-label">프로필 사진</div>
          <div className="avatar-row">
            <div className="avatar-preview">
              {currentUser?.avatar
                ? <img src={api.avatarUrl(currentUser.avatar)} alt={currentUser.name} />
                : <span className="avatar-placeholder muted">{currentUser?.name?.[0] ?? "?"}</span>}
            </div>
            <button
              className="btn-secondary"
              disabled={!currentUser || uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "업로드 중..." : "사진 선택"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="avatar-file-input"
              onChange={(e) => onAvatarPicked(e.target.files)}
            />
          </div>
          {uploadError && <p className="error-text">{uploadError}</p>}
        </div>

        <div className="account-subsection">
          <div className="account-subsection-label">BGA 아이디</div>
          <div className="field">
            <input
              value={bgaUsername}
              onChange={(e) => setBgaUsername(e.target.value)}
              placeholder="Board Game Arena 아이디"
            />
          </div>
          <button className="btn-secondary" onClick={saveBga}>저장{saved ? "됨" : ""}</button>
          <p className="muted bga-note">동기화 기능은 아직 준비 중입니다. 아이디만 저장됩니다.</p>
        </div>

        <div className="account-subsection">
          <div className="account-subsection-label">대표 장소</div>
          <select
            value={currentUser?.default_location || ""}
            disabled={!currentUser || locBusy}
            onChange={(e) => onDefaultLocationChange(e.target.value)}
          >
            <option value="">(없음)</option>
            {locations.map((l) => (
              <option key={l.name} value={l.name}>{l.name}</option>
            ))}
          </select>
        </div>

        <SyncButton />
      </div>
    </>
  );
}

// 장소 표기를 직접 바꾸는 섹션. name_alias(조회 시점 병합)와 달리 play.location 원본 값을
// UPDATE로 실제 고친다 - 예전 "이름 정리"보다 더 강한 조작이라 확인 다이얼로그를 반드시 거친다.
function LocationManageSection({ locations, onChanged }: { locations: LocationCount[]; onChanged: () => void }) {
  const [extra, setExtra] = useState<string[]>(() => loadExtraLocations());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addValue, setAddValue] = useState("");
  const [busy, setBusy] = useState(false);

  const names = [...locations.map((l) => l.name), ...extra.filter((e) => !locations.some((l) => l.name === e))];

  function startRename(name: string) {
    setRenaming(name);
    setNewName(name);
  }

  async function confirmRename(from: string) {
    const to = newName.trim();
    if (!to || to === from) { setRenaming(null); return; }
    if (!window.confirm(`"${from}" → "${to}"로 이름을 바꿀까요?`)) return;
    setBusy(true);
    try {
      // 서버에 실제 기록이 있는 장소만 play.location을 고칠 수 있다. 아직 미사용(extra) 장소는
      // 로컬 목록만 바꾼다.
      if (locations.some((l) => l.name === from)) {
        await api.renameLocation(from, to);
        onChanged();
      }
      if (extra.includes(from)) {
        const next = extra.map((e) => (e === from ? to : e));
        setExtra(next);
        localStorage.setItem(EXTRA_LOCATIONS_KEY, JSON.stringify(next));
      }
      setRenaming(null);
    } finally {
      setBusy(false);
    }
  }

  function submitAdd() {
    const name = addValue.trim();
    if (!name || names.includes(name)) { setAdding(false); setAddValue(""); return; }
    const next = [...extra, name];
    setExtra(next);
    localStorage.setItem(EXTRA_LOCATIONS_KEY, JSON.stringify(next));
    setAdding(false);
    setAddValue("");
  }

  return (
    <>
      <div className="section-title">장소 관리</div>
      <div className="card">
        {names.length === 0 && <p className="muted center-pad">기록된 장소가 없습니다.</p>}

        {names.map((name) => (
          <div key={name} className="alias-row">
            <div className="alias-row-main">
              <span>{name}</span>
            </div>
            {renaming === name ? (
              <div className="alias-row-action">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
                <button className="btn-small" disabled={busy} onClick={() => confirmRename(name)}>확인</button>
                <button className="btn-small" disabled={busy} onClick={() => setRenaming(null)}>취소</button>
              </div>
            ) : (
              <div className="alias-row-action">
                <button className="btn-small" onClick={() => startRename(name)}>편집</button>
              </div>
            )}
          </div>
        ))}

        {adding ? (
          <div className="alias-row-action add-location-row">
            <input
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              placeholder="새 장소 이름"
              autoFocus
            />
            <button className="btn-small" onClick={submitAdd}>추가</button>
            <button className="btn-small" onClick={() => { setAdding(false); setAddValue(""); }}>취소</button>
          </div>
        ) : (
          <button className="btn-secondary add-location-btn" onClick={() => setAdding(true)}>장소 추가</button>
        )}
      </div>
    </>
  );
}

export default function SettingsPage() {
  const [locations, setLocations] = useState<LocationCount[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadLocations() {
    setLoading(true);
    try {
      setLocations(await api.locations());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadLocations(); }, []);

  return (
    <div className="page settings-page">
      <div className="page-header"><h1>설정</h1></div>

      <AccountSection locations={locations} />

      <div className="section-title">슬리브 재고</div>
      <div className="card">
        <Link to="/sleeves" className="btn-secondary sleeve-link-btn">슬리브 재고 관리 열기</Link>
      </div>

      {loading ? (
        <>
          <div className="section-title">장소 관리</div>
          <div className="card"><p className="muted center-pad">불러오는 중...</p></div>
        </>
      ) : (
        <LocationManageSection locations={locations} onChanged={loadLocations} />
      )}
    </div>
  );
}
