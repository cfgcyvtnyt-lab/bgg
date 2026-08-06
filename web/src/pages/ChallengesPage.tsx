import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Challenge, ChallengeTarget, Insights } from "../api/types";
import "../styles/Challenges.css";

type TemplateId = "NxM" | "shelfOfShame" | "newGames" | "totalPlays" | "hIndex";

const TEMPLATES: { id: TemplateId; title: string; desc: string }[] = [
  { id: "NxM", title: "N개 게임 M회씩", desc: "고른 게임들을 각각 M번씩 플레이" },
  { id: "shelfOfShame", title: "안 해본 보유 게임 정복", desc: "아직 한 번도 안 한 보유 게임을 전부 플레이" },
  { id: "newGames", title: "새 게임 N개 배우기", desc: "기간 안에 처음 플레이한 게임 수" },
  { id: "totalPlays", title: "기간 안에 N판", desc: "기간 안에 총 플레이 수 채우기" },
  { id: "hIndex", title: "H-index N 달성", desc: "N판 이상 플레이한 게임이 N개 이상" },
];

function currentYearRange() {
  const y = new Date().getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

function fmtPercent(p: number) {
  return `${Math.min(100, Math.round(p))}%`;
}

function ProgressBar({ percent }: { percent: number }) {
  const done = percent >= 100;
  return (
    <div className="challenge-progress-track">
      <div
        className="challenge-progress-fill"
        style={{ width: `${Math.min(100, percent)}%`, background: done ? "var(--record)" : "var(--c2)" }}
      />
    </div>
  );
}

function periodLabel(target: ChallengeTarget) {
  if ("from" in target && target.from) {
    return `${target.from} ~ ${target.to || ""}`;
  }
  return null;
}

// ---------- 목록 카드 (펼치면 상세) ----------
function ChallengeCard({ challenge, onDelete }: { challenge: Challenge; onDelete: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const p = challenge.progress;
  if (!p) return null;

  const percent = p.percent;
  const period = periodLabel(challenge.target);

  return (
    <div className="card challenge-card">
      <div className="challenge-card-head" onClick={() => setOpen((v) => !v)}>
        <div className="challenge-card-title">
          <span>{challenge.name}</span>
          {percent >= 100 && <span className="challenge-done-badge">달성</span>}
        </div>
        <div className="challenge-card-percent">{fmtPercent(percent)}</div>
      </div>
      <ProgressBar percent={percent} />
      {period && <div className="muted challenge-period">{period}</div>}

      {open && (
        <div className="challenge-detail">
          {p.type === "NxM" && (
            <div className="challenge-detail-list">
              {p.games.map((g) => (
                <div key={g.gameId} className="challenge-detail-row">
                  <Link to={`/game/${g.gameId}`} className="challenge-detail-name">{g.name || `#${g.gameId}`}</Link>
                  <span className={g.plays >= g.target ? "challenge-detail-value done" : "challenge-detail-value"}>
                    {g.plays} / {g.target}
                  </span>
                </div>
              ))}
              <div className="muted challenge-detail-summary">
                {p.completedGames} / {p.totalGames}개 게임 완료
              </div>
            </div>
          )}

          {p.type === "shelfOfShame" && (
            <div className="challenge-detail-list">
              {p.games.map((g) => (
                <div key={g.gameId} className="challenge-detail-row">
                  <Link to={`/game/${g.gameId}`} className="challenge-detail-name">{g.name || `#${g.gameId}`}</Link>
                  <span className={g.done ? "challenge-detail-value done" : "challenge-detail-value"}>
                    {g.done ? `완료 (${g.plays}판)` : "미완료"}
                  </span>
                </div>
              ))}
              <div className="muted challenge-detail-summary">
                {p.doneCount} / {p.totalGames}개 완료
              </div>
            </div>
          )}

          {(p.type === "totalPlays" || p.type === "newGames" || p.type === "hIndex") && (
            <div className="muted challenge-detail-summary">
              현재 {p.current} / 목표 {p.target}
            </div>
          )}

          <button className="btn-small challenge-delete-btn" onClick={() => onDelete(challenge.id)}>삭제</button>
        </div>
      )}
    </div>
  );
}

// ---------- 새 도전 만들기 ----------
function TemplateForm({
  templateId, insights, onCreated, onCancel,
}: {
  templateId: TemplateId;
  insights: Insights | null;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const yearRange = currentYearRange();
  const [name, setName] = useState("");
  const [n, setN] = useState(10);
  const [m, setM] = useState(10);
  const [target, setTarget] = useState(templateId === "hIndex" ? 18 : templateId === "newGames" ? 10 : 365);
  const [from, setFrom] = useState(yearRange.from);
  const [to, setTo] = useState(yearRange.to);
  const [selectedGameIds, setSelectedGameIds] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const topGames = useMemo(() => insights?.topGames.slice(0, 30) || [], [insights]);
  const ownedNotPlayed = insights?.ownedNotPlayed || [];

  // NxM: 상위 N개 게임을 기본으로 자동 체크. n이 바뀌면 다시 채운다.
  useEffect(() => {
    if (templateId !== "NxM") return;
    setSelectedGameIds(new Set(topGames.slice(0, n).map((g) => g.game_id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, n, topGames.length]);

  useEffect(() => {
    const defaults: Record<TemplateId, string> = {
      NxM: `${n}개 게임 ${m}회씩`,
      shelfOfShame: "안 해본 보유 게임 정복",
      newGames: `새 게임 ${target}개 배우기`,
      totalPlays: `${from.slice(0, 4)}년에 ${target}판`,
      hIndex: `H-index ${target} 달성`,
    };
    setName(defaults[templateId]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, n, m, target, from]);

  function toggleGame(gameId: number) {
    setSelectedGameIds((prev) => {
      const next = new Set(prev);
      if (next.has(gameId)) next.delete(gameId);
      else next.add(gameId);
      return next;
    });
  }

  async function submit() {
    setError(null);
    let body: { name: string; target: ChallengeTarget };

    if (templateId === "NxM") {
      const gameIds = [...selectedGameIds];
      if (gameIds.length === 0) { setError("게임을 하나 이상 선택하세요"); return; }
      body = { name, target: { type: "NxM", n, m, gameIds } };
    } else if (templateId === "shelfOfShame") {
      const gameIds = ownedNotPlayed.map((g) => g.id);
      if (gameIds.length === 0) { setError("안 해본 보유 게임이 없습니다"); return; }
      body = { name, target: { type: "shelfOfShame", gameIds } };
    } else if (templateId === "newGames") {
      body = { name, target: { type: "newGames", target, from, to } };
    } else if (templateId === "totalPlays") {
      body = { name, target: { type: "totalPlays", target, from, to } };
    } else {
      body = { name, target: { type: "hIndex", target } };
    }

    setBusy(true);
    try {
      await api.addChallenge(body);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "생성 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="challenge-form">
      <div className="field">
        <label>이름</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      {templateId === "NxM" && (
        <>
          <div className="field-row">
            <div className="field">
              <label>게임 수 (N)</label>
              <input type="number" min={1} value={n} onChange={(e) => setN(Number(e.target.value) || 1)} />
            </div>
            <div className="field">
              <label>목표 판수 (M)</label>
              <input type="number" min={1} value={m} onChange={(e) => setM(Number(e.target.value) || 1)} />
            </div>
          </div>
          <div className="field">
            <label>게임 선택 (최근 많이 한 순으로 자동 체크됨 - 직접 조정 가능)</label>
            <div className="challenge-game-picker">
              {topGames.length === 0 && <p className="muted">플레이 기록이 없습니다.</p>}
              {topGames.map((g) => (
                <label key={g.game_id} className="challenge-game-picker-row">
                  <input
                    type="checkbox"
                    checked={selectedGameIds.has(g.game_id)}
                    onChange={() => toggleGame(g.game_id)}
                  />
                  <span>{g.game_name}</span>
                  <span className="muted">{g.count}판</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      {templateId === "shelfOfShame" && (
        <div className="field">
          <label>대상 게임 ({ownedNotPlayed.length}개, 자동 채움)</label>
          <div className="challenge-game-picker readonly">
            {ownedNotPlayed.length === 0 && <p className="muted">안 해본 보유 게임이 없습니다.</p>}
            {ownedNotPlayed.map((g) => (
              <div key={g.id} className="challenge-game-picker-row">
                <span>{g.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {templateId === "newGames" && (
        <>
          <div className="field">
            <label>목표 게임 수</label>
            <input type="number" min={1} value={target} onChange={(e) => setTarget(Number(e.target.value) || 1)} />
          </div>
          <div className="field-row">
            <div className="field"><label>시작일</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="field"><label>종료일</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
        </>
      )}

      {templateId === "totalPlays" && (
        <>
          <div className="field">
            <label>목표 판수</label>
            <input type="number" min={1} value={target} onChange={(e) => setTarget(Number(e.target.value) || 1)} />
          </div>
          <div className="field-row">
            <div className="field"><label>시작일</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="field"><label>종료일</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
        </>
      )}

      {templateId === "hIndex" && (
        <div className="field">
          <label>목표 H-index</label>
          <input type="number" min={1} value={target} onChange={(e) => setTarget(Number(e.target.value) || 1)} />
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="challenge-form-actions">
        <button className="btn-secondary" onClick={onCancel} disabled={busy}>취소</button>
        <button className="btn-primary" onClick={submit} disabled={busy}>만들기</button>
      </div>
    </div>
  );
}

export default function ChallengesPage() {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "templates" | "form">("list");
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [c, i] = await Promise.all([api.challenges(), api.insights()]);
      setChallenges(c);
      setInsights(i);
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: number) {
    if (!window.confirm("이 도전 과제를 삭제할까요?")) return;
    await api.deleteChallenge(id);
    await load();
  }

  function backToList() {
    setView("list");
    setSelectedTemplate(null);
  }

  return (
    <div className="page challenges-page">
      <div className="page-header">
        <h1>도전 과제</h1>
        {view === "list" && (
          <button className="icon-btn" onClick={() => setView("templates")}>+</button>
        )}
      </div>

      {loading && <p className="muted center-pad">불러오는 중...</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && view === "list" && (
        <>
          {challenges.length === 0 && (
            <p className="muted center-pad">아직 도전 과제가 없습니다. + 버튼으로 만들어보세요.</p>
          )}
          {challenges.map((c) => (
            <ChallengeCard key={c.id} challenge={c} onDelete={handleDelete} />
          ))}
        </>
      )}

      {view === "templates" && (
        <div className="challenge-template-list">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              className="card challenge-template-card"
              onClick={() => { setSelectedTemplate(t.id); setView("form"); }}
            >
              <div className="challenge-template-title">{t.title}</div>
              <div className="muted challenge-template-desc">{t.desc}</div>
            </button>
          ))}
          <button className="btn-secondary" onClick={backToList}>취소</button>
        </div>
      )}

      {view === "form" && selectedTemplate && (
        <TemplateForm
          templateId={selectedTemplate}
          insights={insights}
          onCreated={async () => { await load(); backToList(); }}
          onCancel={backToList}
        />
      )}
    </div>
  );
}
