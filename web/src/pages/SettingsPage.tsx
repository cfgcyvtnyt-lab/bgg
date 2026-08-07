import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useUser } from "../context/UserContext";
import { api } from "../api/client";
import type { CleanupResult, LocationCount, User } from "../api/types";
import "../styles/Settings.css";

// 계정 섹션: 사용자 전환(접힘)과 프로필 사진.
function AccountSection() {
  const { users, currentUser, setCurrentUser } = useUser();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
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

  return (
    <>
      <div className="section-title">계정</div>
      <div className="card">
        <div className="account-subsection">
          <div className="account-user-row">
            <div className="avatar-preview avatar-preview-sm">
              {currentUser?.avatar
                ? <img decoding="async" src={api.avatarUrl(currentUser.avatar)} alt={currentUser.name} />
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

      </div>

      <div className="section-title">아레나 연동</div>
      <div className="card">
        <Link to="/bga" className="btn-primary bga-import-link">아레나에서 가져오기</Link>
      </div>
    </>
  );
}

// 정리 결과는 MB로만 보여준다 - 몇 KB 단위까지 알 필요가 없다.
function fmtMB(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// 장소 관리. 평소엔 이름만 보여주고, 편집을 눌렀을 때만 고치기·대표 지정·삭제·추가가 나온다.
// 기록 화면 드롭다운은 고르기만 한다 - 판을 적는 중에 할 일이 아니고,
// 잘못 눌러 기록 전체의 장소가 바뀌면 곤란하기 때문이다.
//
// 장소는 계정별로 따로다(ㅇ은 Home/BGA, ㅃ는 B.). 목록은 서버가 내 play.location을 집계해 주고,
// 아직 한 판도 안 한 장소와 "온라인" 표시는 서버의 location_pref에 저장된다.
function LocationSection() {
  const { currentUser, setCurrentUser } = useUser();
  const [locations, setLocations] = useState<LocationCount[]>([]);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    return api.locations().then(setLocations).catch(() => setLocations([]));
  }
  useEffect(() => { load(); }, [currentUser]);

  function toggleEdit() {
    if (!editing) setEdits(Object.fromEntries(locations.map((l) => [l.name, l.name])));
    setEditing((v) => !v);
    setAdding("");
    setError(null);
  }

  async function run(fn: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  // 저장 버튼 없이 Enter나 포커스 이탈로 적용한다. 기록 전체가 바뀌는 일이라 확인은 받고,
  // 취소하면 입력을 원래 이름으로 되돌린다.
  async function rename(from: string) {
    const to = (edits[from] ?? from).trim();
    if (!to || to === from) return;
    if (!window.confirm(`"${from}" → "${to}"로 바꿉니다. 이 장소로 기록된 내 플레이 전부에 적용됩니다.`)) {
      setEdits((v) => ({ ...v, [from]: from }));
      return;
    }
    await run(async () => {
      await api.renameLocation(from, to);
      if (currentUser?.default_location === from) {
        const updated = await api.updateUser(currentUser.id, { default_location: to });
        setCurrentUser({ ...currentUser, ...updated } as User);
      }
      setEdits((v) => ({ ...v, [to]: to }));
    }, "이름 변경 실패");
  }

  // 기록이 있는 장소를 지우면 그 판들은 장소 없는 기록이 된다(플레이 자체는 남는다).
  function remove(l: LocationCount) {
    const msg = l.count > 0
      ? `"${l.name}"을(를) 지울까요? 기록 ${l.count}건의 장소 표시도 함께 지워집니다.`
      : `"${l.name}"을(를) 목록에서 지울까요?`;
    if (!window.confirm(msg)) return;
    run(async () => {
      await api.deleteLocation(l.name);
      if (currentUser?.default_location === l.name) {
        const updated = await api.updateUser(currentUser.id, { default_location: null });
        setCurrentUser({ ...currentUser, ...updated } as User);
      }
    }, "삭제 실패");
  }

  function setDefault(name: string) {
    if (!currentUser || currentUser.default_location === name) return;
    run(async () => {
      const updated = await api.updateUser(currentUser.id, { default_location: name });
      setCurrentUser({ ...currentUser, ...updated } as User);
    }, "대표 장소 지정 실패");
  }

  function add() {
    const name = adding.trim();
    setAdding("");
    if (!name || locations.some((l) => l.name === name)) return;
    run(async () => {
      await api.saveLocation(name);
      setEdits((v) => ({ ...v, [name]: name }));
    }, "장소 추가 실패");
  }

  return (
    <>
      <div className="section-title-row">
        <div className="section-title">장소</div>
        <button className="btn-small" onClick={toggleEdit}>{editing ? "완료" : "편집"}</button>
      </div>
      <div className="card">
        {error && <p className="error-text">{error}</p>}
        {locations.length === 0 && <p className="muted empty-hint">기록된 장소가 없습니다.</p>}

        {locations.map((l) => (
          <div key={l.name} className="loc-item">
            <div className="loc-row">
              {editing ? (
                <>
                  <input
                    className="loc-name-input"
                    value={edits[l.name] ?? l.name}
                    disabled={busy}
                    onChange={(e) => setEdits((v) => ({ ...v, [l.name]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    // 삭제를 누르느라 포커스가 빠진 거면 이름부터 바꾸겠냐고 묻지 않는다 -
                    // 지울 장소의 이름을 확인받는 건 의미가 없고 창만 두 번 뜬다.
                    onBlur={(e) => {
                      if ((e.relatedTarget as HTMLElement | null)?.classList.contains("loc-del-btn")) {
                        setEdits((v) => ({ ...v, [l.name]: l.name }));
                        return;
                      }
                      rename(l.name);
                    }}
                  />
                  {/* 대표는 읽기 모드의 배지와 같은 모양을 그대로 버튼으로 쓴다 - 켜져 있는 쪽이 현재 대표 */}
                  <button
                    className={`loc-default-toggle${currentUser?.default_location === l.name ? " active" : ""}`}
                    disabled={busy}
                    onClick={() => setDefault(l.name)}
                  >
                    대표
                  </button>
                  <button className="loc-del-btn" disabled={busy} onClick={() => remove(l)} aria-label="장소 삭제">✕</button>
                </>
              ) : (
                <>
                  <span className="loc-name">{l.name}</span>
                  {l.online && <span className="muted loc-online-tag">온라인</span>}
                  {currentUser?.default_location === l.name && (
                    <span className="default-location-badge muted">대표</span>
                  )}
                </>
              )}
            </div>
            {/* 온라인에서 한 판은 실물 제품으로 논 게 아니라서 판당 비용 계산에서 뺀다.
                기본값은 BGA·TTS·App이 켜짐. */}
            {editing && (
              <label className="switch-label loc-online">
                <input
                  type="checkbox"
                  checked={!!l.online}
                  disabled={busy}
                  onChange={(e) => run(() => api.saveLocation(l.name, { online: e.target.checked }), "설정 저장 실패")}
                />
                온라인
              </label>
            )}
          </div>
        ))}

        {editing && (
          <div className="loc-row loc-add-row">
            <input
              className="loc-name-input"
              placeholder="새 장소 이름"
              value={adding}
              disabled={busy}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            />
            {/* 삭제(✕)와 같은 아이콘 버튼 규칙. 앱 전체가 추가는 ＋, 제거는 ✕로 통일돼 있다 */}
            <button className="loc-del-btn" disabled={busy || !adding.trim()} onClick={add} aria-label="장소 추가">＋</button>
          </div>
        )}
      </div>
    </>
  );
}

// 저장 공간 정리. NAS 도커에 올려두고 몇 달씩 안 들여다볼 걸 전제로 서버가 주 1회 자동으로
// 돌지만, 지금 얼마나 쌓였는지 보고 직접 돌릴 수 있어야 한다.
//
// 지우는 건 캐시와 고아 파일뿐이다 - 기록·컬렉션·평점은 건드리지 않는다.
// 긱 이미지는 지워도 다음에 볼 때 다시 받으므로 잃는 게 없다.
function StorageSection() {
  const [status, setStatus] = useState<CleanupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.cleanupStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  async function run() {
    if (!window.confirm("캐시와 고아 파일을 정리합니다. 기록과 컬렉션은 그대로입니다.")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.cleanup();
      setDone(r);
      setStatus(await api.cleanupStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "정리 실패");
    } finally {
      setBusy(false);
    }
  }

  const pending = status?.freedBytes ?? 0;

  return (
    <>
      <div className="section-title-row">
        <div className="section-title">저장 공간</div>
        <button className="btn-small" disabled={busy} onClick={run}>{busy ? "정리 중..." : "정리"}</button>
      </div>
      <div className="card">
        {error && <p className="error-text">{error}</p>}
        {done && (
          <p className="muted storage-line">
            {fmtMB(done.freedBytes)} 정리했습니다 (이미지 {done.images.removed}개).
          </p>
        )}
        {status ? (
          pending > 0 ? (
            <p className="muted storage-line">
              지울 수 있는 것 <b>{fmtMB(pending)}</b> · 안 쓰는 긱 이미지 {status.images.removed}개
            </p>
          ) : (
            <p className="muted storage-line">정리할 게 없습니다.</p>
          )
        ) : (
          <p className="muted storage-line">확인 중...</p>
        )}
      </div>
    </>
  );
}

export default function SettingsPage() {
  // 슬리브 재고는 컬렉션 화면에 있다 - 게임 소유 정보에 딸린 것이지 앱 설정이 아니다.
  return (
    <div className="page settings-page">
      <div className="page-header"><h1>설정</h1></div>
      <AccountSection />
      <LocationSection />
      <StorageSection />
    </div>
  );
}
