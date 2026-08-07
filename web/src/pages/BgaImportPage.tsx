import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useUser } from "../context/UserContext";
import type { BgaImportResult, BgaPlayItem } from "../api/types";
import "../styles/BgaImport.css";

/**
 * 아레나에서 판을 가져오는 화면.
 *
 * 매칭을 고정하지 않는 이유: 두 사람이 아레나 계정을 바꿔 쓴다. 그래서 "brrbrrrr = 항상 ㅇ"이
 * 성립하지 않는다. 지난 선택은 기본값으로 제안만 하고, 가져올 때마다 다시 고르게 한다.
 *
 * 기록이 들어갈 앱 계정은 지금 로그인한 계정이다 - 플레이 기록은 계정별로 따로 쌓기 때문에,
 * 같은 아레나 판을 두 사람이 각자 자기 계정에 넣는 것도 된다(중복 방지 키에 계정이 들어간다).
 */
export default function BgaImportPage() {
  const navigate = useNavigate();
  const { currentUser, users } = useUser();

  const [loggedIn, setLoggedIn] = useState(false);
  const [bgaUsername, setBgaUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [items, setItems] = useState<BgaPlayItem[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  // BGA 이름 -> 앱 계정 id. 이번 가져오기에만 적용된다.
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [remember, setRemember] = useState(true);
  const [results, setResults] = useState<BgaImportResult[] | null>(null);
  // 아레나는 한 번에 10판씩 준다. 판이 쌓이면 다 받을 수 없으니 필요한 만큼만 불러오고,
  // 받아온 것 안에서 연도로 좁힌다.
  const [pages, setPages] = useState(5);
  const [year, setYear] = useState<string>("");

  useEffect(() => {
    api.bgaSession()
      .then((rows) => {
        const mine = rows.find((r) => r.user_id === currentUser?.id);
        setLoggedIn(!!mine?.loggedIn);
        if (mine?.bga_username) setBgaUsername(mine.bga_username);
        // 이미 로그인돼 있으면 화면을 열자마자 목록을 보여준다.
        if (mine?.loggedIn) loadPlays(5);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  async function doLogin() {
    if (!currentUser) return;
    setBusy(true);
    setError(null);
    try {
      await api.bgaLogin(currentUser.id, bgaUsername.trim(), password);
      setPassword(""); // 성공하면 즉시 비운다 - 화면에도 남기지 않는다
      setLoggedIn(true);
      await loadPlays(5); // 바로 보여준다 - 버튼을 한 번 더 누르게 할 이유가 없다
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인 실패");
    } finally {
      setBusy(false);
    }
  }

  async function loadPlays(howMany = pages) {
    if (!currentUser) return;
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const r = await api.bgaPlays(currentUser.id, { pages: howMany });
      setItems(r.items);
      setPages(howMany);
      // BGStats와 같은 규칙: 새 판만 미리 체크하고, 이미 가져왔거나 중복 의심은 꺼둔다.
      setChecked(new Set(r.items.filter((i) => !i.alreadyImported && !i.maybeDuplicate && i.canImport).map((i) => i.tableId)));
      // 이름 매칭 기본값은 지난번 선택(제안)
      const init: Record<string, number | null> = {};
      for (const it of r.items) {
        for (const p of it.players) {
          if (!(p.name in init)) init[p.name] = p.suggestUserId;
        }
      }
      setMapping(init);
    } catch (err) {
      setError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!currentUser || checked.size === 0) return;
    if (!window.confirm(`${checked.size}개를 ${currentUser.name} 계정으로 가져옵니다. 계속할까요?`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.bgaImport({
        user_id: currentUser.id,
        table_ids: [...checked],
        mapping,
        remember,
      });
      setResults(r.results);
      await loadPlays(); // 가져온 것은 "가져온"으로 바뀐다
    } catch (err) {
      setError(err instanceof Error ? err.message : "가져오기 실패");
    } finally {
      setBusy(false);
    }
  }

  const years = useMemo(() => {
    const set = new Set<string>();
    for (const it of items || []) if (it.playedAt) set.add(it.playedAt.slice(0, 4));
    return [...set].sort().reverse();
  }, [items]);

  const shown = useMemo(
    () => (items || []).filter((it) => !year || it.playedAt?.startsWith(year)),
    [items, year]
  );

  // 목록에 나온 모든 BGA 이름 (매칭 지정용)
  const bgaNames = useMemo(() => {
    const set = new Set<string>();
    for (const it of items || []) for (const p of it.players) set.add(p.name);
    return [...set];
  }, [items]);

  function toggle(tableId: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return next;
    });
  }

  function label(it: BgaPlayItem) {
    // 이미 가져온 판이 먼저다 - 그게 체크 여부를 가르는 가장 중요한 정보다.
    if (!it.canImport) return { text: "연결 불가", cls: "bga-tag-warn" };
    if (it.alreadyImported) return { text: "가져온", cls: "bga-tag-done" };
    if (it.maybeDuplicate) return { text: "중복 의심", cls: "bga-tag-warn" };
    if (it.needsFetch) return { text: "새 게임", cls: "bga-tag-new" };
    return { text: "새로운", cls: "bga-tag-new" };
  }

  return (
    <div className="page bga-page">
      <div className="detail-topbar">
        <button className="back-btn" onClick={() => navigate(-1)}>← 뒤로</button>
        <h1>아레나에서 가져오기</h1>
      </div>

      {!loggedIn ? (
        <div className="card">
          <p className="muted bga-hint">
            비밀번호는 로그인에만 쓰이고 저장되지 않습니다.
          </p>
          <div className="field">
            <label>아레나 아이디 (또는 이메일)</label>
            <input value={bgaUsername} onChange={(e) => setBgaUsername(e.target.value)} />
          </div>
          <div className="field">
            <label>비밀번호</label>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") doLogin(); }}
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="btn-primary" disabled={busy || !bgaUsername.trim() || !password} onClick={doLogin}>
            {busy ? "로그인 중..." : "로그인"}
          </button>
        </div>
      ) : (
        <>
          <div className="field-row bga-actions">
            <button className="btn-secondary" disabled={busy} onClick={() => loadPlays(pages)}>
              {busy ? "불러오는 중..." : "새로고침"}
            </button>
            <button className="btn-primary" disabled={busy || checked.size === 0} onClick={doImport}>
              {checked.size}개 가져오기
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}

          {bgaNames.length > 0 && (
            <>
              <div className="section-title">플레이어 연결</div>
              <div className="card">
                <p className="muted bga-hint">
                  이번 가져오기에만 적용됩니다. 계정을 바꿔 쓰셔도 매번 다시 고르시면 됩니다.
                </p>
                {bgaNames.map((n) => (
                  <div key={n} className="bga-map-row">
                    <span className="bga-map-name">{n}</span>
                    <select
                      value={mapping[n] ?? ""}
                      onChange={(e) => setMapping((m) => ({ ...m, [n]: e.target.value ? Number(e.target.value) : null }))}
                    >
                      <option value="">그대로 ({n})</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                ))}
                <label className="switch-label bga-remember">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  다음에도 이 연결을 기본값으로 제안
                </label>
              </div>
            </>
          )}

          {items && (
            <>
              <div className="section-title-row">
                <div className="section-title">게임 목록 ({shown.length})</div>
                <span className="muted bga-count">{checked.size}개 선택됨</span>
              </div>
              {years.length > 1 && (
                <div className="chip-row bga-years">
                  <button className={`chip${year === "" ? " chip-active" : ""}`} onClick={() => setYear("")}>전체</button>
                  {years.map((y) => (
                    <button key={y} className={`chip${year === y ? " chip-active" : ""}`} onClick={() => setYear(y)}>{y}</button>
                  ))}
                </div>
              )}
              <div className="card bga-list">
                {shown.length === 0 && <p className="muted empty-hint">가져올 게임이 없습니다.</p>}
                {shown.map((it) => {
                  const tag = label(it);
                  return (
                    <label key={it.tableId} className="bga-row">
                      <input
                        type="checkbox"
                        checked={checked.has(it.tableId)}
                        disabled={!it.canImport}
                        onChange={() => toggle(it.tableId)}
                      />
                      <span className="bga-row-main">
                        <span className="bga-row-game">{it.gameName}</span>
                        <span className="muted bga-row-players">
                          {it.players.map((p) => (mapping[p.name] ? users.find((u) => u.id === mapping[p.name])?.name : p.name)).join(", ")}
                        </span>
                      </span>
                      <span className="bga-row-right">
                        <span className="muted bga-row-date">{it.playedAt}</span>
                        <span className={`bga-tag ${tag.cls}`}>{tag.text}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {results && (
            <>
              <div className="section-title">가져오기 결과</div>
              <div className="card">
                {results.map((r) => (
                  <div key={r.tableId} className="bga-result-row">
                    <span className={r.ok ? "sync-ok" : "sync-fail"}>{r.ok ? "완료" : "실패"}</span>
                    <span className="muted">{r.ok ? `${r.game} ${r.date}` : r.error}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
