import { useRef, useState } from "react";
import { api } from "../api/client";
import type { Photo } from "../api/types";
import "../styles/PhotoSlider.css";

// 인스타그램 스타일 사진 슬라이더. 라이브러리 없이 CSS scroll-snap으로만 구현한다.
export default function PhotoSlider({ photos }: { photos: Photo[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);

  if (photos.length === 0) return null;

  function onScroll() {
    const el = trackRef.current;
    if (!el) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    setActive(Math.max(0, Math.min(photos.length - 1, idx)));
  }

  return (
    <div className="photo-slider">
      <div className="photo-slider-track" ref={trackRef} onScroll={onScroll}>
        {photos.map((p, i) => (
          <div className="photo-slider-slide" key={p.id}>
            <img
              src={api.photoUrl(p.filename)}
              alt={p.caption || "플레이 사진"}
              onClick={() => setZoomIndex(i)}
            />
          </div>
        ))}
      </div>
      {photos.length > 1 && (
        <div className="photo-slider-dots">
          {photos.map((p, i) => (
            <span key={p.id} className={`photo-slider-dot${i === active ? " active" : ""}`} />
          ))}
        </div>
      )}
      {zoomIndex != null && (
        <div className="photo-lightbox" onClick={() => setZoomIndex(null)}>
          <button className="photo-lightbox-close" onClick={() => setZoomIndex(null)} aria-label="닫기">✕</button>
          <img src={api.photoUrl(photos[zoomIndex].filename)} alt={photos[zoomIndex].caption || "플레이 사진"} />
        </div>
      )}
    </div>
  );
}
