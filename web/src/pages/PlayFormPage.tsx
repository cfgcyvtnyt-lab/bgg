import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { Game, Play, PlayPlayer } from "../api/types";
import { evalScoreExpression } from "../utils/scoreParser";
import PlayTimer from "../components/PlayTimer";
import "../styles/PlayForm.css";

interface PlayerRow {
  name: string;
  scoreText: string;
  win: boolean;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function emptyPlayer(): PlayerRow {
  return { name: "", scoreText: "", win: false };
}

export default function PlayFormPage() {
  const { id } = useParams();
  const isEdit = !!id;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [gameQuery, setGameQuery] = useState("");
  const [gameResults, setGameResults] = useState<Game[]>([]);
  const [selectedGame, setSelectedGame] = useState<{ id: number; name: string } | null>(null);
  const [playedAt, setPlayedAt] = useState(todayStr());
  const [location, setLocation] = useState("");
  const [comment, setComment] = useState("");
  const [isCoop, setIsCoop] = useState(false);
  const [coopSuccess, setCoopSuccess] = useState(true);
  const [players, setPlayers] = useState<PlayerRow[]>([emptyPlayer(), emptyPlayer()]);
  const [durationMin, setDurationMin] = useState<number | null>(null);
  const [avgMinutes, setAvgMinutes] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(isEdit);

  // 수정 모드: 전체 플레이 목록에서 id로 찾는다 (단건 조회 엔드포인트가 없어서 페이지를 넘기며 찾는다)
  useEffect(() => {
    if (!isEdit) return;
    const targetId = Number(id);
    (async () => {
      setLoading(true);
      try {
        let found: Play | null = null;
        for (let offset = 0; offset < 1500 && !found; offset += 500) {
          const page = await api.plays({ limit: 500, offset });
          found = page.find((p) => p.id === targetId) || null;
          if (page.length < 500) break;
        }
        if (!found) {
          setError("기록을 찾을 수 없습니다");
          return;
        }
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
            ? found.players.map((p) => ({ name: p.name, scoreText: p.score != null ? String(p.score) : "", win: !!p.win }))
            : [emptyPlayer(), emptyPlayer()],
        );
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

  // 선택된 게임의 평균 소요시간 계산
  useEffect(() => {
    if (!selectedGame) { setAvgMinutes(null); return; }
    api.plays({ game_id: selectedGame.id, limit: 500 }).then((list) => {
      const durations = list.map((p) => p.duration_min).filter((n): n is number => n != null && n > 0);
      if (durations.length === 0) { setAvgMinutes(null); return; }
      setAvgMinutes(durations.reduce((a, b) => a + b, 0) / durations.length);
    }).catch(() => setAvgMinutes(null));
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
  function removePlayer(i: number) { setPlayers((prev) => prev.filter((_, idx) => idx !== i)); }

  const parsedScores = useMemo(
    () => players.map((p) => (p.scoreText.trim() === "" ? null : evalScoreExpression(p.scoreText))),
    [players],
  );

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

      <div className="field-row">
        <div className="field">
          <label>날짜</label>
          <input type="date" value={playedAt} onChange={(e) => setPlayedAt(e.target.value)} />
        </div>
        <div className="field">
          <label>장소</label>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="예: 우리집" />
        </div>
      </div>

      <PlayTimer avgMinutes={avgMinutes} onDurationChange={setDurationMin} />

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

      <div className="section-title">플레이어</div>
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
          {p.scoreText.trim() && parsedScores[i] == null && (
            <div className="score-error">식을 계산할 수 없습니다</div>
          )}
          {p.scoreText.trim() && parsedScores[i] != null && p.scoreText.trim() !== String(parsedScores[i]) && (
            <div className="score-preview muted">= {Math.round(parsedScores[i]!)}</div>
          )}
        </div>
      ))}
      <button className="btn-secondary add-player-btn" onClick={addPlayer}>+ 플레이어 추가</button>

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
