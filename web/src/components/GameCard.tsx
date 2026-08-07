import { Link } from "react-router-dom";
import type { CollectionListEntry } from "../api/types";
import { groupOf, sortDisplayValue } from "../utils/collectionSort";
import type { SortField } from "../utils/collectionSort";
import { imgUrl } from "../utils/imgUrl";

interface Props {
  entry: CollectionListEntry;
  view: "grid" | "list";
  // 현재 정렬 기준. 이름순이 아니면 카드에 그 기준값을 같이 보여준다.
  sortField?: SortField;
}

// 소유/방출 상태를 나타내는 작은 아이콘. BGStats의 초록색은 쓰지 않고 기존 테마(accent/muted) 색만 쓴다.
function StatusIcon({ status, wantToPlay }: { status: string | null; wantToPlay: number }) {
  let icon: string | null = null;
  let cls = "status-icon";
  if (status === "보유") { icon = "✓"; cls += " status-icon-owned"; }
  else if (status === "위시리스트") { icon = "♡"; cls += " status-icon-wish"; }
  else if (status === "선주문") { icon = "⏳"; cls += " status-icon-muted"; }
  // '방출 확정'은 '방출 예정'으로 통합했다 - 두 상태를 구분할 실익이 없었다.
  else if (status === "방출 예정") { icon = "👎"; cls += " status-icon-muted"; }
  else if (status === "방출 완료") { icon = "×"; cls += " status-icon-muted"; }

  return (
    <span className="status-icon-group" title={status || "미소유"}>
      {icon && <span className={cls}>{icon}</span>}
      {/* 위시리스트(하트)와 구분되도록 플레이 희망은 노란 재생 아이콘으로 표시한다 */}
      {wantToPlay === 1 && <span className="status-icon status-icon-want" title="플레이 희망">▶</span>}
    </span>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ko-KR");
}

// 컬렉션 화면의 게임 카드 하나. 그리드/목록 뷰를 공유한다.
export default function GameCard({ entry, view, sortField }: Props) {
  // 서버가 custom_image → thumbnail → image 순으로 이미 골라서 보낸다.
  // 예전엔 원본 image까지 같이 받아 여기서 폴백했는데, 245개 중 덕 보는 행이 0개면서
  // 목록 응답만 33KB 무거워졌다.
  const thumb = entry.thumbnail;
  const group = groupOf(entry.game_name);
  const sortInfo = sortField ? sortDisplayValue(entry, sortField) : null;

  return (
    <Link
      to={`/game/${entry.game_id}`}
      className={`game-card game-card-${view}`}
      id={`row-game-${entry.game_id}`}
      data-idx-group={group}
    >
      <div className="game-card-thumb">
        {thumb ? <img decoding="async" src={imgUrl(thumb)} alt="" /> : <div className="game-card-thumb-empty">?</div>}
      </div>
      {view === "list" ? (
        <div className="game-card-body">
          {/* 아이콘은 제목 줄, 플레이 수는 최근 플레이 줄. 둘 다 오른쪽 끝에 붙는다. */}
          <div className="game-card-row1">
            <span className="game-card-name">{entry.game_name}</span>
            <StatusIcon status={entry.status} wantToPlay={entry.want_to_play} />
          </div>
          <div className="game-card-row2">
            <span className="muted game-card-lastplay">
              {entry.last_played_at ? `최근 플레이: ${formatDate(entry.last_played_at)}` : "플레이 한 적 없음"}
            </span>
            <span className="muted game-card-playcount">
              {sortInfo ?? `${entry.play_count} 플레이`}
            </span>
          </div>
        </div>
      ) : (
        <div className="game-card-body">
          {/* 아이콘은 제목 바로 옆에 붙이고, 플레이 수만 그 아래 줄에 둔다 */}
          <div className="game-card-title-row">
            <span className="game-card-name">{entry.game_name}</span>
            <StatusIcon status={entry.status} wantToPlay={entry.want_to_play} />
          </div>
          <div className="game-card-meta">
            <span className="game-card-plays">{sortInfo ?? `플레이 ${entry.play_count}회`}</span>
          </div>
        </div>
      )}
    </Link>
  );
}
