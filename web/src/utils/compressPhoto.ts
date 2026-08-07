// 업로드 전에 사진을 브라우저에서 축소한다. 폰 사진은 4000px·수 MB인데
// 화면에는 길어야 화면 폭(~620px), 라이트박스 확대까지 쳐도 1600px이면 충분하다.
// 서버는 의존성 없이 가는 원칙(sharp 안 씀)이라 리사이즈를 이쪽에서 한다.
const MAX_EDGE = 1600;
// webp가 같은 화질에 jpeg의 절반 정도다(실측 1600x1200 사진 82KB vs 150KB).
const WEBP_QUALITY = 0.82;
const JPEG_QUALITY = 0.85;
// 이미 충분히 작은 파일은 재인코딩해봐야 화질만 잃는다
const SKIP_BYTES = 500 * 1024;

function encode(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function compressPhoto(file: File): Promise<File> {
  if (file.size <= SKIP_BYTES) return file;
  try {
    // from-image: EXIF 회전을 픽셀에 구워 넣는다 - 캔버스를 거치면 EXIF가 사라지므로 필수
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    // webp를 먼저 시도한다. toBlob은 못 만드는 포맷을 요청하면 조용히 png로 떨어뜨리는데
    // 사진을 png로 만들면 원본보다 커진다. 그래서 결과 type을 반드시 확인하고 jpeg로 물러선다.
    // (iOS 사파리는 16.4부터 webp 인코딩을 지원한다)
    let blob = await encode(canvas, "image/webp", WEBP_QUALITY);
    let ext = ".webp";
    if (blob?.type !== "image/webp") {
      blob = await encode(canvas, "image/jpeg", JPEG_QUALITY);
      ext = ".jpg";
    }

    // 인코딩 실패나, 원본이 이미 최적화돼 있어 오히려 커지는 경우엔 원본을 올린다
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ext;
    return new File([blob], name, { type: blob.type });
  } catch {
    // heic처럼 브라우저가 못 여는 포맷은 원본 그대로 - 서버가 20MB까지는 받아준다
    return file;
  }
}
