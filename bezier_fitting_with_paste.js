const canvas = document.getElementById('c');
const bgCanvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d');
const bgCtx = bgCanvas.getContext('2d');
const W = 660, H = 360;
const BEZIER_STORAGE_KEY = 'bezier_fit:last_control_points';
let pts = [], drawing = false, bgImage = null, bgOpacity = 0.35;

function syncSize() {
  const wrap = document.getElementById('wrap');
  const w = wrap.offsetWidth;
  bgCanvas.style.width = w + 'px';
  bgCanvas.style.height = (w * H / W) + 'px';
}
syncSize();
window.addEventListener('resize', syncSize);

function getPos(e) {
  const r = canvas.getBoundingClientRect();
  const sx = W / r.width, sy = H / r.height;
  if (e.touches) return { x: (e.touches[0].clientX - r.left) * sx, y: (e.touches[0].clientY - r.top) * sy };
  return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
}

canvas.addEventListener('mousedown', e => { drawing = true; pts = [getPos(e)]; render(); });
canvas.addEventListener('mousemove', e => { if (!drawing) return; pts.push(getPos(e)); render(); });
canvas.addEventListener('mouseup', () => { drawing = false; refit(); });
canvas.addEventListener('mouseleave', () => { if (drawing) { drawing = false; refit(); } });
canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; pts = [getPos(e)]; render(); }, { passive: false });
canvas.addEventListener('touchmove', e => { e.preventDefault(); if (!drawing) return; pts.push(getPos(e)); render(); }, { passive: false });
canvas.addEventListener('touchend', () => { drawing = false; refit(); });

document.addEventListener('paste', e => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        bgImage = img;
        renderBg();
        showToast('클립보드에서 이미지를 붙여넣었습니다');
        URL.revokeObjectURL(url);
      };
      img.src = url;
      break;
    }
  }
});

async function pasteImage() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find(t => t.startsWith('image/'));
      if (imgType) {
        const blob = await item.getType(imgType);
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          bgImage = img;
          renderBg();
          showToast('밑그림을 불러왔습니다');
          URL.revokeObjectURL(url);
        };
        img.src = url;
        return;
      }
    }
    showToast('클립보드에 이미지가 없습니다');
  } catch (err) {
    showToast('Ctrl+V 로 직접 붙여넣기 해보세요');
  }
}

function renderBg() {
  bgCtx.clearRect(0, 0, W, H);
  if (!bgImage) return;
  bgCtx.globalAlpha = bgOpacity;
  const scale = Math.min(W / bgImage.width, H / bgImage.height);
  const dw = bgImage.width * scale, dh = bgImage.height * scale;
  const dx = (W - dw) / 2, dy = (H - dh) / 2;
  bgCtx.drawImage(bgImage, dx, dy, dw, dh);
  bgCtx.globalAlpha = 1;
}

function setBgOpacity(v) {
  bgOpacity = v / 100;
  document.getElementById('opacity-val').textContent = v + '%';
  renderBg();
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

function isPointLike(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function isBezierControlPoints(cp) {
  return !!cp && isPointLike(cp.P0) && isPointLike(cp.P1) && isPointLike(cp.P2) && isPointLike(cp.P3);
}

function saveBezierToStorage(cp) {
  if (!isBezierControlPoints(cp)) return;
  try {
    localStorage.setItem(BEZIER_STORAGE_KEY, JSON.stringify(cp));
  } catch (err) {
    // localStorage is unavailable (privacy mode, quota, etc.)
  }
}

function loadBezierFromStorage() {
  try {
    const raw = localStorage.getItem(BEZIER_STORAGE_KEY);
    if (!raw) return null;
    const cp = JSON.parse(raw);
    return isBezierControlPoints(cp) ? cp : null;
  } catch (err) {
    return null;
  }
}

function removeBezierFromStorage() {
  try {
    localStorage.removeItem(BEZIER_STORAGE_KEY);
  } catch (err) {
    // ignore storage deletion failures
  }
}

function parameterize(points) {
  const d = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i-1].x, dy = points[i].y - points[i-1].y;
    d.push(d[i-1] + Math.sqrt(dx*dx + dy*dy));
  }
  const total = d[d.length-1] || 1;
  return d.map(v => v / total);
}

function B(i, t) {
  if (i === 0) return (1-t)**3;
  if (i === 1) return 3*(1-t)**2*t;
  if (i === 2) return 3*(1-t)*t**2;
  return t**3;
}

