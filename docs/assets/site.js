// 產品網站的小互動：首屏的錄影計時、介紹影片、指令的複製按鈕、安裝步驟的系統切換、捲動時的進場和示意動畫、臉部優先的左右拖拉。
// 沒有 JavaScript 也能正常看：動畫的最後一格就是沒有 JavaScript 時看到的樣子。

const root = document.documentElement;
const motion = root.classList.contains('motion'); // <head> 裡判斷過「減少動態效果」

const timecode = document.querySelector('[data-timecode]');
if (timecode && motion) {
  const startedAt = Date.now() - (12 * 60 + 34) * 1000; // 從 00:12:34 開始走
  const pad = (n) => String(n).padStart(2, '0');
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    timecode.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  };
  tick();
  setInterval(tick, 1000);
}

// 介紹影片：點了封面才載入 YouTube 的播放器；按著 ⌘／Ctrl／Shift 點的，照原本的連結去 YouTube
for (const poster of document.querySelectorAll('[data-youtube]')) {
  poster.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${poster.dataset.youtube}?autoplay=1&rel=0`;
    frame.title = poster.dataset.title;
    frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin'; // YouTube 要知道是哪個網站嵌入的，不然播不了
    poster.replaceWith(frame);
    frame.focus();
  });
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

// 安裝步驟預設是 macOS，用 Windows 看的話先切到 Windows
if ((navigator.userAgentData?.platform ?? navigator.platform ?? '').startsWith('Win')) {
  for (const input of document.querySelectorAll('.os-switch input[value="win"]')) input.checked = true;
}

// 窄螢幕的選單：點了連結、按 Esc 或點選單外面就收起來
const menu = document.querySelector('.nav-menu');
if (menu) {
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) menu.open = false;
  });
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary').focus();
  });
}

// 臉部優先的對比圖：拖拉或用方向鍵移動分隔線，動手之後就不再自動播
for (const wipe of document.querySelectorAll('.wipe')) {
  const input = wipe.querySelector('.wipe-input');
  input?.addEventListener('input', () => {
    wipe.classList.add('manual');
    wipe.style.setProperty('--pos', `${input.value}%`);
  });
}

// 數字從 data-count-from 數到原本寫的數字，小數位數跟原本的一樣
const countUp = (el) => {
  for (const num of el.querySelectorAll('[data-count-from]')) {
    const text = num.dataset.to ?? (num.dataset.to = num.textContent);
    const decimals = (text.split('.')[1] || '').length;
    const to = Number(text);
    const from = Number(num.dataset.countFrom);
    const delay = Number(num.dataset.countDelay || 0) * 1000;
    const duration = Number(num.dataset.countDur || 1) * 1000;
    const startAt = performance.now() + delay;
    num.textContent = from.toFixed(decimals);
    const step = (now) => {
      const p = Math.min(1, Math.max(0, (now - startAt) / duration));
      num.textContent = (from + (to - from) * (1 - (1 - p) ** 3)).toFixed(decimals);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
};

if (motion && 'IntersectionObserver' in window) {
  const play = (el) => {
    el.classList.add('is-playing');
    countUp(el);
  };
  // 先一次量完位置再改樣式，避免瀏覽器反覆重排
  const reveals = [...document.querySelectorAll('.reveal')];
  const vizzes = [...document.querySelectorAll('.viz')];
  const topOf = (el) => el.getBoundingClientRect().top;
  const revealTops = reveals.map(topOf);
  const vizTops = vizzes.map(topOf);

  // 進場：同一層的元素依序出現
  const reveal = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      reveal.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -6% 0px' });
  reveals.forEach((el, i) => {
    const siblings = [...el.parentElement.children].filter((c) => c.classList.contains('reveal'));
    el.style.setProperty('--i', Math.min(siblings.indexOf(el), 5));
    if (revealTops[i] < innerHeight) el.classList.add('is-in');
    else reveal.observe(el);
  });

  // 示意動畫：大部分露出來才開始播，播一次
  const viz = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      play(e.target);
      viz.unobserve(e.target);
    }
  }, { threshold: 0.45 });
  vizzes.forEach((el, i) => {
    if (vizTops[i] < innerHeight * 0.6) play(el);
    else viz.observe(el);
  });

  // 一直循環的動畫，捲出畫面就暫停
  const loops = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.classList.toggle('is-visible', e.isIntersecting);
  });
  for (const el of document.querySelectorAll('.viz-loop')) loops.observe(el);

  for (const button of document.querySelectorAll('.viz-replay')) {
    button.addEventListener('click', () => {
      const scope = button.closest('.viz-group, .viz');
      const targets = scope.matches('.viz') ? [scope] : [...scope.querySelectorAll('.viz')];
      for (const el of targets) {
        el.classList.remove('is-playing', 'manual');
        el.style.removeProperty('--pos');
        const input = el.querySelector('.wipe-input');
        if (input) input.value = 50;
      }
      void scope.offsetWidth; // 讓瀏覽器先回到第一格，動畫才會重新開始
      for (const el of targets) play(el);
    });
  }

  root.classList.add('io');
}
