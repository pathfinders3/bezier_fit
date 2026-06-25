const canvas = document.getElementById('c');
const bgCanvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d');
const bgCtx = bgCanvas.getContext('2d');
const W = 660, H = 360;
const BEZIER_STORAGE_KEY = 'bezier_fit:last_control_points';
const BG_IMAGE_STORAGE_KEY = 'bezier_fit:last_background_image';
let bgImage = null, bgOpacity = 0.35;
let showControlPoints = true;
let isDrawMode = true;
let bezierSlots = [];
let activeBezierIndex = 0;
let selectedBezierIndices = [0];
let mergedControlPointsCount = 0;
let linkedHandleState = null;
let currentBezier = null, originalBezier = null, currentScale = 1;
let dragState = { active: false, handle: null, startX: 0, startY: 0 };

function updateCanvasCursor() {
  canvas.style.cursor = isDrawMode ? 'crosshair' : 'default';
}

function toggleDrawMode(checked) {
  isDrawMode = !!checked;
  const slot = getActiveSlot();
  slot.drawing = false;
  dragState.active = false;
  dragState.handle = null;
  updateCanvasCursor();
  showToast(isDrawMode ? '직접 그리기 모드' : '베지어 편집 모드');
}

function createBezierSlot() {
  return { pts: [], drawing: false, bezier: null, originalBezier: null, scale: 1, errText: '' };
}

function ensureBezierSlots() {
  if (bezierSlots.length === 0) {
    bezierSlots = [createBezierSlot()];
    activeBezierIndex = 0;
    selectedBezierIndices = [0];
    mergedControlPointsCount = 0;
    linkedHandleState = null;
  }
  return bezierSlots;
}

function getActiveSlot() {
  ensureBezierSlots();
  return bezierSlots[activeBezierIndex] || bezierSlots[0];
}

function syncActiveBezierState() {
  const slot = getActiveSlot();
  currentBezier = slot.bezier;
  originalBezier = slot.originalBezier;
  currentScale = slot.scale;
}

function normalizeSelectedBezierIndices() {
  selectedBezierIndices = selectedBezierIndices
    .filter(i => Number.isInteger(i) && i >= 0 && i < bezierSlots.length)
    .slice(0, 2);

  if (!selectedBezierIndices.includes(activeBezierIndex)) {
    selectedBezierIndices = [activeBezierIndex, ...selectedBezierIndices].slice(0, 2);
  }
}

function setMergedControlPointsState(value) {
  mergedControlPointsCount = Math.max(0, Number(value) || 0);
}

function setLinkedHandleState(slotIndex, handleName, otherSlotIndex, otherHandleName) {
  linkedHandleState = {
    slotIndex,
    handleName,
    otherSlotIndex,
    otherHandleName
  };
}

function selectBezierSlot(index, additive = false) {
  if (isDrawMode) {
    showToast('직접 그리기 모드에서는 베지어 선택을 사용할 수 없습니다');
    return;
  }
  ensureBezierSlots();
  if (index < 0 || index >= bezierSlots.length) return;
  if (additive) {
    selectedBezierIndices = [...new Set([...selectedBezierIndices, index])].slice(-2);
  } else {
    selectedBezierIndices = [index];
  }
  setMergedControlPointsState(0);
  activeBezierIndex = index;
  normalizeSelectedBezierIndices();
  syncActiveBezierState();
  refreshBezierButtons();
  render();
  updateControlPointInfo(currentBezier);
}

function getCurveHitSlot(x, y) {
  const threshold = 10;
  for (let i = 0; i < bezierSlots.length; i++) {
    const slot = bezierSlots[i];
    if (!slot.bezier) continue;
    const sampled = sampleBezierByDistance(slot.bezier, 4);
    let minDist = Infinity;
    for (const p of sampled) {
      const dx = p.x - x;
      const dy = p.y - y;
      const dist = Math.hypot(dx, dy);
      if (dist < minDist) minDist = dist;
    }
    if (minDist <= threshold) return i;
  }
  return -1;
}

function getControlHandleAtPoint(slot, x, y) {
  if (!slot || !slot.bezier) return null;
  const handles = [
    ['P0', slot.bezier.P0],
    ['P1', slot.bezier.P1],
    ['P2', slot.bezier.P2],
    ['P3', slot.bezier.P3]
  ];
  const threshold = 8;
  for (const [name, pt] of handles) {
    const dx = pt.x - x;
    const dy = pt.y - y;
    if (Math.hypot(dx, dy) <= threshold) return name;
  }
  return null;
}

