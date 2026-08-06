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

// BGG/BGA 로그인 카드. 실제 연동은 아직 구현하지 않으므로 "연동" 버튼은 안내만 띄운다.
// 비밀번호는 화면 상태로만 잠깐 들고 있다가 그대로 버려지고, 서버로 전송되지도 저장되지도 않는다.
function LoginCard({
  title, usernamePlaceholder, username, onUsernameChange, onUsernameSaved, extra,
}: {
  title: string;
  usernamePlaceholder: string;
  username: string;
  onUsernameChange: (v: string) => void;
  onUsernameSaved?: () => void;
  extra?: React.ReactNode;
}) {
  // 비밀번호는 로컬 상태에만 존재 - 저장도 전송도 하지 않고 "연동" 클릭 시 그대로 비운다.
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState(false);

  function connect() {
    setPassword(""); // 서버로 보내지 않는다 - 그냥 비운다
    setNotice(true);
    if (onUsernameSaved) onUsernameSaved();
  }

  return (
    <>
      <div className="section-title">{title}</div>
      <div className="card login-card">
        <div className="field">
          <label>아이디</label>
          <input
            value={username}
            onChange={(e) => onUsernameChange(e.target.value)}
            placeholder={usernamePlaceholder}
          />
        </div>
        <div className="field">
          <label>비밀번호</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="비밀번호"
            autoComplete="new-password"
          />
        </div>
        <button className="btn-primary" onClick={connect}>연동</button>
        {notice && <p className="muted bga-note">아직 준비 중입니다. 아이디만 저장되며 비밀번호는 저장되지 않습니다.</p>}
        {extra}
      </div>
    </>
  );
}

// 계정 섹션: 사용자 전환(접힘), 프로필 사진, BGG/BGA 로그인 카드, 대표 장소를 모은다.
function AccountSection({ locations }: { locations: LocationCount[] }) {
  const { users, currentUser, setCurrentUser } = useUser();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [bgaUsername, setBgaUsername] = useState(() => localStorage.getItem(BGA_KEY) || "");
  const [bggUsername, setBggUsername] = useState(() => currentUser?.bgg_username || "");
  const [locBusy, setLocBusy] = useState(false);
  // 사용자 전환은 한 번 정하면 거의 안 바꾸는 값이라 기본은 접어둔다.
  const [switchOpen, setSwitchOpen] = useState(false);

  // 프로필은 원형 34~36px로 쓰이는데, 원본이 정사각이 아니면 잘려서 어색하고
  // 폰 사진처럼 수 MB짜리를 그대로 두면 낭비다. 업로드 전에 가운데를 정사각으로 잘라
  // 256px(고배율 화면에서도 선명한 크기)로 맞춰 보낸다.
  async function squareResize(file: File): Promise<File> {
    const SIZE = 256;
    try {
      const bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      const sx = (bitmap.width - side) / 2;
      const sy = (bitmap.height - side) / 2;

      const canvas = document.createElement("canvas");
      canvas.width = SIZE;
      canvas.height = SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, SIZE, SIZE);
      bitmap.close();

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.92)
      );
      if (!blob) return file;
      return new File([blob], "avatar.jpg", { type: "image/jpeg" });
    } catch {
      // 캔버스 처리에 실패하면 원본을 그대로 올린다
      return file;
    }
  }

  async function onAvatarPicked(files: FileList | null) {
    const file = files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file || !currentUser) return;
    setUploadError(null);
    setUploading(true);
    try {
      const updated = await api.uploadAvatar(currentUser.id, await squareResize(file));
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
          <div className="account-user-row">
            <div className="avatar-preview avatar-preview-sm">
              {currentUser?.avatar
                ? <img src={api.avatarUrl(currentUser.avatar)} alt={currentUser.name} />
                : <span className="avatar-placeholder muted">{currentUser?.name?.[0] ?? "?"}</span>}
            </div>
            <span className="account-user-name">{currentUser?.name ?? "-"}</span>
            <button className="btn-small" onClick={() => setSwitchOpen((v) => !v)}>
              {switchOpen ? "닫기" : "전환"}
            </button>
          </div>

          {switchOpen && (
            <div className="user-switch-panel">
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

              <div className="avatar-row">
                <button
                  className="btn-secondary"
                  disabled={!currentUser || uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? "업로드 중..." : "프로필 사진 선택"}
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
          )}
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
      </div>

      <LoginCard
        title="BGG 계정 연동"
        usernamePlaceholder="BGG 아이디"
        username={bggUsername}
        onUsernameChange={setBggUsername}
        extra={<SyncButton />}
      />

      <LoginCard
        title="BGA 계정 연동"
        usernamePlaceholder="Board Game Arena 아이디"
        username={bgaUsername}
        onUsernameChange={setBgaUsername}
        onUsernameSaved={() => localStorage.setItem(BGA_KEY, bgaUsername.trim())}
      />
    </>
  );
}

// 장소 표기를 직접 바꾸는 섹션. name_alias(조회 시점 병합)와 달리 play.location 원본 값을
// UPDATE로 실제 고친다 - 예전 "이름 정리"보다 더 강한 조작이라 확인 다이얼로그를 반드시 거친다.
function LocationManageSection({ locations, onChanged }: { locations: LocationCount[]; onChanged: () => void }) {
  const [extra, setExtra] = useState<string[]>(() => loadExtraLocations());
  const [editMode, setEditMode] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [addValue, setAddValue] = useState("");
  const [busy, setBusy] = useState(false);

  const names = [...locations.map((l) => l.name), ...extra.filter((e) => !locations.some((l) => l.name === e))];

  function toggleEdit() {
    if (editMode) {
      setEditMode(false);
      setAdding(false);
      setAddValue("");
    } else {
      setValues(Object.fromEntries(names.map((n) => [n, n])));
      setEditMode(true);
    }
  }

  async function confirmRename(from: string) {
    const to = (values[from] ?? from).trim();
    if (!to || to === from) return;
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
      setValues((v) => ({ ...v, [to]: to }));
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
    setValues((v) => ({ ...v, [name]: name }));
    setAdding(false);
    setAddValue("");
  }

  return (
    <>
      <div className="section-title-row">
        <div className="section-title">장소 관리</div>
        <button className="btn-small" onClick={toggleEdit}>{editMode ? "완료" : "편집"}</button>
      </div>
      <div className="card">
        {names.length === 0 && <p className="muted center-pad">기록된 장소가 없습니다.</p>}

        {names.map((name) => (
          <div key={name} className="alias-row">
            {editMode ? (
              <div className="alias-row-action">
                <input
                  value={values[name] ?? name}
                  onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                />
                <button
                  className="btn-small"
                  disabled={busy || (values[name] ?? name).trim() === name}
                  onClick={() => confirmRename(name)}
                >
                  저장
                </button>
              </div>
            ) : (
              <div className="alias-row-main">
                <span>{name}</span>
              </div>
            )}
          </div>
        ))}

        {editMode && (
          adding ? (
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
          )
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
