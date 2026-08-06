import { useEffect, useState } from "react";
import { useUser } from "../context/UserContext";
import { api } from "../api/client";
import type { NameAlias, NameCount } from "../api/types";
import "../styles/Settings.css";

// BGA 계정 연동/동기화는 아직 없다. 아이디만 로컬에 저장해두고 나중에 쓸 자리를 마련한다.
const BGA_KEY = "bgg_bga_username";

// 같은 사람/장소가 다른 표기로 기록돼 통계가 갈라지는 걸 사용자가 직접 합칠 수 있게 하는 섹션.
// 원본 데이터는 절대 고치지 않고 name_alias 매핑만 추가/삭제한다. 기본값은 없다 - 뭘 합칠지는 사용자만 안다.
function NameAliasSection() {
  const [kind, setKind] = useState<"player" | "location">("player");
  const [names, setNames] = useState<NameCount[]>([]);
  const [aliases, setAliases] = useState<NameAlias[]>([]);
  const [loading, setLoading] = useState(true);
  const [mergeTarget, setMergeTarget] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [n, a] = await Promise.all([api.names(kind), api.aliases(kind)]);
      setNames(n);
      setAliases(a);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [kind]);

  async function merge(alias: string) {
    const canonical = mergeTarget[alias];
    if (!canonical) return;
    setBusy(alias);
    try {
      await api.addAlias({ kind, alias, canonical });
      setMergeTarget((m) => ({ ...m, [alias]: "" }));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function unmerge(alias: string) {
    const row = aliases.find((a) => a.alias === alias);
    if (!row) return;
    setBusy(alias);
    try {
      await api.deleteAlias(row.id);
      await load();
    } finally {
      setBusy(null);
    }
  }

  const aliasMap = new Map(aliases.map((a) => [a.alias, a.canonical]));

  return (
    <>
      <div className="section-title">이름 정리</div>
      <div className="card">
        <div className="view-toggle alias-kind-toggle">
          <button className={kind === "player" ? "active" : ""} onClick={() => setKind("player")}>플레이어</button>
          <button className={kind === "location" ? "active" : ""} onClick={() => setKind("location")}>장소</button>
        </div>

        {loading && <p className="muted center-pad">불러오는 중...</p>}
        {!loading && names.length === 0 && <p className="muted center-pad">기록된 이름이 없습니다.</p>}

        {!loading && names.map((n) => {
          const canonical = aliasMap.get(n.name);
          return (
            <div key={n.name} className="alias-row">
              <div className="alias-row-main">
                <span>{n.name}</span>
                <span className="muted">{n.count}판</span>
              </div>
              {canonical ? (
                <div className="alias-row-action">
                  <span className="muted">→ {canonical}로 합쳐짐</span>
                  <button className="btn-small" disabled={busy === n.name} onClick={() => unmerge(n.name)}>해제</button>
                </div>
              ) : (
                <div className="alias-row-action">
                  <select
                    value={mergeTarget[n.name] || ""}
                    onChange={(e) => setMergeTarget((m) => ({ ...m, [n.name]: e.target.value }))}
                  >
                    <option value="">다른 이름으로 합치기...</option>
                    {names.filter((x) => x.name !== n.name).map((x) => (
                      <option key={x.name} value={x.name}>{x.name}</option>
                    ))}
                  </select>
                  <button
                    className="btn-small"
                    disabled={!mergeTarget[n.name] || busy === n.name}
                    onClick={() => merge(n.name)}
                  >
                    합치기
                  </button>
                </div>
              )}
            </div>
          );
        })}
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

      <NameAliasSection />
    </div>
  );
}
