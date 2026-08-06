import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { Play, User } from "../api/types";
import "../styles/Plays.css";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// 사용자별 이니셜 원 색 고정 - 아바타가 없을 때도 항상 같은 색으로 보이게 이름 해시로 고른다.
const INITIAL_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)", "var(--c9)", "var(--c10)"];
function colorForName(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return INITIAL_COLORS[hash % INITIAL_COLORS.length];
}

function fmtDateHeader(dateStr: string) {
  // dateStr: YYYY-MM-DD (로컬 타임존 이슈를 피하려고 문자열을 직접 쪼갠다)
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return { weekday: WEEKDAYS[date.getDay()], label: `${y}년 ${m}월 ${d}일` };
}

export default function PlaysPage() {
  const [plays, setPlays] = useState<Play[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // URL의 game_id는 플레이 상세의 "N회 플레이 >" 링크로 들어올 때만 쓰인다.
  // 화면에 필터 UI는 없다 (체감 성능 문제로 제거 - PLAN 참고).
  const gameId = searchParams.get("game_id");
  const gameNameParam = searchParams.get("game_name");

  useEffect(() => {
    api.users().then(setUsers).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    // 서버가 /api/plays 응답을 500건으로 캡핑해서, 전체 개수를 보여주려면
    // 500건씩 끊어서 다 받아올 때까지 페이지를 넘긴다.
    (async () => {
      try {
        const all: Play[] = [];
        for (let offset = 0; ; offset += 500) {
          const page = await api.plays({
            limit: 500,
            offset,
            game_id: gameId ? Number(gameId) : undefined,
          });
          all.push(...page);
          if (page.length < 500) break;
        }
        setPlays(all);
      } catch (err) {
        setError(err instanceof Error ? err.message : "불러오기 실패");
      } finally {
        setLoading(false);
      }
    })();
  }, [gameId]);

  // 이름 -> 아바타 파일명 맵 (프로필 사진이 있는 사용자만)
  const avatarByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users) if (u.avatar) map.set(u.name, u.avatar);
    return map;
  }, [users]);

  // BGStats처럼 날짜(일)별로 묶는다 - 서버가 이미 최신순으로 정렬해준다.
  const groups = useMemo(() => {
    const map = new Map<string, Play[]>();
    for (const p of plays) {
      if (!map.has(p.played_at)) map.set(p.played_at, []);
      map.get(p.played_at)!.push(p);
    }
    return [...map.entries()];
  }, [plays]);

  return (
    <div className="page plays-page">
      <div className="page-header">
        <h1>기록</h1>
        <button className="icon-btn" onClick={() => navigate("/plays/new")} aria-label="기록 추가">＋</button>
      </div>

      {gameId && (
        <div className="plays-scoped-banner">
          <span>{gameNameParam || "게임"} 플레이 목록</span>
          <Link to="/plays" className="plays-scoped-clear">전체 기록 보기</Link>
        </div>
      )}

      {!loading && !error && plays.length > 0 && (
        <p className="plays-total muted">{plays.length.toLocaleString()} 플레이</p>
      )}

      {loading && <p className="muted center-pad">불러오는 중...</p>}
      {error && <p className="error-text center-pad">{error}</p>}
      {!loading && !error && plays.length === 0 && (
        <p className="muted center-pad">플레이 기록이 없습니다.</p>
      )}

      {groups.map(([date, list]) => {
        const { weekday, label } = fmtDateHeader(date);
        return (
          <div key={date} className="play-day-group">
            <div className="play-day-divider">
              <span className="play-day-weekday">{weekday}</span>
              <span className="muted">{label}</span>
            </div>
            {list.map((p) => {
              // win=1인 플레이어만 승자로 취급한다 (트로피 오귀속 버그 수정 - 이제 프로필 사진으로 표시).
              const winners = p.players.filter((pl) => pl.win === true || pl.win === 1);
              const orderedPlayers = [
                ...winners,
                ...p.players.filter((pl) => !(pl.win === true || pl.win === 1)),
              ];
              const humanCount = p.players.filter((pl) => !pl.is_automa).length;
              return (
                <Link key={p.id} to={`/plays/${p.id}`} className="play-item">
                  <div className="play-item-text">
                    <div className="play-item-game">{p.game_name}</div>
                    <div className="play-item-loc muted">
                      {p.location || "장소 미기록"} · {orderedPlayers.map((pl) => pl.name).join(", ") || "플레이어 없음"}
                      {humanCount <= 1 ? " · 솔로" : ""}
                      {p.is_coop ? " · 협력" : ""}
                    </div>
                  </div>
                  <div className="play-item-winners">
                    {winners.map((w, i) => {
                      const avatar = avatarByName.get(w.name);
                      return avatar ? (
                        <img key={i} className="winner-avatar" src={api.avatarUrl(avatar)} alt={w.name} title={w.name} />
                      ) : (
                        <div key={i} className="winner-initial" style={{ background: colorForName(w.name) }} title={w.name}>
                          {w.name.slice(0, 1)}
                        </div>
                      );
                    })}
                  </div>
                </Link>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
