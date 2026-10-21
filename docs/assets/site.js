// 產品網站的小互動：首屏的錄影計時跟著走、指令的複製按鈕。沒有 JavaScript 也能正常看。

const timecode = document.querySelector('[data-timecode]');
if (timecode && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const startedAt = Date.now() - (12 * 60 + 34) * 1000; // 從 00:12:34 開始走
  const pad = (n) => String(n).padStart(2, '0');
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    timecode.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  };
  tick();
  setInterval(tick, 1000);
}

for (const block of document.querySelectorAll('.code')) {
  const button = block.querySelector('button');
  const pre = block.querySelector('pre');
  if (!button || !pre) continue;
  const label = button.textContent;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent.trim());
      button.textContent = button.dataset.done;
    } catch {
      button.textContent = button.dataset.fail;
    }
    setTimeout(() => (button.textContent = label), 1600);
  });
}
