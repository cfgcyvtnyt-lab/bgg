import { useRef } from "react";
import { INDEX_GROUPS } from "../utils/collectionSort";

interface Props {
  activeGroups: Set<string>;
  onJump: (group: string) => void;
}

// BGStats처럼 화면 오른쪽에 세로로 붙는 초성/알파벳 인덱스. 탭/드래그로 해당 그룹의 첫 항목까지 스크롤한다.
export default function AlphaIndex({ activeGroups, onJump }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const lastGroup = useRef<string | null>(null);

  function jumpFromPoint(clientX: number, clientY: number) {
    const el = document.elementFromPoint(clientX, clientY);
    const group = el?.closest<HTMLElement>("[data-idx-group]")?.dataset.idxGroup;
    if (group && group !== lastGroup.current) {
      lastGroup.current = group;
      onJump(group);
    }
  }

  return (
    <div
      ref={barRef}
      className="alpha-index"
      onTouchMove={(e) => {
        const t = e.touches[0];
        if (t) jumpFromPoint(t.clientX, t.clientY);
      }}
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (t) jumpFromPoint(t.clientX, t.clientY);
      }}
      onTouchEnd={() => { lastGroup.current = null; }}
    >
      {INDEX_GROUPS.map((g) => (
        <button
          key={g}
          type="button"
          data-idx-group={g}
          className={`alpha-index-item${activeGroups.has(g) ? "" : " alpha-index-item-dim"}`}
          onClick={() => onJump(g)}
        >
          {g}
        </button>
      ))}
    </div>
  );
}
