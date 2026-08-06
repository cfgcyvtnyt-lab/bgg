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

// 원화 기호 + 천단위 콤마 표기 ("₩6,141,882" 등).
function fmtKRW(krw: number) {
  return `₩${Math.round(krw).toLocaleString()}`;
}

// 요일·장소 분포용 파이 조각 계산. 라이브러리 없이 SVG path만으로 그린다.
function pieSlices(items: { label: string; count: number }[]) {
  const total = items.reduce((s, it) => s + it.count, 0);
  if (total <= 0) return { total, slices: [] as { label: string; count: number; percent: number; color: string; path?: string; isFull?: boolean }[] };
  const nonZero = items.filter((it) => it.count > 0);
  let angle = -90; // 12시 방향에서 시작
  const slices = nonZero.map((it, i) => {
    const frac = it.count / total;
    const percent = Math.round(frac * 100);
    const color = colorAt(i);
    if (nonZero.length === 1) {
      return { label: it.label, count: it.count, percent, color, isFull: true };
    }
    const start = angle;
    const sweep = frac * 360;
    const end = start + sweep;
    angle = end;
    const cx = 50, cy = 50, r = 48;
    const toXY = (deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
    const [sx, sy] = toXY(start);
    const [ex, ey] = toXY(end);
    const large = sweep > 180 ? 1 : 0;
    const path = `M${cx},${cy} L${sx},${sy} A${r},${r} 0 ${large} 1 ${ex},${ey} Z`;
    return { label: it.label, count: it.count, percent, color, path };
  });
  return { total, slices };
}

function PieChart({ items }: { items: { label: string; count: number }[] }) {
  const { total, slices } = pieSlices(items);
  if (total <= 0) return <p className="muted">기록이 없습니다.</p>;
  return (
    <div className="pie-chart-row">
      <svg viewBox="0 0 100 100" className="pie-chart-svg">
        {slices.map((s) =>
          s.isFull ? (
            <circle key={s.label} cx={50} cy={50} r={48} fill={s.color} />
          ) : (
            <path key={s.label} d={s.path} fill={s.color} />
          )
        )}
      </svg>
      <div className="pie-legend">
        {slices.map((s) => (
          <div key={s.label} className="pie-legend-row">
            <span className="pie-legend-swatch" style={{ background: s.color }} />
            <span className="pie-legend-label">{s.label}</span>
            <span className="pie-legend-value muted">{s.percent}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type PeriodKey = "month" | "year" | "all" | "custom";
const PERIOD_TABS: { key: PeriodKey; label: string }[] = [
  { key: "month", label: "이번 달" },
  { key: "year", label: "올해" },
  { key: "all", label: "전체" },
  { key: "custom", label: "직접" },
];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

// 월의 마지막 날짜 (다음 달 0일 = 이번 달 말일).
function lastDayOfMonth(year: number, month1: number) {
  return new Date(year, month1, 0).getDate();
}

// "이번 달"/"올해" 탭에 쓸 from/to (YYYY-MM-DD) 계산. anchor로 이동한 월/연도 기준.
// 전체/직접은 각각 undefined/사용자 입력을 쓴다.
function periodRange(key: PeriodKey, anchor: Date, customFrom: string, customTo: string): { from?: string; to?: string } {
  if (key === "month") {
    const y = anchor.getFullYear();
    const m = anchor.getMonth() + 1;
    return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}` };
  }
  if (key === "year") {
    const y = anchor.getFullYear();
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  if (key === "custom") {
    return { from: customFrom || undefined, to: customTo || undefined };
  }
  return {};
}

export default function InsightsPage() {
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllWinRates, setShowAllWinRates] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>("all");
  const [anchor, setAnchor] = useState(() => new Date());
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => {
    setLoading(true);
    const { from, to } = periodRange(period, anchor, customFrom, customTo);
    api.insights({ from, to })
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "불러오기 실패"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, anchor, customFrom, customTo]);

  function selectPeriod(key: PeriodKey) {
    setPeriod(key);
    setAnchor(new Date());
  }

  function stepPeriod(delta: number) {
    if (period === "month") {
      setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1));
    } else if (period === "year") {
      setAnchor((d) => new Date(d.getFullYear() + delta, d.getMonth(), 1));
    }
  }

  const periodNavLabel =
    period === "month" ? `${anchor.getFullYear()}년 ${anchor.getMonth() + 1}월`
    : period === "year" ? `${anchor.getFullYear()}`
    : null;

  if (loading) return <div className="page center-pad muted">불러오는 중...</div>;
  if (error) return <div className="page center-pad error-text">{error}</div>;
  if (!data) return null;

  const topGames = data.topGames.slice(0, 10);
  const maxTop = topGames[0]?.count || 1;
  const maxMonthly = Math.max(1, ...data.monthlyPlays.map((m) => m.count));

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

      <Link to="/challenges" className="challenges-entry-link">도전 과제 &gt;</Link>

      <div className="period-tabs">
        {PERIOD_TABS.map((t) => (
          <button
            key={t.key}
            className={`period-tab${period === t.key ? " active" : ""}`}
            onClick={() => selectPeriod(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {periodNavLabel && (
        <div className="period-nav-row">
          <button className="period-nav-btn" onClick={() => stepPeriod(-1)}>◀</button>
          <span className="period-nav-label">{periodNavLabel}</span>
          <button className="period-nav-btn" onClick={() => stepPeriod(1)}>▶</button>
        </div>
      )}
      {period === "custom" && (
        <div className="period-custom-row">
          <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
          <span className="muted">~</span>
          <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
        </div>
      )}

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
        총 구매 {fmtKRW(data.spending.totalPaid)} · 회수 {fmtKRW(data.spending.totalSold)} · 순지출 {fmtKRW(data.spending.net)}
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
        {topGames.map((g, i) => (
          <Link key={g.game_id} to={`/game/${g.game_id}`} className="bar-row">
            <span className="bar-row-label">{g.game_name}</span>
            <div className="bar-row-track">
              <div className="bar-row-fill" style={{ width: `${(g.count / maxTop) * 100}%`, background: colorAt(i) }} />
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

      <div className="section-title">요일별 분포</div>
      <div className="card">
        <PieChart items={data.byWeekday.map((w) => ({ label: w.weekday, count: w.count }))} />
      </div>

      <div className="section-title">장소별 분포</div>
      <div className="card">
        <PieChart items={data.byLocation.map((l) => ({ label: l.location, count: l.count }))} />
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
