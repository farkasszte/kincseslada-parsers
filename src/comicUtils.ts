export interface SplitResult {
  pages: { blob: Blob; url: string }[];
  cleanup: () => void;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function splitLandscapeImage(url: string, rightToLeft = false): Promise<SplitResult> {
  const img = await loadImage(url);
  const { width, height } = img;

  if (width <= height) {
    return { pages: [], cleanup: () => {} };
  }

  const halfWidth = Math.floor(width / 2);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  const halves: { blob: Blob; url: string }[] = [];
  const urlsToRevoke: string[] = [];

  const indices = rightToLeft ? [1, 0] : [0, 1];
  for (const idx of indices) {
    const x = idx === 0 ? 0 : halfWidth;
    canvas.width = idx === 0 ? halfWidth : width - halfWidth;
    canvas.height = height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, x, 0, canvas.width, height, 0, 0, canvas.width, height);

    const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/png'));
    const blobUrl = URL.createObjectURL(blob);
    halves.push({ blob, url: blobUrl });
    urlsToRevoke.push(blobUrl);
  }

  return {
    pages: halves,
    cleanup: () => { for (const u of urlsToRevoke) URL.revokeObjectURL(u); },
  };
}

export async function processComicPages(
  pages: { index: number; name: string; url: string }[],
  options?: { splitLandscape?: boolean; rightToLeft?: boolean }
): Promise<{ pages: { index: number; name: string; url: string }[]; cleanup: () => void }> {
  if (!options?.splitLandscape) {
    return { pages, cleanup: () => {} };
  }

  const result: { index: number; name: string; url: string }[] = [];
  const cleanups: (() => void)[] = [];

  for (const page of pages) {
    try {
      const split = await splitLandscapeImage(page.url, options.rightToLeft);
      if (split.pages.length === 0) {
        result.push(page);
      } else {
        result.push({
          index: result.length,
          name: `${page.name.replace(/\.[^.]+$/, '')}_1.png`,
          url: split.pages[0].url,
        });
        result.push({
          index: result.length,
          name: `${page.name.replace(/\.[^.]+$/, '')}_2.png`,
          url: split.pages[1].url,
        });
        cleanups.push(split.cleanup);
      }
    } catch {
      result.push(page);
    }
  }

  return {
    pages: result,
    cleanup: () => { for (const c of cleanups) c(); },
  };
}
