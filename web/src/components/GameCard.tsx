import { Link } from "react-router-dom";
import type { CollectionListEntry } from "../api/types";
import { groupOf } from "../utils/collectionSort";
import { imgUrl } from "../utils/imgUrl";

interface Props {
  entry: CollectionListEntry;
  view: "grid" | "list";
}

// 소유/방출 상태를 나타내는 작은 아이콘. BGStats의 초록색은 쓰지 않고 기존 테마(accent/muted) 색만 쓴다.
function StatusIcon({ status, wantToPlay }: { status: string | null; wantToPlay: number }) {
  let icon: string | null = null;
  let cls = "status-icon";
  if (status === "보유") { icon = "✓"; cls += " status-icon-owned"; }
  else if (status === "위시리스트") { icon = "♡"; cls += " status-icon-wish"; }
  else if (status === "선주문") { icon = "⏳"; cls += " status-icon-muted"; }
  else if (status === "방출 예정") { icon = "▽"; cls += " status-icon-muted"; }
  else if (status === "방출 확정") { icon = "◇"; cls += " status-icon-muted"; }
  else if (status === "방출 완료") { icon = "×"; cls += " status-icon-muted"; }

  return (
    <span className="status-icon-group" title={status || "미소유"}>
      {icon && <span className={cls}>{icon}</span>}
      {wantToPlay === 1 && <span className="status-icon status-icon-want" title="플레이 희망">★</span>}
    </span>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ko-KR");
}

// 컬렉션 화면의 게임 카드 하나. 그리드/목록 뷰를 공유한다.
export default function GameCard({ entry, view }: Props) {
  const thumb = entry.thumbnail || entry.image;
  const group = groupOf(entry.game_name);

  return (
    <Link
      to={`/game/${entry.game_id}`}
      className={`game-card game-card-${view}`}
      id={`row-game-${entry.game_id}`}
      data-idx-group={group}
    >
      <div className="game-card-thumb">
        {thumb ? <img src={imgUrl(thumb)} alt="" loading="lazy" /> : <div className="game-card-thumb-empty">?</div>}
      </div>
      {view === "list" ? (
        <div className="game-card-body">
          <div className="game-card-name">{entry.game_name}</div>
          <div className="game-card-row2">
            <span className="muted game-card-lastplay">
              {entry.last_played_at ? `최근 플레이: ${formatDate(entry.last_played_at)}` : "플레이 한 적 없음"}
            </span>
            <span className="muted game-card-playcount">{entry.play_count} 플레이</span>
            <StatusIcon status={entry.status} wantToPlay={entry.want_to_play} />
            <span className="game-card-chevron muted">›</span>
          </div>
        </div>
      ) : (
        <div className="game-card-body">
          <div className="game-card-name">{entry.game_name}</div>
          <div className="game-card-meta">
            <span className="game-card-plays">플레이 {entry.play_count}회</span>
            <div className="game-card-meta-row">
              <StatusIcon status={entry.status} wantToPlay={entry.want_to_play} />
              {entry.my_rating != null && (
                <span className="game-card-rating">★ {Math.round(entry.my_rating * 10) / 10}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </Link>
  );
}