function fitBezier(points) {
  if (points.length < 3) return null;
  const n = points.length;
  const ts = parameterize(points);
  const P0 = points[0], P3 = points[n-1];
  let A00=0, A01=0, A11=0, Rx0=0, Ry0=0, Rx1=0, Ry1=0;
  for (let i = 0; i < n; i++) {
    const t = ts[i];
    const b0=B(0,t), b1=B(1,t), b2=B(2,t), b3=B(3,t);
    A00+=b1*b1; A01+=b1*b2; A11+=b2*b2;
    const qx = points[i].x - b0*P0.x - b3*P3.x;
    const qy = points[i].y - b0*P0.y - b3*P3.y;
    Rx0+=b1*qx; Ry0+=b1*qy; Rx1+=b2*qx; Ry1+=b2*qy;
  }
  const det = A00*A11 - A01*A01;
  if (Math.abs(det) < 1e-10) return null;
  return {
    P0, P3,
    P1: { x: (A11*Rx0 - A01*Rx1)/det, y: (A11*Ry0 - A01*Ry1)/det },
    P2: { x: (A00*Rx1 - A01*Rx0)/det, y: (A00*Ry1 - A01*Ry0)/det }
  };
}

function samplePoints() {
  const n = parseInt(document.getElementById('sld-n').value);
  if (pts.length < 2) return pts;
  const result = [];
  for (let i = 0; i <= n; i++) {
    const idx = Math.min(Math.round(i / n * (pts.length-1)), pts.length-1);
    result.push(pts[idx]);
  }
  return result;
}

function drawDot(p, color, r, label) {
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI*2);
  ctx.fillStyle = color; ctx.fill();
  if (label) {
    ctx.fillStyle = 'var(--color-text-primary)';
    ctx.font = '500 12px var(--font-sans)';
    ctx.fillText(label, p.x+8, p.y-8);
  }
}

function drawFittedBezier(cp) {
  ctx.beginPath();
  ctx.moveTo(cp.P0.x, cp.P0.y);
  ctx.lineTo(cp.P1.x, cp.P1.y);
  ctx.lineTo(cp.P2.x, cp.P2.y);
  ctx.lineTo(cp.P3.x, cp.P3.y);
  ctx.strokeStyle = '#22A07A';
  ctx.lineWidth = 1;
  ctx.setLineDash([5,4]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.moveTo(cp.P0.x, cp.P0.y);
  ctx.bezierCurveTo(cp.P1.x, cp.P1.y, cp.P2.x, cp.P2.y, cp.P3.x, cp.P3.y);
  ctx.strokeStyle = '#E26B2C';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  drawDot(cp.P0, '#6B7FD4', 6, 'P0');
  drawDot(cp.P1, '#22A07A', 6, 'P1');
  drawDot(cp.P2, '#22A07A', 6, 'P2');
  drawDot(cp.P3, '#6B7FD4', 6, 'P3');
}

function updateControlPointInfo(cp) {
  const fmt = p => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
  document.getElementById('p0-val').textContent = fmt(cp.P0);
  document.getElementById('p1-val').textContent = fmt(cp.P1);
  document.getElementById('p2-val').textContent = fmt(cp.P2);
  document.getElementById('p3-val').textContent = fmt(cp.P3);
}

function render() {
  const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
  ctx.clearRect(0, 0, W, H);
  if (pts.length === 0) {
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)';
    ctx.fillRect(0, 0, W, H);
    if (!bgImage) {
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
      ctx.font = '14px var(--font-sans)';
      ctx.textAlign = 'center';
      ctx.fillText('밑그림을 붙여넣은 후 그 위에 곡선을 그려보세요', W/2, H/2);
      ctx.textAlign = 'left';
    }
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = '#6B7FD4';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function refit() {
  render();
  if (pts.length < 4) return;
  const sampled = samplePoints();
  const cp = fitBezier(sampled);
  if (!cp) return;

  drawFittedBezier(cp);
  updateControlPointInfo(cp);
  saveBezierToStorage(cp);

  let err = 0;
  const ts2 = parameterize(sampled);
  for (let i = 0; i < sampled.length; i++) {
    const t = ts2[i];
    const bx = B(0,t)*cp.P0.x + B(1,t)*cp.P1.x + B(2,t)*cp.P2.x + B(3,t)*cp.P3.x;
    const by = B(0,t)*cp.P0.y + B(1,t)*cp.P1.y + B(2,t)*cp.P2.y + B(3,t)*cp.P3.y;
    const dx = sampled[i].x - bx, dy = sampled[i].y - by;
    err += Math.sqrt(dx*dx+dy*dy);
  }
  document.getElementById('err-box').textContent = `평균 피팅 오차: ${(err/sampled.length).toFixed(1)}px`;
}

function clearDrawing() {
  pts = [];
  render();
  ['p0-val','p1-val','p2-val','p3-val'].forEach(id => document.getElementById(id).textContent = '—');
  document.getElementById('err-box').textContent = '';
}

function clearAll() {
  bgImage = null;
  bgCtx.clearRect(0, 0, W, H);
  removeBezierFromStorage();
  clearDrawing();
}

function clearStoredBezier() {
  removeBezierFromStorage();
  showToast('저장된 좌표를 삭제했습니다');
}

render();
const savedCp = loadBezierFromStorage();
if (savedCp) {
  drawFittedBezier(savedCp);
  updateControlPointInfo(savedCp);
}
