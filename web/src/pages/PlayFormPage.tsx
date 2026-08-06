import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { Game, GameDetail, PlayPlayer } from "../api/types";
import { evalScoreExpression } from "../utils/scoreParser";
import PlayTimer from "../components/PlayTimer";
import "../styles/PlayForm.css";

interface PlayerRow {
  name: string;
  scoreText: string;
  win: boolean;
  isAutoma: boolean;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function emptyPlayer(): PlayerRow {
  return { name: "", scoreText: "", win: false, isAutoma: false };
}

function fmtNum(n: number | null | undefined) {
  if (n == null) return "-";
  return Math.round(n).toLocaleString();
}

export default function PlayFormPage() {
  const { id } = useParams();
  const isEdit = !!id;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [gameQuery, setGameQuery] = useState("");
  const [gameResults, setGameResults] = useState<Game[]>([]);
  const [selectedGame, setSelectedGame] = useState<{ id: number; name: string } | null>(null);
  const [gameDetail, setGameDetail] = useState<GameDetail | null>(null);
  const [playedAt, setPlayedAt] = useState(todayStr());

  // 장소는 드롭다운/칩으로만 고른다 - 자유 입력을 허용하면 Home/Home2/H. 처럼 표기가 갈린다.
  const [locations, setLocations] = useState<{ name: string; count: number }[]>([]);
  const [location, setLocation] = useState("");
  const [addingLocation, setAddingLocation] = useState(false);
  const [newLocationText, setNewLocationText] = useState("");

  const [comment, setComment] = useState("");
  const [isCoop, setIsCoop] = useState(false);
  const [coopSuccess, setCoopSuccess] = useState(true);
  const [players, setPlayers] = useState<PlayerRow[]>([emptyPlayer(), emptyPlayer()]);
  const [startPlayerIndex, setStartPlayerIndex] = useState<number | null>(null);
  const [durationMin, setDurationMin] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);

  useEffect(() => {
    api.locations().then(setLocations).catch(() => setLocations([]));
  }, []);

  // 수정 모드: 단건 조회 엔드포인트로 바로 가져온다.
  useEffect(() => {
    if (!isEdit) return;
    const targetId = Number(id);
    (async () => {
      setLoading(true);
      try {
        const found = await api.play(targetId);
        setSelectedGame({ id: found.game_id, name: found.game_name || "" });
        setPlayedAt(found.played_at);
        setLocation(found.location || "");
        setComment(found.comment || "");
        setIsCoop(!!found.is_coop);
        setDurationMin(found.duration_min);
        if (found.is_coop) {
          setCoopSuccess(found.players.some((p) => p.win));
        }
        setPlayers(
          found.players.length
            ? found.players.map((p) => ({
                name: p.name,
                scoreText: p.score != null ? String(p.score) : "",
                win: !!p.win,
                isAutoma: !!p.is_automa,
              }))
            : [emptyPlayer(), emptyPlayer()],
        );
        const startIdx = found.players.findIndex((p) => String(p.start_position) === "1");
        setStartPlayerIndex(startIdx >= 0 ? startIdx : null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "불러오기 실패");
      } finally {
        setLoading(false);
      }
    })();
  }, [id, isEdit]);

  // 신규 작성 + 쿼리스트링으로 게임이 지정된 경우 (게임 상세의 "플레이 기록하기")
  useEffect(() => {
    if (isEdit) return;
    const gid = searchParams.get("game_id");
    if (!gid) return;
    api.game(Number(gid)).then((g) => setSelectedGame({ id: g.id, name: g.name })).catch(() => {});
  }, [isEdit, searchParams]);

  // 게임을 고르면 그 게임의 내 기록 요약(최고/최저/평균, 평균시간, 최근 플레이, 상대 전적)을 미리보기로 보여준다.
  useEffect(() => {
    if (!selectedGame) { setGameDetail(null); return; }
    api.game(selectedGame.id).then(setGameDetail).catch(() => setGameDetail(null));
  }, [selectedGame]);

