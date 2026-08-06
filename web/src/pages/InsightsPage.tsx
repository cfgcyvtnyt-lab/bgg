import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Insights } from "../api/types";
import "../styles/Insights.css";

function fmt(n: number) {
  return Math.round(n).toLocaleString();
}

function fmtHours(minutes: number) {
  const h = Math.round(minutes / 60);
  return `${h.toLocaleString()}시간`;
}

// index.css의 --c1~--c10 팔레트를 순서대로 돌려쓴다 (항목이 10개 넘으면 반복).
const PALETTE = Array.from({ length: 10 }, (_, i) => `var(--c${i + 1})`);
function colorAt(i: number) {
  return PALETTE[i % PALETTE.length];
}

// 만원 단위 반올림 표기 ("614만" 등).
function fmtManwon(krw: number) {
  const man = Math.round(krw / 10000);
  return `${man.toLocaleString()}만`;
}

export default function InsightsPage() {
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllWinRates, setShowAllWinRates] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.insights()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "불러오기 실패"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="page center-pad muted">불러오는 중...</div>;
  if (error) return <div className="page center-pad error-text">{error}</div>;
  if (!data) return null;

  const topGames = data.topGames.slice(0, 10);
  const maxTop = topGames[0]?.count || 1;
  const maxMonthly = Math.max(1, ...data.monthlyPlays.map((m) => m.count));
  const maxLoc = Math.max(1, ...data.byLocation.map((l) => l.count));

  const levelBadges = [
    { key: "fives", label: "5판+", value: data.levels.fives },
    { key: "dimes", label: "10판+", value: data.levels.dimes },
    { key: "quarters", label: "25판+", value: data.levels.quarters },
    { key: "centuries", label: "100판+", value: data.levels.centuries },
    { key: "thousands", label: "1000판+", value: data.levels.thousands },
  ];

  return (
    <div className="page insights-page">
      <div className="page-header"><h1>인사이트</h1></div>

      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-value">{fmt(data.totalPlays)}</div>
          <div className="summary-label muted">총 플레이</div>
        </div>
        <div className="summary-card">
          <div className="summary-value">{fmt(data.distinctGames)}</div>
          <div className="summary-label muted">서로 다른 게임</div>
        </div>
        <div className="summary-card">
          <div className="summary-value">{fmtHours(data.totalMinutes)}</div>
          <div className="summary-label muted">총 플레이 시간</div>
        </div>
        <div className="summary-card">
          <div className="summary-value">{fmt(data.hIndex)}</div>
          <div className="summary-label muted">H-index</div>
        </div>
      </div>

      <div className="spending-summary muted">
        총 구매 {fmtManwon(data.spending.totalPaid)} · 회수 {fmtManwon(data.spending.totalSold)} · 순지출 {fmtManwon(data.spending.net)}
      </div>

      <div className="section-title">달성 레벨</div>
      <div className="level-badges">
        {levelBadges.map((b, i) => (
          <div
            key={b.key}
            className={`level-badge${b.value > 0 ? " earned" : ""}`}
            style={b.value > 0 ? { borderColor: colorAt(i), color: colorAt(i) } : undefined}
          >
            <div className="level-badge-value">{b.value}</div>
            <div className="level-badge-label">{b.label}</div>
          </div>
        ))}
      </div>

      <div className="section-title">최다 연승</div>
      <div className="card streak-card">
        <span className="streak-value">{fmt(data.bestStreak)}</span>
        <span className="muted">연승</span>
      </div>

      <div className="section-title">최다 플레이 TOP 10</div>
      <div className="card bar-chart">
        {topGames.length === 0 && <p className="muted">기록이 없습니다.</p>}
        {topGames.map((g) => (
          <Link key={g.game_id} to={`/game/${g.game_id}`} className="bar-row">
            <span className="bar-row-label">{g.game_name}</span>
            <div className="bar-row-track">
              <div className="bar-row-fill" style={{ width: `${(g.count / maxTop) * 100}%` }} />
            </div>
            <span className="bar-row-value">{fmt(g.count)}</span>
          </Link>
        ))}
      </div>

      <div className="section-title">플레이어별 승률</div>
      <div className="card">
        {data.winRates.length === 0 && <p className="muted">기록이 없습니다.</p>}
        {/* 온라인에서 한 판 만난 상대까지 다 나오면 의미가 없어서 기본은 5판 이상만 보여준다 */}
        {(showAllWinRates ? data.winRates : data.winRates.filter((w) => w.plays >= 5)).map((w) => (
          <div key={w.name} className="winrate-row">
            <span className="winrate-name">{w.name}</span>
            <div className="bar-row-track">
              <div className="bar-row-fill" style={{ width: `${Math.round(w.winRate * 100)}%` }} />
            </div>
            <span className="winrate-value muted">{w.wins}/{w.plays} ({Math.round(w.winRate * 100)}%)</span>
          </div>
        ))}
        {!showAllWinRates && data.winRates.some((w) => w.plays < 5) && (
          <button className="chip" onClick={() => setShowAllWinRates(true)}>전체 보기</button>
        )}
        {showAllWinRates && (
          <button className="chip" onClick={() => setShowAllWinRates(false)}>접기</button>
        )}
      </div>

      <div className="section-title">월별 플레이</div>
      <div className="card monthly-chart">
        {data.monthlyPlays.length === 0 && <p className="muted">기록이 없습니다.</p>}
        <div className="monthly-bars">
          {data.monthlyPlays.map((m) => (
            <div key={m.month} className="monthly-bar-col" title={`${m.month}: ${m.count}회`}>
              <div
                className={`monthly-bar${m.count === maxMonthly ? " is-max" : ""}`}
                style={{ height: `${(m.count / maxMonthly) * 100}%` }}
              />
              <div className="monthly-bar-label">{m.month.slice(2).replace("-", "/")}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="section-title">장소별 분포</div>
      <div className="card bar-chart">
        {data.byLocation.length === 0 && <p className="muted">기록이 없습니다.</p>}
        {data.byLocation.map((l, i) => (
          <div key={l.location} className="bar-row">
            <span className="bar-row-label">{l.location}</span>
            <div className="bar-row-track">
              <div
                className="bar-row-fill"
                style={{ width: `${(l.count / maxLoc) * 100}%`, background: colorAt(i) }}
              />
            </div>
            <span className="bar-row-value">{fmt(l.count)}</span>
          </div>
        ))}
      </div>

      <div className="section-title">안 해본 보유 게임 ({data.ownedNotPlayed.length})</div>
      <div className="card">
        {data.ownedNotPlayed.length === 0 && <p className="muted">보유 게임을 모두 플레이했습니다.</p>}
        <div className="chip-row wrap">
          {data.ownedNotPlayed.map((g) => (
            <Link key={g.id} to={`/game/${g.id}`} className="chip">{g.name}</Link>
          ))}
        </div>
      </div>

      <div className="section-title">판당 비용 - 가성비 좋은</div>
      <div className="card">
        {data.costPerPlay.cheapest.length === 0 && <p className="muted">데이터가 없습니다.</p>}
        {data.costPerPlay.cheapest.slice(0, 5).map((c) => (
          <div key={c.game_id} className="cost-row">
            <Link to={`/game/${c.game_id}`}>{c.game_name}</Link>
            <span className="muted">{fmt(c.costPerPlay)}원/판 ({c.plays}회)</span>
          </div>
        ))}
      </div>

      <div className="section-title">판당 비용 - 비싼</div>
      <div className="card">
        {data.costPerPlay.priciest.length === 0 && <p className="muted">데이터가 없습니다.</p>}
        {data.costPerPlay.priciest.slice(0, 5).map((c) => (
          <div key={c.game_id} className="cost-row">
            <Link to={`/game/${c.game_id}`}>{c.game_name}</Link>
            <span className="muted">{fmt(c.costPerPlay)}원/판 ({c.plays}회)</span>
          </div>
        ))}
      </div>
    </div>
  );
}