function selectBezierAtPoint(x, y, additive = false) {
  const hitIndex = getCurveHitSlot(x, y);
  if (hitIndex >= 0) {
    selectBezierSlot(hitIndex, additive);
    return true;
  }
  return false;
}

function moveSelectedBezier(dx, dy) {
  const targets = selectedBezierIndices.length > 0 ? selectedBezierIndices : [activeBezierIndex];
  let movedAny = false;

  for (const index of targets) {
    const slot = bezierSlots[index];
    if (!slot || !slot.bezier) continue;
    const moved = {
      P0: { x: slot.bezier.P0.x + dx, y: slot.bezier.P0.y + dy },
      P1: { x: slot.bezier.P1.x + dx, y: slot.bezier.P1.y + dy },
      P2: { x: slot.bezier.P2.x + dx, y: slot.bezier.P2.y + dy },
      P3: { x: slot.bezier.P3.x + dx, y: slot.bezier.P3.y + dy }
    };
    slot.bezier = moved;
    slot.originalBezier = cloneBezier(moved);
    slot.scale = 1;
    movedAny = true;
  }

  if (!movedAny) return false;
  syncActiveBezierState();
  render();
  drawFittedBezier(currentBezier, true);
  updateControlPointInfo(currentBezier);
  saveBezierToStorage();
  return true;
}

function updateDraggedHandle(slot, handleName, dx, dy) {
  const nextBezier = { ...slot.bezier };
  const movedPoint = {
    x: slot.bezier[handleName].x + dx,
    y: slot.bezier[handleName].y + dy
  };
  nextBezier[handleName] = movedPoint;

  if (mergedControlPointsCount > 0 && ['P0', 'P3'].includes(handleName)) {
    const slotIndex = bezierSlots.findIndex(candidate => candidate === slot);
    const isLinkedHandle = linkedHandleState && linkedHandleState.slotIndex === slotIndex && linkedHandleState.handleName === handleName;
    const isLinkedOtherHandle = linkedHandleState && linkedHandleState.otherSlotIndex === slotIndex && linkedHandleState.otherHandleName === handleName;

    if (isLinkedHandle || isLinkedOtherHandle) {
      const otherSlotIndex = isLinkedHandle ? linkedHandleState.otherSlotIndex : linkedHandleState.slotIndex;
      const otherHandleName = isLinkedHandle ? linkedHandleState.otherHandleName : linkedHandleState.handleName;
      const otherSlot = bezierSlots[otherSlotIndex];
      if (otherSlot && otherSlot.bezier) {
        const otherNextBezier = { ...otherSlot.bezier };
        otherNextBezier[otherHandleName] = {
          x: otherSlot.bezier[otherHandleName].x + dx,
          y: otherSlot.bezier[otherHandleName].y + dy
        };
        otherSlot.bezier = otherNextBezier;
        otherSlot.originalBezier = cloneBezier(otherNextBezier);
        otherSlot.scale = 1;
      }
    }
  }

  slot.bezier = nextBezier;
  if (['P0', 'P3'].includes(handleName)) {
    syncMatchingEndpoints(handleName, slot, nextBezier);
  }
  slot.originalBezier = cloneBezier(nextBezier);
  slot.scale = 1;
  return nextBezier;
}

function syncMatchingEndpoints(handleName, activeSlot, nextBezier) {
  if (bezierSlots.length < 2 || !activeSlot || !activeSlot.bezier) return;
  const otherSlot = bezierSlots.find(slot => slot !== activeSlot);
  if (!otherSlot || !otherSlot.bezier) return;
  const isStartPoint = handleName === 'P0';
  const isEndPoint = handleName === 'P3';
  if (!isStartPoint && !isEndPoint) return;

  const activeHandle = activeSlot.bezier[handleName];
  const candidateHandles = ['P0', 'P3'];
  const matchedHandle = candidateHandles
    .map(candidateName => ({
      name: candidateName,
      dist: Math.hypot(activeHandle.x - otherSlot.bezier[candidateName].x, activeHandle.y - otherSlot.bezier[candidateName].y)
    }))
    .sort((a, b) => a.dist - b.dist)[0];

  if (matchedHandle && matchedHandle.dist <= 8) {
    const otherHandleName = matchedHandle.name;
    nextBezier[handleName] = { x: otherSlot.bezier[otherHandleName].x, y: otherSlot.bezier[otherHandleName].y };
    setMergedControlPointsState(mergedControlPointsCount + 1);
    if (bezierSlots.length > 1) {
      const otherSlotIndex = bezierSlots.findIndex(slot => slot === otherSlot);
      selectedBezierIndices = [...new Set([activeBezierIndex, otherSlotIndex])].slice(-2);
      normalizeSelectedBezierIndices();
      setLinkedHandleState(activeBezierIndex, handleName, otherSlotIndex, otherHandleName);
      refreshBezierButtons();
      render();
    }
  }
}

