// Small canvas helpers: keep stored/sent images light, and crop avatars out of full-body portraits.
function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read image'));
    i.src = src;
  });
}

/** Scale so the longest side is at most `max`, re-encoded as JPEG (keeps requests and storage small). */
export async function downscale(src: string, max = 768, quality = 0.88): Promise<string> {
  try {
    const img = await loadImg(src);
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  } catch { return src; }
}

/**
 * Square avatar. For tall (full-body) portraits this crops the head-and-shoulders area at the top centre;
 * for other shapes it takes the centre square.
 */
export async function makeAvatar(src: string, size = 128): Promise<string | undefined> {
  try {
    const img = await loadImg(src);
    const w = img.naturalWidth, h = img.naturalHeight;
    const tall = h >= w * 1.2;
    const side = tall ? Math.round(w * 0.55) : Math.min(w, h);
    const sx = Math.round((w - side) / 2);
    const sy = tall ? Math.round(h * 0.01) : Math.round((h - side) / 2);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d')!.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.85);
  } catch { return undefined; }
}
