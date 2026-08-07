import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Challenge, Insights } from "../api/types";
import DateField from "../components/DateField";
import "../styles/Insights.css";

function fmt(n: number) {
  return Math.round(n).toLocaleString();
}

function fmtHours(minutes: number) {
  const h = Math.round(minutes / 60);
  return `${h.toLocaleString()}시간`;
}

// 파이 조각용 팔레트. index.css의 --c1~--c10은 뱃지·강조용이라 다크 배경에서 파이로 쓰면
// 너무 밝고 쨍하다. 같은 색상환을 유지하되 채도·명도를 낮춘 값을 따로 둔다.
const PALETTE = [
  "#3d7ab8", "#4a8f5f", "#b8893c", "#a85a5d", "#7268b0",
  "#3d8f9c", "#a86b90", "#b57a45", "#5a6f9e", "#4a9080",
];
function colorAt(i: number) {
  return PALETTE[i % PALETTE.length];
}

// 금액 표기는 앱 전체가 "6,141,882원" 형태로 통일한다(판당 비용의 "233원/판"과 같은 방식).
function fmtKRW(krw: number) {
  return `${Math.round(krw).toLocaleString()}원`;
}

// 막대 그래프(일별/월별/연도별 플레이, TOP10) 색상: 값이 클수록 노랑·밝게, 작을수록 파랑·더 어둡게
// 자연스럽게 이어지는 그라데이션. HSL 보간으로 hue(파랑210→노랑40)와 lightness를 동시에 움직인다.
// 값이 클수록 노랑·밝게, 작을수록 파랑·어둡게. 다크 배경에서 형광처럼 튀지 않도록
// 채도와 밝기를 낮게 잡는다(최댓값도 60%를 넘기지 않는다).
function barGradient(count: number, max: number) {
  const t = max > 0 ? Math.max(0, Math.min(1, count / max)) : 0;
  const hue = 210 - t * 165;
  const sat = 38 + t * 17;
  const light = 20 + t * 24;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// 요일·장소 분포용 파이 조각 계산. 라이브러리 없이 SVG path만으로 그린다.
// 텍스트를 조각 안에 넣어야 해서 중간각의 라벨 위치(lx,ly)도 함께 계산한다.
function pieSlices(items: { label: string; count: number }[]) {
  const total = items.reduce((s, it) => s + it.count, 0);
  if (total <= 0) {
    return {
      total,
      slices: [] as { label: string; count: number; percent: number; color: string; path?: string; isFull?: boolean; lx: number; ly: number }[],
    };
  }
  const nonZero = items.filter((it) => it.count > 0);
  let angle = -90; // 12시 방향에서 시작
  const cx = 50, cy = 50, r = 48;
  const toXY = (deg: number, rad: number) => [cx + rad * Math.cos((deg * Math.PI) / 180), cy + rad * Math.sin((deg * Math.PI) / 180)];
  const slices = nonZero.map((it, i) => {
    const frac = it.count / total;
    const percent = Math.round(frac * 100);
    const color = colorAt(i);
    if (nonZero.length === 1) {
      return { label: it.label, count: it.count, percent, color, isFull: true, lx: cx, ly: cy };
    }
    const start = angle;
    const sweep = frac * 360;
    const end = start + sweep;
    angle = end;
    const [sx, sy] = toXY(start, r);
    const [ex, ey] = toXY(end, r);
    const large = sweep > 180 ? 1 : 0;
    const path = `M${cx},${cy} L${sx},${sy} A${r},${r} 0 ${large} 1 ${ex},${ey} Z`;
    const [lx, ly] = toXY((start + end) / 2, r * 0.62);
    return { label: it.label, count: it.count, percent, color, path, lx, ly };
  });
  return { total, slices };
}

// 항목이 많으면(장소 등) 상위 topN개만 남기고 나머지는 "기타"로 합친다.
// count 내림차순 정렬해서 반환하므로 앞쪽 몇 개가 곧 "상위"가 된다.
// 서버가 이미 "기타"로 보내는 항목(장소 미기록)이 있으면 같은 조각으로 합친다 -
// 따로 두면 범례에 "기타"가 두 번 나온다.
function aggregateTopN(items: { label: string; count: number }[], topN: number, otherLabel = "기타") {
  const sorted = [...items].sort((a, b) => b.count - a.count);
  const merge = (list: { label: string; count: number }[], extra: number) => {
    const rest = extra + list.filter((it) => it.label === otherLabel).reduce((s, it) => s + it.count, 0);
    const named = list.filter((it) => it.label !== otherLabel);
    return rest > 0 ? [...named, { label: otherLabel, count: rest }] : named;
  };
  if (sorted.length <= topN) return merge(sorted, 0);
  // "기타"는 상위 자리를 차지하지 않게 빼둔 뒤 잘라낸다
  const named = sorted.filter((it) => it.label !== otherLabel);
  const preset = sorted.filter((it) => it.label === otherLabel).reduce((s, it) => s + it.count, 0);
  const restSum = named.slice(topN).reduce((s, it) => s + it.count, 0);
  return merge(named.slice(0, topN), preset + restSum);
}

// mode="letter": 조각 안에 라벨 글자(요일), 범례 없음.
// mode="percent": 조각 안에 흰색 퍼센트, 옆에 색점+이름만 범례.
// percentTopN: 퍼센트 글자를 넣을 상위 조각 개수 제한(조각이 작으면 글자가 겹쳐서). 생략 시 전부 표시.
function PieChart({ items, mode, percentTopN }: { items: { label: string; count: number }[]; mode: "letter" | "percent"; percentTopN?: number }) {
  const { total, slices } = pieSlices(items);
  if (total <= 0) return <p className="muted">기록이 없습니다.</p>;
  return (
    <div className={`pie-chart-row pie-chart-row-${mode}`}>
      <svg viewBox="0 0 100 100" className="pie-chart-svg">
        {slices.map((s) =>
          s.isFull ? (
            <circle key={s.label} cx={50} cy={50} r={48} fill={s.color} />
          ) : (
            <path key={s.label} d={s.path} fill={s.color} />
          )
        )}
        {mode === "letter" &&
          slices.map((s) => (
            <text key={s.label} x={s.lx} y={s.ly} className="pie-slice-letter">{s.label}</text>
          ))}
        {mode === "percent" &&
          slices.map((s, i) => (percentTopN === undefined || i < percentTopN) && (
            <text key={s.label} x={s.lx} y={s.ly} className="pie-slice-percent">{s.percent}%</text>
          ))}
      </svg>
      {mode === "percent" && (
        <div className="pie-legend">
          {slices.map((s) => (
            <div key={s.label} className="pie-legend-row">
              <span className="pie-legend-swatch" style={{ background: s.color }} />
              <span className="pie-legend-label">{s.label}</span>
            </div>
          ))}
        </div>
      )}
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

type Bucket = "day" | "month" | "year";

// 기간 탭에 따라 그래프 버킷을 정한다: 전체=연도별, 올해=월별, 이번달=일별.
// 직접 지정은 기간 길이로 자동 판단: 1년 초과=연도별, 1개월 초과~1년 이하=월별, 1개월 이하=일별.
// (서버 /api/insights의 기본 판단 로직과 동일한 기준으로 맞춘다.)
function bucketForPeriod(key: PeriodKey, from?: string, to?: string): Bucket {
  if (key === "month") return "day";
  if (key === "year") return "month";
  if (key === "all") return "year";
  if (from && to) {
    const days = (new Date(to).getTime() - new Date(from).getTime()) / 86400000;
    return days > 366 ? "year" : days > 31 ? "month" : "day";
  }
  return "day";
}

const PERIOD_KEY = "bgg_insights_period";
// 노플 게임은 이만큼만 먼저 보여주고 나머지는 접는다.
const NOT_PLAYED_PREVIEW = 12;

const BUCKET_TITLE: Record<Bucket, string> = { day: "일별 플레이", month: "월별 플레이", year: "연도별 플레이" };

// 그래프 막대 아래 표시할 짧은 라벨. day는 촘촘해서 일부만(대략 6~8개 간격) 보여준다.
function barLabel(label: string, bucket: Bucket, index: number, count: number) {
  if (bucket === "year") return label;
  if (bucket === "month") return `${Number(label.slice(5, 7))}월`;
  const day = Number(label.slice(8, 10));
  const step = Math.max(1, Math.ceil(count / 10));
  if (day === 1 || (index % step === 0)) return String(day);
  return "";
}

export default function InsightsPage() {
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllWinRates, setShowAllWinRates] = useState(false);
  const [showAllNotPlayed, setShowAllNotPlayed] = useState(false);
  const [challenges, setChallenges] = useState<Challenge[]>([]);

  // 도전과제는 기간 필터와 무관한 값이라 한 번만 불러온다.
  useEffect(() => {
    api.challenges().then(setChallenges).catch(() => setChallenges([]));
  }, []);
  // 마지막으로 본 기간을 기억한다 - 들어올 때마다 "전체"로 되돌아가면 매번 다시 눌러야 한다.
  const [period, setPeriod] = useState<PeriodKey>(() => {
    const saved = localStorage.getItem(PERIOD_KEY);
    return (saved === "month" || saved === "year" || saved === "all" || saved === "custom") ? saved : "all";
  });
  const [anchor, setAnchor] = useState(() => new Date());
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  useEffect(() => { localStorage.setItem(PERIOD_KEY, period); }, [period]);

  useEffect(() => {
    setLoading(true);
    const { from, to } = periodRange(period, anchor, customFrom, customTo);
    const bucket = bucketForPeriod(period, from, to);
    api.insights({ from, to, bucket })
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
  const maxPlays = Math.max(1, ...data.plays.map((m) => m.count));

  return (
    <div className="page insights-page">
      <div className="page-header"><h1>인사이트</h1></div>

      {/* 진행 중인 도전과제 요약. 진행률은 서버가 계산해 challenge.progress.percent로 준다. */}
      <div className="section-title-row challenge-summary-head">
        <div className="section-title">도전 과제</div>
        <Link to="/challenges" className="challenges-entry-link">전체 보기 &gt;</Link>
      </div>
      <div className="card challenge-summary">
        {challenges.length === 0 ? (
          <p className="muted empty-hint">진행 중인 도전 과제가 없습니다.</p>
        ) : (
          challenges.map((c) => {
            const pct = c.progress?.percent ?? 0;
            return (
              <Link key={c.id} to="/challenges" className="challenge-summary-row">
                <span className="challenge-summary-name">{c.name}</span>
                <div className="bar-row-track">
                  <div className="bar-row-fill" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <span className="challenge-summary-pct muted">{Math.round(pct)}%</span>
              </Link>
            );
          })
        )}
      </div>

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
          <DateField value={customFrom} onChange={setCustomFrom} />
          <span className="muted">~</span>
          <DateField value={customTo} onChange={setCustomTo} />
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

      <div className="section-title">{BUCKET_TITLE[data.bucket]}</div>
      <div className="card plays-chart">
        {data.plays.length === 0 && <p className="muted">기록이 없습니다.</p>}
        <div
          className="plays-bars"
          style={{ gap: data.plays.length > 15 ? "3px" : data.plays.length > 8 ? "6px" : "12px" }}
        >
          {data.plays.map((m, i) => (
            <div key={m.label} className="plays-bar-col" title={`${m.label}: ${m.count}회`}>
              <div
                className="plays-bar"
                style={{ height: `${(m.count / maxPlays) * 100}%`, background: barGradient(m.count, maxPlays) }}
              />
              <div className="plays-bar-label">{barLabel(m.label, data.bucket, i, data.plays.length)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="section-title">최다 플레이 TOP 10</div>
      <div className="card bar-chart">
        {topGames.length === 0 && <p className="muted">기록이 없습니다.</p>}
        {topGames.map((g) => (
          <Link key={g.game_id} to={`/game/${g.game_id}`} className="bar-row">
            <span className="bar-row-label">{g.game_name}</span>
            <div className="bar-row-track">
              <div
                className="bar-row-fill"
                style={{ width: `${(g.count / maxTop) * 100}%`, background: barGradient(g.count, maxTop) }}
              />
            </div>
            <span className="bar-row-value">{fmt(g.count)}</span>
          </Link>
        ))}
      </div>

      <div className="section-title">상대별 내 승률</div>
      <div className="card">
        {data.winRates.length === 0 && <p className="muted">기록이 없습니다.</p>}
        {/* 온라인에서 한 번 만난 상대까지 다 나오면 의미가 없어서 기본은 5회 이상만 보여준다 */}
        {(showAllWinRates ? data.winRates : data.winRates.filter((w) => w.plays >= 5)).map((w) => (
          <div key={w.name} className="winrate-row">
            <span className="winrate-name" title={w.name}>{w.name}</span>
            <div className="bar-row-track">
              <div className="bar-row-fill" style={{ width: `${Math.round(w.winRate * 100)}%` }} />
            </div>
            <span className="winrate-value muted">{w.wins}/{w.plays} ({Math.round(w.winRate * 100)}%)</span>
          </div>
        ))}
        {!showAllWinRates && data.winRates.some((w) => w.plays < 5) && (
          <button className="show-more-btn" onClick={() => setShowAllWinRates(true)}>... 더보기</button>
        )}
        {showAllWinRates && (
          <button className="show-more-btn" onClick={() => setShowAllWinRates(false)}>접기</button>
        )}
      </div>

      <div className="pie-two-col">
        <div className="pie-two-item">
          <div className="section-title">요일별 분포</div>
          <div className="card">
            <PieChart items={data.byWeekday.map((w) => ({ label: w.weekday, count: w.count }))} mode="letter" />
          </div>
        </div>
        <div className="pie-two-item">
          <div className="section-title">장소별 분포</div>
          <div className="card">
            <PieChart
              items={aggregateTopN(data.byLocation.map((l) => ({ label: l.location, count: l.count })), 5)}
              mode="percent"
              percentTopN={3}
            />
          </div>
        </div>
      </div>

      <div className="section-title">노플 게임 ({data.ownedNotPlayed.length})</div>
      <div className="card">
        {data.ownedNotPlayed.length === 0 && <p className="muted">보유 게임을 모두 플레이했습니다.</p>}
        <div className="chip-row wrap">
          {(showAllNotPlayed ? data.ownedNotPlayed : data.ownedNotPlayed.slice(0, NOT_PLAYED_PREVIEW)).map((g) => (
            <Link key={g.id} to={`/game/${g.id}`} className="chip">{g.name}</Link>
          ))}
        </div>
        {/* 수십 개가 한꺼번에 깔리면 이 아래 내용이 화면 밖으로 밀린다 */}
        {data.ownedNotPlayed.length > NOT_PLAYED_PREVIEW && (
          <button className="show-more-btn" onClick={() => setShowAllNotPlayed((v) => !v)}>
            {showAllNotPlayed ? "접기" : `... 더보기 (${data.ownedNotPlayed.length - NOT_PLAYED_PREVIEW}개)`}
          </button>
        )}
      </div>

      <div className="section-title">가성비 좋은 게임</div>
      <div className="card">
        {data.costPerPlay.cheapest.length === 0 && <p className="muted">데이터가 없습니다.</p>}
        {data.costPerPlay.cheapest.slice(0, 5).map((c) => (
          <div key={c.game_id} className="cost-row">
            <Link to={`/game/${c.game_id}`}>{c.game_name}</Link>
            <span className="muted">{fmt(c.costPerPlay)}원/회 ({c.plays}회)</span>
          </div>
        ))}
      </div>

      <div className="section-title">비싼 장식품</div>
      <div className="card">
        {data.costPerPlay.priciest.length === 0 && <p className="muted">데이터가 없습니다.</p>}
        {data.costPerPlay.priciest.slice(0, 5).map((c) => (
          <div key={c.game_id} className="cost-row">
            <Link to={`/game/${c.game_id}`}>{c.game_name}</Link>
            <span className="muted">{fmt(c.costPerPlay)}원/회 ({c.plays}회)</span>
          </div>
        ))}
      </div>
    </div>
  );
}