  useEffect(() => {
    if (isEdit || !gameQuery.trim()) { setGameResults([]); return; }
    const t = setTimeout(() => {
      api.games(gameQuery.trim(), 20).then(setGameResults).catch(() => setGameResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [gameQuery, isEdit]);

  function updatePlayer(i: number, patch: Partial<PlayerRow>) {
    setPlayers((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }
  function addPlayer() { setPlayers((prev) => [...prev, emptyPlayer()]); }
  function removePlayer(i: number) {
    setPlayers((prev) => prev.filter((_, idx) => idx !== i));
    setStartPlayerIndex((cur) => (cur === i ? null : cur != null && cur > i ? cur - 1 : cur));
  }

  const parsedScores = useMemo(
    () => players.map((p) => (p.scoreText.trim() === "" ? null : evalScoreExpression(p.scoreText))),
    [players],
  );

  // "사람 플레이어가 1명 이하"면 솔로 - 오토마만 상대인 판도 솔로다.
  const humanCount = players.filter((p) => p.name.trim() && !p.isAutoma).length;

  function pickStartPlayer() {
    const filledIdx = players.map((p, i) => (p.name.trim() ? i : -1)).filter((i) => i >= 0);
    if (filledIdx.length === 0) return;
    const pick = filledIdx[Math.floor(Math.random() * filledIdx.length)];
    setStartPlayerIndex(pick);
  }

  function selectLocation(name: string) {
    setLocation(name);
    setAddingLocation(false);
  }

  async function handleSave() {
    if (!selectedGame) { setError("게임을 선택하세요"); return; }
    setError(null);
    setSaving(true);
    try {
      const finalPlayers: PlayPlayer[] = players
        .filter((p) => p.name.trim())
        .map((p, i) => ({
          name: p.name.trim(),
          score: parsedScores[i],
          win: isCoop ? coopSuccess : p.win,
          team: isCoop ? "coop" : undefined,
          is_automa: p.isAutoma,
          start_position: startPlayerIndex === i ? "1" : null,
        }));

      const body = {
        game_id: selectedGame.id,
        played_at: playedAt,
        duration_min: durationMin,
        location: location || null,
        comment: comment || null,
        is_coop: isCoop,
        players: finalPlayers,
      };

      if (isEdit) {
        await api.updatePlay(Number(id), body);
      } else {
        await api.addPlay(body);
      }
      navigate(-1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!isEdit) return;
    if (!window.confirm("이 기록을 삭제할까요?")) return;
    setDeleting(true);
    try {
      await api.deletePlay(Number(id));
      navigate("/plays");
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 실패");
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="page center-pad muted">불러오는 중...</div>;

  const stats = gameDetail?.stats;
  const hasScorePreview = stats && (stats.score.solo || stats.score.multi);

  // 현재 위치가 목록에 없으면(예: 수정 화면에서 예전 값) 칩 목록에 추가해서 놓치지 않게 한다.
  const locationChips = location && !locations.some((l) => l.name === location)
    ? [{ name: location, count: 0 }, ...locations]
    : locations;

  return (
    <div className="page play-form-page">
      <div className="page-header">
        <h1>{isEdit ? "기록 수정" : "플레이 기록"}</h1>
        <button className="icon-btn" style={{ background: "none", color: "var(--muted)" }} onClick={() => navigate(-1)}>✕</button>
      </div>

      <div className="field">
        <label>게임</label>
        {selectedGame ? (
          <div className="selected-game">
            <span>{selectedGame.name}</span>
            {!isEdit && <button className="btn-small" onClick={() => setSelectedGame(null)}>변경</button>}
          </div>
        ) : (
          <>
            <input placeholder="게임 이름 검색" value={gameQuery} onChange={(e) => setGameQuery(e.target.value)} />
            {gameResults.length > 0 && (
              <ul className="game-search-dropdown">
                {gameResults.map((g) => (
                  <li key={g.id}>
                    <button onClick={() => { setSelectedGame({ id: g.id, name: g.name }); setGameQuery(""); setGameResults([]); }}>
                      {g.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {hasScorePreview && (
        <div className="card preview-box">
          <div className="section-title" style={{ margin: "0 0 8px" }}>이 게임의 내 기록</div>
          <div className="preview-score-split">
            {stats!.score.solo && (
              <div className="preview-score-col">
                <div className="muted preview-score-label">1인 ({stats!.score.solo.count}판)</div>
                <div className="preview-score-line">최고 {fmtNum(stats!.score.solo.best)} · 최저 {fmtNum(stats!.score.solo.worst)} · 평균 {fmtNum(stats!.score.solo.avg)}</div>
              </div>
            )}
            {stats!.score.multi && (
              <div className="preview-score-col">
                <div className="muted preview-score-label">2인+ ({stats!.score.multi.count}판)</div>
                <div className="preview-score-line">최고 {fmtNum(stats!.score.multi.best)} · 최저 {fmtNum(stats!.score.multi.worst)} · 평균 {fmtNum(stats!.score.multi.avg)}</div>
              </div>
            )}
          </div>
          <div className="preview-meta muted">
            {stats!.avgDurationMin != null && <span>평균 {stats!.avgDurationMin}분</span>}
            {stats!.lastPlayedAt && <span>최근 {stats!.lastPlayedAt}</span>}
          </div>
          {stats!.opponents.length > 0 && (
            <div className="preview-opponents muted">
              {stats!.opponents.map((o) => `${o.name} ${o.games}판 ${o.myWins}승`).join(" · ")}
            </div>
          )}
        </div>
      )}
      {gameDetail && !hasScorePreview && gameDetail.playCount === 0 && (
        <p className="muted preview-empty">아직 이 게임의 기록이 없습니다.</p>
      )}

      <div className="field-row">
        <div className="field">
          <label>날짜</label>
          <input type="date" value={playedAt} onChange={(e) => setPlayedAt(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label>장소</label>
        {location && !addingLocation ? (
          <div className="selected-game">
            <span>{location}</span>
            <button className="btn-small" onClick={() => setAddingLocation(true)}>변경</button>
          </div>
        ) : (
          <>
            <div className="chip-row">
              {locationChips.map((l) => (
                <button key={l.name} className={`chip${location === l.name ? " chip-active" : ""}`}
                  onClick={() => selectLocation(l.name)}>
                  {l.name}{l.count > 0 ? ` (${l.count})` : ""}
                </button>
              ))}
              <button className="chip" onClick={() => setAddingLocation(true)}>+ 새 장소</button>
            </div>
            {addingLocation && (
              <div className="new-location-row">
                <input
                  placeholder="새 장소 이름"
                  value={newLocationText}
                  onChange={(e) => setNewLocationText(e.target.value)}
                  autoFocus
                />
                <button className="btn-small" onClick={() => { if (newLocationText.trim()) selectLocation(newLocationText.trim()); setNewLocationText(""); }}>
                  추가
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <PlayTimer avgMinutes={stats?.avgDurationMin ?? null} onDurationChange={setDurationMin} />

      <div className="field">
        <label>플레이 시간 (분, 직접 수정 가능)</label>
        <input
          type="number"
          value={durationMin ?? ""}
          onChange={(e) => setDurationMin(e.target.value === "" ? null : Number(e.target.value))}
        />
      </div>

      <div className="field coop-toggle">
        <label className="switch-label">
          <input type="checkbox" checked={isCoop} onChange={(e) => setIsCoop(e.target.checked)} />
          협력 모드
        </label>
        {isCoop && (
          <div className="coop-result">
            <button className={coopSuccess ? "btn-primary" : "btn-secondary"} onClick={() => setCoopSuccess(true)}>성공</button>
            <button className={!coopSuccess ? "btn-primary" : "btn-secondary"} onClick={() => setCoopSuccess(false)}>실패</button>
          </div>
        )}
      </div>

      <div className="section-title">
        플레이어 <span className="muted" style={{ textTransform: "none" }}>({humanCount <= 1 ? "1인 · 솔로" : `${humanCount}인+`})</span>
      </div>
      {players.map((p, i) => (
        <div key={i} className="player-row-edit">
          <input
            className="player-name-input"
            placeholder="이름"
            value={p.name}
            onChange={(e) => updatePlayer(i, { name: e.target.value })}
          />
          <input
            className="player-score-input"
            placeholder="점수 (12+8+5 가능)"
            value={p.scoreText}
            onChange={(e) => updatePlayer(i, { scoreText: e.target.value })}
          />
          {!isCoop && (
            <label className="win-checkbox">
              <input type="checkbox" checked={p.win} onChange={(e) => updatePlayer(i, { win: e.target.checked })} />
              승
            </label>
          )}
          <button className="remove-player-btn" onClick={() => removePlayer(i)} aria-label="플레이어 제거">✕</button>
          <label className="automa-checkbox">
            <input type="checkbox" checked={p.isAutoma} onChange={(e) => updatePlayer(i, { isAutoma: e.target.checked })} />
            오토마/봇
          </label>
          {startPlayerIndex === i && <span className="start-player-tag">시작 플레이어</span>}
          {p.scoreText.trim() && parsedScores[i] == null && (
            <div className="score-error">식을 계산할 수 없습니다</div>
          )}
          {p.scoreText.trim() && parsedScores[i] != null && p.scoreText.trim() !== String(parsedScores[i]) && (
            <div className="score-preview muted">= {Math.round(parsedScores[i]!)}</div>
          )}
        </div>
      ))}
      <button className="btn-secondary add-player-btn" onClick={addPlayer}>+ 플레이어 추가</button>
      <button className="btn-secondary add-player-btn" onClick={pickStartPlayer}>🎲 시작 플레이어 뽑기</button>

      <div className="field">
        <label>코멘트</label>
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="play-form-actions">
        <button className="btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? "저장 중..." : "저장"}
        </button>
        {isEdit && (
          <button className="btn-secondary danger" disabled={deleting} onClick={handleDelete}>
            {deleting ? "삭제 중..." : "삭제"}
          </button>
        )}
      </div>
    </div>
  );
}
