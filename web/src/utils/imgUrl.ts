// BGG 이미지를 서버 디스크 캐시 프록시(/api/image)로 우회시킨다.
// 서버가 cf.geekdo-images.com만 허용하므로 다른 호스트 값이면 그대로 통과시킨다.
export function imgUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (!url.includes("cf.geekdo-images.com")) return url;
  return `/api/image?url=${encodeURIComponent(url)}`;
}