function refreshBezierButtons() {
  const btn1 = document.getElementById('btn-bezier-1');
  const btn2 = document.getElementById('btn-bezier-2');
  if (!btn1 || !btn2) return;
  normalizeSelectedBezierIndices();
  btn1.classList.toggle('active', activeBezierIndex === 0);
  btn2.classList.toggle('active', activeBezierIndex === 1);
  btn1.classList.toggle('selected', selectedBezierIndices.includes(0));
  btn2.classList.toggle('selected', selectedBezierIndices.includes(1));
  btn2.style.display = bezierSlots.length > 1 ? 'inline-block' : 'none';
}

function releaseMergedControlPoints() {
  if (mergedControlPointsCount <= 0) return false;

  const activeSlot = getActiveSlot();
  if (activeSlot && activeSlot.bezier && linkedHandleState) {
    const handleName = linkedHandleState.slotIndex === activeBezierIndex ? linkedHandleState.handleName : linkedHandleState.otherHandleName;
    const nextBezier = { ...activeSlot.bezier };
    nextBezier[handleName] = {
      x: activeSlot.bezier[handleName].x - 20,
      y: activeSlot.bezier[handleName].y
    };
    activeSlot.bezier = nextBezier;
    activeSlot.originalBezier = cloneBezier(nextBezier);
    activeSlot.scale = 1;
  }

  setMergedControlPointsState(0);
  linkedHandleState = null;
  refreshBezierButtons();
  render();
  if (currentBezier) {
    drawFittedBezier(currentBezier, true);
    updateControlPointInfo(currentBezier);
  }
  saveBezierToStorage();
  return true;
}

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

canvas.addEventListener('mousedown', e => {
  const pos = getPos(e);
  const slot = getActiveSlot();

  if (isDrawMode) {
    slot.drawing = true;
    slot.pts = [pos];
    render();
    return;
  }

  // Shift+click is reserved for multi-selecting up to two curves.
  if (e.shiftKey && selectBezierAtPoint(pos.x, pos.y, true)) {
    return;
  }

  const handle = getControlHandleAtPoint(slot, pos.x, pos.y);
  if (handle) {
    dragState.active = true;
    dragState.handle = handle;
    dragState.startX = pos.x;
    dragState.startY = pos.y;
    return;
  }
  if (selectBezierAtPoint(pos.x, pos.y, e.shiftKey)) {
    return;
  }
});
canvas.addEventListener('mousemove', e => {
  const slot = getActiveSlot();
  const pos = getPos(e);
  if (isDrawMode) {
    if (!slot.drawing) return;
    slot.pts.push(pos);
    render();
    return;
  }
  if (dragState.active && slot.bezier) {
    const dx = pos.x - dragState.startX;
    const dy = pos.y - dragState.startY;
    updateDraggedHandle(slot, dragState.handle, dx, dy);
    syncActiveBezierState();
    dragState.startX = pos.x;
    dragState.startY = pos.y;
    render();
    drawFittedBezier(currentBezier, true);
    updateControlPointInfo(currentBezier);
    saveBezierToStorage();
    return;
  }
});
canvas.addEventListener('mouseup', () => {
  const slot = getActiveSlot();
  dragState.active = false;
  dragState.handle = null;
  if (isDrawMode && slot.drawing) {
    slot.drawing = false;
    refit();
  }
});
canvas.addEventListener('mouseleave', () => {
  const slot = getActiveSlot();
  if (dragState.active) {
    dragState.active = false;
    dragState.handle = null;
  }
  if (slot.drawing) {
    slot.drawing = false;
    if (isDrawMode) refit();
  }
});
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  const pos = getPos(e);
  const slot = getActiveSlot();
  if (isDrawMode) {
    slot.drawing = true;
    slot.pts = [pos];
    render();
    return;
  }
  const handle = getControlHandleAtPoint(slot, pos.x, pos.y);
  if (handle) {
    dragState.active = true;
    dragState.handle = handle;
    dragState.startX = pos.x;
    dragState.startY = pos.y;
    return;
  }
  if (selectBezierAtPoint(pos.x, pos.y)) {
    return;
  }
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  const slot = getActiveSlot();
  const pos = getPos(e);
  if (isDrawMode) {
    if (!slot.drawing) return;
    slot.pts.push(pos);
    render();
    return;
  }
  if (dragState.active && slot.bezier) {
    const dx = pos.x - dragState.startX;
    const dy = pos.y - dragState.startY;
    updateDraggedHandle(slot, dragState.handle, dx, dy);
    syncActiveBezierState();
    dragState.startX = pos.x;
    dragState.startY = pos.y;
    render();
    drawFittedBezier(currentBezier, true);
    updateControlPointInfo(currentBezier);
    saveBezierToStorage();
    return;
  }
}, { passive: false });
canvas.addEventListener('touchend', () => {
  const slot = getActiveSlot();
  dragState.active = false;
  dragState.handle = null;
  if (isDrawMode && slot.drawing) {
    slot.drawing = false;
    refit();
  }
});

window.addEventListener('keydown', e => {
  if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const key = e.key.toLowerCase();

  if (isDrawMode) return;

  if (key === 'tab' && mergedControlPointsCount > 0) {
    if (releaseMergedControlPoints()) e.preventDefault();
    return;
  }

  if (!['i', 'j', 'k', 'l'].includes(key)) return;
  const delta = e.shiftKey ? 10 : 5;
  let dx = 0, dy = 0;
  if (key === 'j') dx = -delta;
  else if (key === 'l') dx = delta;
  else if (key === 'i') dy = -delta;
  else if (key === 'k') dy = delta;
  if (moveSelectedBezier(dx, dy)) e.preventDefault();
});

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
        saveBackgroundFromBlob(blob);
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
          saveBackgroundFromBlob(blob);
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

function cloneBezier(cp) {
  return {
    P0: { x: cp.P0.x, y: cp.P0.y },
    P1: { x: cp.P1.x, y: cp.P1.y },
    P2: { x: cp.P2.x, y: cp.P2.y },
    P3: { x: cp.P3.x, y: cp.P3.y }
  };
}

function saveBezierToStorage() {
  try {
    const payload = {
      beziers: bezierSlots
        .filter(slot => isBezierControlPoints(slot.bezier))
        .map(slot => ({
          cp: cloneBezier(slot.bezier),
          originalBezier: isBezierControlPoints(slot.originalBezier) ? cloneBezier(slot.originalBezier) : cloneBezier(slot.bezier),
          scale: Number.isFinite(slot.scale) ? slot.scale : 1
        })),
      activeIndex: activeBezierIndex
    };
    localStorage.setItem(BEZIER_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    // localStorage is unavailable (privacy mode, quota, etc.)
  }
}

function loadBezierFromStorage() {
  try {
    const raw = localStorage.getItem(BEZIER_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.beziers)) {
      bezierSlots = parsed.beziers.map(item => {
        const slot = createBezierSlot();
        slot.bezier = isBezierControlPoints(item.cp) ? cloneBezier(item.cp) : null;
        slot.originalBezier = isBezierControlPoints(item.originalBezier) ? cloneBezier(item.originalBezier) : (slot.bezier ? cloneBezier(slot.bezier) : null);
        slot.scale = Number.isFinite(item.scale) ? item.scale : 1;
        return slot;
      });
      activeBezierIndex = Number.isInteger(parsed.activeIndex) && parsed.activeIndex < bezierSlots.length ? parsed.activeIndex : 0;
      selectedBezierIndices = [activeBezierIndex];
      syncActiveBezierState();
      refreshBezierButtons();
      return true;
    }
    if (isBezierControlPoints(parsed)) {
      bezierSlots = [createBezierSlot()];
      bezierSlots[0].bezier = cloneBezier(parsed);
      bezierSlots[0].originalBezier = cloneBezier(parsed);
      bezierSlots[0].scale = 1;
      activeBezierIndex = 0;
      selectedBezierIndices = [0];
      syncActiveBezierState();
      refreshBezierButtons();
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}

function removeBezierFromStorage() {
  try {
    localStorage.removeItem(BEZIER_STORAGE_KEY);
  } catch (err) {
    // ignore storage deletion failures
  }
}

function saveBackgroundDataUrl(dataUrl) {
  if (!dataUrl) return false;
  try {
    localStorage.setItem(BG_IMAGE_STORAGE_KEY, dataUrl);
    return true;
  } catch (err) {
    return false;
  }
}

function saveBackgroundFromBlob(blob) {
  if (!blob) return;
  const reader = new FileReader();
  reader.onload = () => {
    const ok = saveBackgroundDataUrl(typeof reader.result === 'string' ? reader.result : '');
    if (!ok) showToast('이미지가 커서 밑그림 저장에 실패했습니다');
  };
  reader.onerror = () => {
    // ignore read failures
  };
  reader.readAsDataURL(blob);
}

function loadBackgroundFromStorage() {
  try {
    const dataUrl = localStorage.getItem(BG_IMAGE_STORAGE_KEY);
    return dataUrl || null;
  } catch (err) {
    return null;
  }
}

function removeBackgroundFromStorage() {
  try {
    localStorage.removeItem(BG_IMAGE_STORAGE_KEY);
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

function samplePoints(points) {
  const n = parseInt(document.getElementById('sld-n').value);
  if (points.length < 2) return points;
  const result = [];
  for (let i = 0; i <= n; i++) {
    const idx = Math.min(Math.round(i / n * (points.length-1)), points.length-1);
    result.push(points[idx]);
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

function drawRawCurve(points, color = '#6B7FD4') {
  if (!points || points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawFittedBezier(cp, isActive = false, isSelected = false) {
  const slotIndex = bezierSlots.findIndex(slot => slot.bezier === cp);
  const resolvedSelected = isSelected || (slotIndex >= 0 && selectedBezierIndices.includes(slotIndex));
  ctx.beginPath();
  ctx.moveTo(cp.P0.x, cp.P0.y);
  ctx.bezierCurveTo(cp.P1.x, cp.P1.y, cp.P2.x, cp.P2.y, cp.P3.x, cp.P3.y);
  ctx.strokeStyle = resolvedSelected ? '#4F7CFF' : (isActive ? '#E26B2C' : '#C46A2D');
  ctx.lineWidth = resolvedSelected ? 2.5 : (isActive ? 2.5 : 2);
  ctx.stroke();

  if (!showControlPoints) return;

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

  drawDot(cp.P0, '#6B7FD4', 6, 'P0');
  drawDot(cp.P1, '#22A07A', 6, 'P1');
  drawDot(cp.P2, '#22A07A', 6, 'P2');
  drawDot(cp.P3, '#6B7FD4', 6, 'P3');
}

function toggleControlPoints(checked) {
  showControlPoints = !!checked;
  render();
  if (currentBezier) drawFittedBezier(currentBezier, true);
}

function updateControlPointInfo(cp) {
  const fmt = p => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
  if (!cp || !cp.P0 || !cp.P1 || !cp.P2 || !cp.P3) {
    ['p0-val','p1-val','p2-val','p3-val'].forEach(id => document.getElementById(id).textContent = '—');
    return;
  }
  document.getElementById('p0-val').textContent = fmt(cp.P0);
  document.getElementById('p1-val').textContent = fmt(cp.P1);
  document.getElementById('p2-val').textContent = fmt(cp.P2);
  document.getElementById('p3-val').textContent = fmt(cp.P3);
}

function bezierPoint(cp, t) {
  const b0 = B(0, t), b1 = B(1, t), b2 = B(2, t), b3 = B(3, t);
  return {
    x: b0 * cp.P0.x + b1 * cp.P1.x + b2 * cp.P2.x + b3 * cp.P3.x,
    y: b0 * cp.P0.y + b1 * cp.P1.y + b2 * cp.P2.y + b3 * cp.P3.y
  };
}

function boundsOfPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, Math.round(maxX - minX)),
    height: Math.max(1, Math.round(maxY - minY))
  };
}

function sampleBezierByDistance(cp, step) {
  const denseCount = 400;
  const dense = [];
  for (let i = 0; i <= denseCount; i++) dense.push(bezierPoint(cp, i / denseCount));

  const result = [dense[0]];
  let last = dense[0];
  for (let i = 1; i < dense.length; i++) {
    const p = dense[i];
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    if (Math.hypot(dx, dy) >= step) {
      result.push(p);
      last = p;
    }
  }

  const end = dense[dense.length - 1];
  const tail = result[result.length - 1];
  if (Math.hypot(end.x - tail.x, end.y - tail.y) > 0.001) result.push(end);
  return result;
}

function angleFromPoints(a, b) {
  const rad = Math.atan2(-(b.y - a.y), b.x - a.x);
  return Math.round((rad * 180 / Math.PI + 360) % 360);
}

async function exportBezierJsonToClipboard() {
  if (isDrawMode) {
    showToast('베지어 편집 모드에서만 사용할 수 있습니다');
    return;
  }
  if (!currentBezier) {
    showToast('먼저 곡선을 피팅해 주세요');
    return;
  }

  const sampled = sampleBezierByDistance(currentBezier, 4);
  const rects = sampled.map((p, i) => {
    let role = 'middle';
    if (i === 0) role = 'start';
    else if (i === sampled.length - 1) role = 'end';

    let angle = null;
    if (i > 0) angle = angleFromPoints(sampled[i - 1], p);

    return {
      x: Math.round(p.x),
      y: Math.round(p.y),
      size: 4,
      angle,
      sharpTurn: false,
      mergeState: false,
      role,
      polylineId: 'PL1',
      pointOrder: i + 1
    };
  });

  const pointIndices = Array.from({ length: rects.length }, (_, i) => i);
  const sourcePoints = sampleBezierByDistance(originalBezier || currentBezier, 4);
  const sourceBounds = boundsOfPoints(sourcePoints);
  const appliedBounds = boundsOfPoints(sampled);
  const scaleValue = Number.isFinite(currentScale) ? currentScale : 1;

  const payload = {
    rects,
    polylines: [
      {
        polylineId: 'PL1',
        startIndex: 0,
        endIndex: Math.max(0, rects.length - 1),
        pointCount: rects.length,
        pointIndices
      }
    ],
    canvas1ClipboardScale: {
      scalePercent: Math.round(scaleValue * 100),
      scale: Number(scaleValue.toFixed(4)),
      sourceWidth: sourceBounds.width,
      sourceHeight: sourceBounds.height,
      appliedWidth: appliedBounds.width,
      appliedHeight: appliedBounds.height,
      mode: 'bezier-manual-scale'
    }
  };

  const text = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    showToast('베지어 JSON을 클립보드로 복사했습니다');
  } catch (err) {
    showToast('클립보드 복사에 실패했습니다');
  }
}

function scaleBezier(cp, factor) {
  if (!isBezierControlPoints(cp)) return null;
  const center = {
    x: (cp.P0.x + cp.P1.x + cp.P2.x + cp.P3.x) / 4,
    y: (cp.P0.y + cp.P1.y + cp.P2.y + cp.P3.y) / 4
  };
  const scalePoint = p => ({ x: center.x + (p.x - center.x) * factor, y: center.y + (p.y - center.y) * factor });
  return {
    P0: scalePoint(cp.P0),
    P1: scalePoint(cp.P1),
    P2: scalePoint(cp.P2),
    P3: scalePoint(cp.P3)
  };
}

function applyBezierScale(factor) {
  if (isDrawMode) {
    showToast('베지어 편집 모드에서만 사용할 수 있습니다');
    return;
  }
  const slot = getActiveSlot();
  if (!slot.bezier) {
    showToast('먼저 곡선을 피팅해 주세요');
    return;
  }
  const nextBezier = scaleBezier(slot.bezier, factor);
  if (!nextBezier) return;
  slot.bezier = nextBezier;
  slot.scale *= factor;
  syncActiveBezierState();
  render();
  drawFittedBezier(currentBezier, true);
  updateControlPointInfo(currentBezier);
  saveBezierToStorage();
  document.getElementById('err-box').textContent = '제어점 간격을 수동 조정했습니다';
}

function addBezierSlot() {
  if (isDrawMode) {
    showToast('베지어 편집 모드에서만 사용할 수 있습니다');
    return;
  }
  if (bezierSlots.length >= 2) {
    showToast('베지어 곡선은 최대 2개까지 추가할 수 있습니다');
    return;
  }
  bezierSlots.push(createBezierSlot());
  activeBezierIndex = bezierSlots.length - 1;
  selectedBezierIndices = [activeBezierIndex];
  syncActiveBezierState();
  refreshBezierButtons();
  render();
  updateControlPointInfo(currentBezier);
  showToast(`베지어 ${bezierSlots.length}번 슬롯을 추가했습니다`);
}

function render() {
  const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
  ctx.clearRect(0, 0, W, H);
  const hasAnyContent = bezierSlots.some(slot => slot.pts.length > 0 || slot.bezier);
  if (!hasAnyContent) {
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

  bezierSlots.forEach((slot, index) => {
    if (slot.pts.length > 0) {
      drawRawCurve(slot.pts, index === activeBezierIndex ? '#6B7FD4' : '#4F5F80');
    }
    if (slot.bezier) {
      drawFittedBezier(slot.bezier, index === activeBezierIndex, selectedBezierIndices.includes(index));
    }
  });
}

function refit() {
  const slot = getActiveSlot();
  render();
  if (slot.pts.length < 4) {
    slot.errText = '';
    document.getElementById('err-box').textContent = '';
    return;
  }
  const sampled = samplePoints(slot.pts);
  const cp = fitBezier(sampled);
  if (!cp) return;

  slot.bezier = cp;
  slot.originalBezier = cloneBezier(cp);
  slot.scale = 1;
  syncActiveBezierState();
  drawFittedBezier(currentBezier, true);
  updateControlPointInfo(currentBezier);
  saveBezierToStorage();

  let err = 0;
  const ts2 = parameterize(sampled);
  for (let i = 0; i < sampled.length; i++) {
    const t = ts2[i];
    const bx = B(0,t)*cp.P0.x + B(1,t)*cp.P1.x + B(2,t)*cp.P2.x + B(3,t)*cp.P3.x;
    const by = B(0,t)*cp.P0.y + B(1,t)*cp.P1.y + B(2,t)*cp.P2.y + B(3,t)*cp.P3.y;
    const dx = sampled[i].x - bx, dy = sampled[i].y - by;
    err += Math.sqrt(dx*dx+dy*dy);
  }
  slot.errText = `평균 피팅 오차: ${(err/sampled.length).toFixed(1)}px`;
  document.getElementById('err-box').textContent = slot.errText;
}

function clearDrawing() {
  const slot = getActiveSlot();
  slot.pts = [];
  slot.bezier = null;
  slot.originalBezier = null;
  slot.scale = 1;
  slot.errText = '';
  syncActiveBezierState();
  render();
  ['p0-val','p1-val','p2-val','p3-val'].forEach(id => document.getElementById(id).textContent = '—');
  document.getElementById('err-box').textContent = '';
}

function clearAll() {
  bgImage = null;
  bgCtx.clearRect(0, 0, W, H);
  removeBezierFromStorage();
  removeBackgroundFromStorage();
  bezierSlots = [createBezierSlot()];
  activeBezierIndex = 0;
  selectedBezierIndices = [0];
  syncActiveBezierState();
  refreshBezierButtons();
  render();
  ['p0-val','p1-val','p2-val','p3-val'].forEach(id => document.getElementById(id).textContent = '—');
  document.getElementById('err-box').textContent = '';
}

function clearStoredBezier() {
  removeBezierFromStorage();
  showToast('저장된 좌표를 삭제했습니다');
}

function shrinkBezier() {
  applyBezierScale(0.9);
}

function expandBezier() {
  applyBezierScale(1.1);
}

function clearStoredBackground() {
  removeBackgroundFromStorage();
  bgImage = null;
  renderBg();
  showToast('저장된 밑그림을 삭제했습니다');
}

ensureBezierSlots();
refreshBezierButtons();
updateCanvasCursor();
render();
const savedCp = loadBezierFromStorage();
if (savedCp) {
  render();
  drawFittedBezier(currentBezier, true);
  updateControlPointInfo(currentBezier);
}

const savedBg = loadBackgroundFromStorage();
if (savedBg) {
  const img = new Image();
  img.onload = () => {
    bgImage = img;
    renderBg();
  };
  img.src = savedBg;
}
