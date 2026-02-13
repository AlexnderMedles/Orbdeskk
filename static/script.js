// ═══════════════════════════════════════════════════════
// OrbDesk v5 — Mega Update Script
// ═══════════════════════════════════════════════════════

// ═══ Элементы ═══
const pages = {
    landing: document.getElementById('landing-page'),
    host: document.getElementById('host-page'),
    viewer: document.getElementById('viewer-page'),
    remote: document.getElementById('remote-page'),
};
const canvas = document.getElementById('screen-canvas');
const ctx = canvas.getContext('2d');
const drawCanvas = document.getElementById('draw-canvas');
const drawCtx = drawCanvas.getContext('2d');
const pinDigits = document.querySelectorAll('.pin-digit');
const pinError = document.getElementById('pin-error');
const connectBtn = document.getElementById('connect-btn');
const loader = document.getElementById('loader');
const controlBadge = document.getElementById('control-badge');

let ws = null;
let sessionCode = '';
let controlAllowed = false;
let drawingMode = false;
let myViewerId = '';
let myViewerName = '';

// ═══════════════════════════════════════════════════════
// 🔊 Sound System (Web Audio API)
// ═══════════════════════════════════════════════════════
let soundEnabled = true;
let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}
function playTone(freq, duration, type = 'sine', vol = 0.15) {
    if (!soundEnabled) return;
    try {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration);
    } catch { }
}
function playConnect() { playTone(880, 0.15); setTimeout(() => playTone(1100, 0.2), 100); }
function playDisconnect() { playTone(440, 0.2); setTimeout(() => playTone(330, 0.3), 150); }
function playChat() { playTone(660, 0.1, 'triangle', 0.1); }
function playFile() { playTone(520, 0.1); setTimeout(() => playTone(780, 0.15), 80); }
function playNotify() { playTone(600, 0.12, 'sine', 0.1); }

document.getElementById('btn-sound-toggle').addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    const btn = document.getElementById('btn-sound-toggle');
    const status = document.getElementById('sound-status');
    btn.querySelector('.q-icon').textContent = soundEnabled ? '🔊' : '🔇';
    status.textContent = soundEnabled ? 'Вкл' : 'Выкл';
    btn.classList.toggle('active', soundEnabled);
});

// ═══════════════════════════════════════════════════════
// 📜 Audit Log
// ═══════════════════════════════════════════════════════
const auditEvents = [];
function addAuditLocal(type, detail) {
    auditEvents.push({ type, detail, time: Date.now() / 1000 });
    renderAuditLog();
}
function renderAuditLog() {
    const list = document.getElementById('audit-list');
    if (!list) return;
    const icons = {
        host_connect: '🟢', host_disconnect: '🔴', viewer_connect: '👤',
        viewer_disconnect: '👤', control_toggle: '🎮', file_upload: '📄',
        privacy_shield: '🛡️', kick: '👢', kill_process: '☠️',
    };
    list.innerHTML = auditEvents.slice(-50).reverse().map(e => {
        const t = new Date(e.time * 1000);
        const ts = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const icon = icons[e.type] || '📋';
        return `<div class="audit-item"><span class="audit-icon">${icon}</span><span class="audit-detail">${escapeHtml(e.detail || e.type)}</span><span class="audit-time">${ts}</span></div>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════
// Навигация
// ═══════════════════════════════════════════════════════
function showPage(name) {
    Object.values(pages).forEach(p => p.classList.remove('active'));
    pages[name].classList.add('active');
}
document.getElementById('btn-host').addEventListener('click', () => showPage('host'));
document.getElementById('btn-viewer').addEventListener('click', () => {
    showPage('viewer'); resetPin();
    setTimeout(() => pinDigits[0].focus(), 100);
});
document.getElementById('back-from-host').addEventListener('click', () => showPage('landing'));
document.getElementById('back-from-viewer').addEventListener('click', () => showPage('landing'));

// ═══════════════════════════════════════════════════════
// PIN
// ═══════════════════════════════════════════════════════
function resetPin() {
    pinDigits.forEach(d => { d.value = ''; d.classList.remove('filled', 'error'); });
    pinError.textContent = '';
    connectBtn.disabled = true;
    connectBtn.textContent = 'Подключиться';
    document.getElementById('password-section').classList.add('hidden');
    document.getElementById('session-password').value = '';
}
function getPinCode() { return Array.from(pinDigits).map(d => d.value).join(''); }

pinDigits.forEach((digit, idx) => {
    digit.addEventListener('input', (e) => {
        const val = e.target.value.replace(/\D/g, '');
        e.target.value = val.slice(-1);
        if (val) { digit.classList.add('filled'); digit.classList.remove('error'); if (idx < pinDigits.length - 1) pinDigits[idx + 1].focus(); }
        else { digit.classList.remove('filled'); }
        const code = getPinCode();
        if (code.length === 6) checkSessionForPassword(code);
        connectBtn.disabled = code.length < 6;
        pinError.textContent = '';
    });
    digit.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !digit.value && idx > 0) { pinDigits[idx - 1].focus(); pinDigits[idx - 1].value = ''; pinDigits[idx - 1].classList.remove('filled'); }
        if (e.key === 'Enter' && getPinCode().length === 6) connectViewer();
    });
    digit.addEventListener('paste', (e) => {
        e.preventDefault();
        const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
        if (paste.length >= 6) {
            paste.slice(0, 6).split('').forEach((ch, i) => { pinDigits[i].value = ch; pinDigits[i].classList.add('filled'); });
            pinDigits[5].focus(); connectBtn.disabled = false;
            checkSessionForPassword(paste.slice(0, 6));
        }
    });
});
connectBtn.addEventListener('click', connectViewer);

async function checkSessionForPassword(code) {
    try {
        const resp = await fetch(`/session/check?code=${code}`);
        const data = await resp.json();
        const pwSection = document.getElementById('password-section');
        if (data.online && data.has_password) pwSection.classList.remove('hidden');
        else pwSection.classList.add('hidden');
    } catch { }
}

// ═══════════════════════════════════════════════════════
// FPS & Adaptive Flow
// ═══════════════════════════════════════════════════════
let frameCount = 0, lastFpsUpdate = performance.now(), measuredFps = 0;
let fpsHistory = [], autoQualityEnabled = true, currentQualityProfile = 'medium';

function updateFpsCounter() {
    frameCount++;
    const now = performance.now();
    if (now - lastFpsUpdate >= 1000) {
        measuredFps = Math.round(frameCount * 1000 / (now - lastFpsUpdate));
        frameCount = 0; lastFpsUpdate = now;
        const fpsEl = document.getElementById('info-fps');
        if (fpsEl) fpsEl.textContent = measuredFps;
        updateConnectionIndicator(measuredFps);
        fpsHistory.push(measuredFps);
        if (fpsHistory.length > 10) fpsHistory.shift();
        if (autoQualityEnabled && fpsHistory.length >= 5) {
            const avgFps = fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length;
            autoAdjustQuality(avgFps);
        }
    }
}
function updateConnectionIndicator(fps) {
    const indicator = document.getElementById('connection-indicator');
    const text = document.getElementById('ci-text');
    if (!indicator) return;
    indicator.classList.remove('good', 'medium', 'bad');
    if (fps >= 25) { indicator.classList.add('good'); text.textContent = `${fps} FPS`; }
    else if (fps >= 12) { indicator.classList.add('medium'); text.textContent = `${fps} FPS`; }
    else { indicator.classList.add('bad'); text.textContent = `${fps} FPS`; }
}
function autoAdjustQuality(avgFps) {
    if (currentQualityProfile === 'high' && avgFps < 20) switchQuality('medium');
    else if (currentQualityProfile === 'medium' && avgFps < 10) switchQuality('low');
    else if (currentQualityProfile === 'low' && avgFps > 25) switchQuality('medium');
}
function switchQuality(profile) {
    currentQualityProfile = profile;
    send({ action: 'set_quality', profile });
    const qs = document.getElementById('quality-selector');
    qs.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active'));
    const btn = qs.querySelector(`[data-quality="${profile}"]`);
    if (btn) btn.classList.add('active');
    showToast(`📊 Авто-качество: ${{ 'low': 'Низкое', 'medium': 'Среднее', 'high': 'Высокое' }[profile]}`);
}

// ═══════════════════════════════════════════════════════
// Подключение
// ═══════════════════════════════════════════════════════
let connectionTime = 0;

async function connectViewer() {
    const code = getPinCode();
    if (code.length < 6) return;
    connectBtn.disabled = true;
    connectBtn.textContent = 'Проверка...';
    try {
        const resp = await fetch(`/session/check?code=${code}`);
        const data = await resp.json();
        if (!data.online) {
            pinError.textContent = 'Хост не найден или оффлайн';
            pinDigits.forEach(d => d.classList.add('error'));
            connectBtn.disabled = false; connectBtn.textContent = 'Подключиться'; return;
        }
    } catch {
        pinError.textContent = 'Ошибка связи с сервером';
        connectBtn.disabled = false; connectBtn.textContent = 'Подключиться'; return;
    }

    sessionCode = code;
    myViewerName = document.getElementById('viewer-name').value.trim() || 'Viewer';
    showPage('remote');
    loader.style.display = '';
    canvas.style.display = 'none';
    drawCanvas.style.display = 'none';
    document.getElementById('session-status').textContent = 'Подключение...';
    updateControlBadge(false);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const password = document.getElementById('session-password').value;
    ws = new WebSocket(`${protocol}//${location.host}/ws/viewer?code=${code}&password=${encodeURIComponent(password)}&name=${encodeURIComponent(myViewerName)}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        loader.style.display = 'none';
        canvas.style.display = '';
        drawCanvas.style.display = '';
        document.getElementById('session-status').textContent = 'В сети';
        connectionTime = Date.now();
        showToast('✅ Подключено!');
        playConnect();
        addAuditLocal('viewer_connect', `${myViewerName} подключился`);
    };

    ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            updateFpsCounter();
            const blob = new Blob([e.data], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                if (canvas.width !== img.width || canvas.height !== img.height) {
                    canvas.width = img.width; canvas.height = img.height;
                    drawCanvas.width = img.width; drawCanvas.height = img.height;
                    const resEl = document.getElementById('info-resolution');
                    if (resEl) resEl.textContent = `${img.width}×${img.height}`;
                }
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
            };
            img.src = url;
        } else {
            try { handleServerMessage(JSON.parse(e.data)); } catch { }
        }
    };

    ws.onclose = (e) => {
        const msgs = {
            4001: 'Неверный код или хост оффлайн', 4002: 'Слишком много зрителей',
            4003: '❌ Неверный пароль', 4010: 'Хост завершил сеанс', 4020: 'Хост вас выгнал'
        };
        if (msgs[e.code]) {
            showPage('viewer'); pinError.textContent = msgs[e.code];
            pinDigits.forEach(d => d.classList.add('error'));
        } else { document.getElementById('session-status').textContent = 'Отключено'; }
        connectBtn.disabled = false; connectBtn.textContent = 'Подключиться';
        closeAllOverlays(); stopRecording(); playDisconnect();
        addAuditLocal('viewer_disconnect', 'Отключено');
    };

    setInterval(() => {
        if (connectionTime && ws && ws.readyState === WebSocket.OPEN) {
            const latencyEl = document.getElementById('info-latency');
            if (latencyEl) {
                const elapsed = Math.round((Date.now() - connectionTime) / 1000);
                const min = Math.floor(elapsed / 60), sec = elapsed % 60;
                latencyEl.textContent = min > 0 ? `${min}м ${sec}с` : `${sec}с`;
            }
        }
    }, 1000);
}

// ═══════════════════════════════════════════════════════
// Обработка серверных JSON-сообщений
// ═══════════════════════════════════════════════════════
function handleServerMessage(msg) {
    switch (msg.type) {
        case 'control_status':
            controlAllowed = msg.allowed;
            updateControlBadge(msg.allowed);
            showToast(msg.allowed ? '🎮 Управление разрешено' : '👁️ Только просмотр');
            addAuditLocal('control_toggle', msg.allowed ? 'Управление разрешено' : 'Только просмотр');
            break;
        case 'monitor_list': renderMonitorSelector(msg.monitors || []); break;
        case 'chat': addChatMessage(msg); playChat(); break;
        case 'draw': drawRemoteShape(msg); break;
        case 'draw_clear': drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height); break;
        case 'viewer_identity': myViewerId = msg.viewer_id; myViewerName = msg.name || 'Viewer'; break;
        case 'cursor_pos': updateGhostCursor(msg); break;
        case 'cursor_remove': removeGhostCursor(msg.viewer_id); break;
        case 'clipboard_sync': handleClipboardReceive(msg.text); break;
        case 'screenshot_result': showScreenshot(msg.data); break;
        case 'privacy_shield': handlePrivacyShield(msg.enabled); break;
        case 'audit_event': auditEvents.push(msg); renderAuditLog(); break;
        case 'audit_history':
            if (msg.events) { msg.events.forEach(e => auditEvents.push(e)); renderAuditLog(); }
            break;
        case 'process_list': renderProcessList(msg.processes || []); break;
        case 'browse_result': renderExplorerResult(msg); break;
        case 'file_chunk': handleFileChunk(msg); break;
    }
}

function updateControlBadge(allowed) {
    controlBadge.className = 'control-badge ' + (allowed ? 'allowed' : 'denied');
    controlBadge.textContent = allowed ? '🎮 Управление' : '👁️ Просмотр';
}

document.getElementById('close-session').addEventListener('click', () => {
    if (ws) ws.close(); ws = null; sessionCode = '';
    connectionTime = 0; showPage('landing');
    closeAllOverlays(); disableDrawMode(); stopRecording(); clearGhostCursors();
});

// ═══════════════════════════════════════════════════════
// УПРАВЛЕНИЕ: мышь + клавиатура
// ═══════════════════════════════════════════════════════
function send(data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function sendControl(data) { if (!controlAllowed) return; send(data); }

function coords(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

let lastMove = 0, lastCursorSend = 0;
canvas.addEventListener('mousemove', (e) => {
    if (drawingMode) return;
    const now = Date.now();
    if (now - lastCursorSend > 100) {
        send({ type: 'cursor_pos', x: coords(e).x, y: coords(e).y });
        lastCursorSend = now;
    }
    if (!controlAllowed) return;
    if (now - lastMove > 50) { sendControl({ action: 'move', ...coords(e) }); lastMove = now; }
});
canvas.addEventListener('mousedown', (e) => {
    if (drawingMode || !controlAllowed) return;
    const btn = e.button === 0 ? 'left' : (e.button === 2 ? 'right' : 'middle');
    sendControl({ action: 'click', ...coords(e), button: btn });
});
canvas.addEventListener('dblclick', (e) => {
    if (drawingMode || !controlAllowed) return;
    e.preventDefault();
    sendControl({ action: 'dblclick', ...coords(e), button: 'left' });
});
canvas.addEventListener('wheel', (e) => {
    if (drawingMode || !controlAllowed) return;
    e.preventDefault();
    sendControl({ action: 'scroll', delta: e.deltaY > 0 ? -3 : 3 });
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
    if (!pages.remote.classList.contains('active') || !controlAllowed) return;
    if (e.target.closest('.overlay-panel') || e.target.closest('.chat-input-area') || e.target.closest('.explorer-glass') || e.target.closest('.taskmgr-glass')) return;
    if (['F5', 'r'].includes(e.key) && e.ctrlKey) return;
    e.preventDefault();
    let key = e.key.toLowerCase();
    if (key === 'control') key = 'ctrl';
    if (key === 'escape') key = 'esc';
    sendControl({ action: 'key', key });
});

document.getElementById('fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
});

// ═══ Focus Mode ═══
let focusMode = false;
document.getElementById('btn-focus').addEventListener('click', () => {
    focusMode = !focusMode;
    const nav = document.getElementById('glass-nav');
    const toolbar = document.querySelector('.floating-toolbar');
    if (focusMode) { nav.classList.add('nav-hidden'); toolbar.classList.add('toolbar-hidden'); showToast('👁️ Focus Mode — двойной клик для выхода'); }
    else { nav.classList.remove('nav-hidden'); toolbar.classList.remove('toolbar-hidden'); }
});
document.getElementById('viewport-container').addEventListener('dblclick', (e) => {
    if (focusMode && !drawingMode) {
        focusMode = false;
        document.getElementById('glass-nav').classList.remove('nav-hidden');
        document.querySelector('.floating-toolbar').classList.remove('toolbar-hidden');
    }
});

// ═══════════════════════════════════════════════════════
// OVERLAYS
// ═══════════════════════════════════════════════════════
const overlayIds = ['settings-overlay', 'syskeys-overlay', 'chat-overlay', 'quickactions-overlay', 'explorer-overlay', 'taskmgr-overlay', 'audit-overlay'];
const btnIds = { 'settings-overlay': 'btn-settings', 'syskeys-overlay': 'btn-syskeys', 'chat-overlay': 'btn-chat', 'quickactions-overlay': 'btn-quickactions', 'explorer-overlay': 'btn-explorer', 'taskmgr-overlay': 'btn-taskmgr', 'audit-overlay': 'btn-audit' };

function closeAllOverlays() {
    overlayIds.forEach(id => document.getElementById(id).classList.add('hidden'));
    Object.values(btnIds).forEach(id => document.getElementById(id).classList.remove('active'));
}
function toggleOverlay(overlayId) {
    const overlay = document.getElementById(overlayId);
    const btn = document.getElementById(btnIds[overlayId]);
    const isHidden = overlay.classList.contains('hidden');
    closeAllOverlays();
    if (isHidden) { overlay.classList.remove('hidden'); if (btn) btn.classList.add('active'); }
}

document.getElementById('btn-settings').addEventListener('click', () => toggleOverlay('settings-overlay'));
document.getElementById('btn-syskeys').addEventListener('click', () => toggleOverlay('syskeys-overlay'));
document.getElementById('btn-quickactions').addEventListener('click', () => toggleOverlay('quickactions-overlay'));
document.getElementById('btn-chat').addEventListener('click', () => {
    toggleOverlay('chat-overlay');
    document.getElementById('btn-chat').classList.remove('has-unread');
    if (!document.getElementById('chat-overlay').classList.contains('hidden')) document.getElementById('chat-input').focus();
});
document.getElementById('btn-explorer').addEventListener('click', () => {
    toggleOverlay('explorer-overlay');
    if (!document.getElementById('explorer-overlay').classList.contains('hidden') && !explorerLoaded) {
        send({ type: 'browse_dir', path: '' });
        explorerLoaded = true;
    }
});
document.getElementById('btn-taskmgr').addEventListener('click', () => {
    toggleOverlay('taskmgr-overlay');
    if (!document.getElementById('taskmgr-overlay').classList.contains('hidden')) send({ type: 'request_processes' });
});
document.getElementById('btn-audit').addEventListener('click', () => { toggleOverlay('audit-overlay'); renderAuditLog(); });
document.getElementById('btn-draw').addEventListener('click', () => { if (drawingMode) disableDrawMode(); else enableDrawMode(); });

document.querySelectorAll('.overlay-close').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.dataset.close;
        if (targetId) document.getElementById(targetId).classList.add('hidden');
        if (btn.id === 'screenshot-close') document.getElementById('screenshot-modal').classList.add('hidden');
        Object.values(btnIds).forEach(id => document.getElementById(id).classList.remove('active'));
    });
});

document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.overlay-panel') && !e.target.closest('.nav-icon-btn') &&
        !e.target.closest('.draw-toolbar') && !e.target.closest('.screenshot-modal')) closeAllOverlays();
});

// ═══ Quality & Monitor Selectors ═══
document.getElementById('quality-selector').addEventListener('click', (e) => {
    const btn = e.target.closest('.q-btn');
    if (!btn || !btn.dataset.quality) return;
    document.getElementById('quality-selector').querySelectorAll('.q-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentQualityProfile = btn.dataset.quality;
    send({ action: 'set_quality', profile: btn.dataset.quality });
    showToast(`📊 Качество: ${{ 'low': 'Низкое (15 FPS)', 'medium': 'Среднее (30 FPS)', 'high': 'Высокое (60 FPS)' }[btn.dataset.quality]}`);
});

function renderMonitorSelector(monitors) {
    const container = document.getElementById('monitor-selector');
    if (!monitors.length) { container.innerHTML = '<span class="monitor-info">1 монитор</span>'; return; }
    container.innerHTML = '';
    monitors.forEach((m, i) => {
        const btn = document.createElement('button');
        btn.className = 'monitor-btn' + (i === 0 ? ' active' : '');
        btn.dataset.index = m.index;
        btn.innerHTML = `<span class="mon-icon">🖥️</span><span class="mon-label">#${m.index} (${m.width}×${m.height})</span>`;
        btn.addEventListener('click', () => {
            container.querySelectorAll('.monitor-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            send({ action: 'set_monitor', index: m.index });
            showToast(`🖥️ Монитор #${m.index}`);
        });
        container.appendChild(btn);
    });
}

// ═══ System Keys ═══
const heldModifiers = new Set();
document.querySelectorAll('.modifier-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const mod = btn.dataset.mod;
        if (heldModifiers.has(mod)) { heldModifiers.delete(mod); btn.classList.remove('held'); sendControl({ action: 'keyup', key: mod }); }
        else { heldModifiers.add(mod); btn.classList.add('held'); sendControl({ action: 'keydown', key: mod }); }
    });
});
document.querySelectorAll('.syskey-btn:not(.modifier-btn):not(.hotkey-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.key; if (!key) return;
        if (heldModifiers.size > 0) { sendControl({ action: 'hotkey', keys: [...heldModifiers, key] }); releaseAllModifiers(); }
        else sendControl({ action: 'key', key });
        btn.style.transform = 'scale(0.9)'; setTimeout(() => btn.style.transform = '', 150);
    });
});
document.querySelectorAll('.hotkey-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const hotkey = btn.dataset.hotkey; if (!hotkey) return;
        sendControl({ action: 'hotkey', keys: hotkey.split(',') });
        btn.style.transform = 'scale(0.9)'; setTimeout(() => btn.style.transform = '', 150);
    });
});
function releaseAllModifiers() {
    heldModifiers.forEach(mod => sendControl({ action: 'keyup', key: mod }));
    heldModifiers.clear();
    document.querySelectorAll('.modifier-btn').forEach(b => b.classList.remove('held'));
}

// ═══ Quick Actions ═══
document.querySelectorAll('.qa-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const quick = btn.dataset.quick; if (!quick) return;
        if (quick === 'lock_screen' && !confirm('Заблокировать экран хоста?')) return;
        sendControl({ action: 'quick_action', quick });
        btn.style.transform = 'scale(0.92)'; setTimeout(() => btn.style.transform = '', 200);
        const labels = { minimize_all: '🗕 Свернуто', show_desktop: '🖥️ Рабочий стол', task_manager: '📊 Диспетчер задач', open_explorer: '📁 Проводник', screenshot: '📸 Скриншот...', lock_screen: '🔒 Блокировка' };
        showToast(labels[quick] || '⚡ Действие отправлено');
    });
});

// ═══ Clipboard ═══
document.getElementById('btn-clipboard').addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        if (text) { send({ type: 'clipboard_sync', text: text.substring(0, 10000) }); showToast('📋 Буфер отправлен хосту'); }
        else showToast('📋 Буфер пуст');
    } catch { showToast('📋 Нет доступа к буферу (нужен HTTPS)'); }
});
function handleClipboardReceive(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => showToast(`📋 Буфер получен (${text.length} символов)`)).catch(() => showToast('📋 Не удалось записать в буфер'));
}

// ═══════════════════════════════════════════════════════
// 🛡️ Privacy Shield
// ═══════════════════════════════════════════════════════
let privacyShieldActive = false;
document.getElementById('btn-privacy').addEventListener('click', () => {
    // Зритель не может сам включить; уведомляем что это функция хоста
    showToast('🛡️ Privacy Shield управляется хостом');
});
function handlePrivacyShield(enabled) {
    privacyShieldActive = enabled;
    const overlay = document.getElementById('privacy-shield-overlay');
    if (enabled) { overlay.classList.remove('hidden'); playNotify(); }
    else overlay.classList.add('hidden');
    addAuditLocal('privacy_shield', enabled ? 'Экран скрыт' : 'Экран открыт');
    showToast(enabled ? '🛡️ Экран скрыт хостом' : '🛡️ Экран доступен');
}

// ═══════════════════════════════════════════════════════
// 👻 Ghost Cursors (с именами)
// ═══════════════════════════════════════════════════════
const ghostCursors = {};
const ghostLayer = document.getElementById('ghost-cursors-layer');

function updateGhostCursor(msg) {
    let cursor = ghostCursors[msg.viewer_id];
    if (!cursor) {
        cursor = document.createElement('div');
        cursor.className = 'ghost-cursor';
        cursor.innerHTML = `
            <svg width="16" height="20" viewBox="0 0 16 20" fill="none">
                <path d="M0 0L16 12L8 12L12 20L8 18L4 12L0 16V0Z" fill="${msg.color}" stroke="#000" stroke-width="1"/>
            </svg>
            <span class="ghost-label" style="background:${msg.color}">${escapeHtml(msg.name || msg.viewer_id)}</span>
        `;
        ghostLayer.appendChild(cursor);
        ghostCursors[msg.viewer_id] = cursor;
    }
    const rect = canvas.getBoundingClientRect();
    const layerRect = ghostLayer.getBoundingClientRect();
    const x = rect.left - layerRect.left + msg.x * rect.width;
    const y = rect.top - layerRect.top + msg.y * rect.height;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
}
function removeGhostCursor(viewerId) {
    const cursor = ghostCursors[viewerId];
    if (cursor) { cursor.style.opacity = '0'; setTimeout(() => { cursor.remove(); delete ghostCursors[viewerId]; }, 300); }
}
function clearGhostCursors() { Object.keys(ghostCursors).forEach(id => { ghostCursors[id].remove(); delete ghostCursors[id]; }); }

// ═══════════════════════════════════════════════════════
// 📁 OrbDrop — File Drag & Drop
// ═══════════════════════════════════════════════════════
const viewportContainer = document.getElementById('viewport-container');
const dropOverlay = document.getElementById('drop-overlay');
let dragCounter = 0;
viewportContainer.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dropOverlay.classList.remove('hidden'); });
viewportContainer.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.add('hidden'); } });
viewportContainer.addEventListener('dragover', (e) => e.preventDefault());
viewportContainer.addEventListener('drop', async (e) => {
    e.preventDefault(); dragCounter = 0; dropOverlay.classList.add('hidden');
    const files = e.dataTransfer.files;
    if (!files.length || !sessionCode) return;
    for (const file of files) {
        if (file.size > 50 * 1024 * 1024) { showToast(`❌ ${file.name} слишком большой (макс. 50 MB)`); continue; }
        showToast(`📤 Отправка: ${file.name}...`);
        const formData = new FormData(); formData.append('file', file);
        try {
            const resp = await fetch(`/api/upload/${sessionCode}`, { method: 'POST', body: formData });
            if (resp.ok) { const data = await resp.json(); showToast(`✅ ${file.name} отправлен (${data.size_kb} KB)`); playFile(); }
            else showToast(`❌ Ошибка отправки ${file.name}`);
        } catch { showToast(`❌ Ошибка сети при отправке ${file.name}`); }
    }
});

// ═══ Screenshot Modal ═══
function showScreenshot(base64Data) {
    const modal = document.getElementById('screenshot-modal');
    const img = document.getElementById('screenshot-img');
    const dl = document.getElementById('screenshot-download');
    img.src = `data:image/png;base64,${base64Data}`;
    dl.href = img.src;
    modal.classList.remove('hidden');
    showToast('📸 Скриншот готов!');
}
document.getElementById('screenshot-close').addEventListener('click', () => document.getElementById('screenshot-modal').classList.add('hidden'));

// ═══ Session Recording ═══
let mediaRecorder = null, recordedChunks = [], isRecording = false;
const btnRecord = document.getElementById('btn-record');
btnRecord.addEventListener('click', () => { if (isRecording) stopRecording(); else startRecording(); });
function startRecording() {
    try {
        const stream = canvas.captureStream(30);
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 3000000 });
        recordedChunks = [];
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url;
            a.download = `OrbDesk_${new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')}.webm`;
            a.click(); URL.revokeObjectURL(url); showToast('💾 Запись сохранена!');
        };
        mediaRecorder.start(1000); isRecording = true;
        btnRecord.classList.add('recording'); btnRecord.textContent = '⏹';
        showToast('⏺ Запись начата');
    } catch { showToast('❌ Не удалось начать запись'); }
}
function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop(); isRecording = false;
        btnRecord.classList.remove('recording'); btnRecord.textContent = '⏺';
    }
}

// ═══════════════════════════════════════════════════════
// 💬 ЧАТ
// ═══════════════════════════════════════════════════════
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send');
const chatMessages = document.getElementById('chat-messages');
chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); e.stopPropagation(); });

function sendChatMessage() {
    const text = chatInput.value.trim(); if (!text) return;
    const msg = { type: 'chat', text, time: Date.now() };
    send(msg); addChatMessage({ ...msg, from: 'me' }); chatInput.value = '';
}
function addChatMessage(msg) {
    const div = document.createElement('div');
    const isMe = msg.from === 'me', isHost = msg.from === 'host';
    div.className = 'chat-bubble ' + (isMe ? 'chat-me' : isHost ? 'chat-host' : 'chat-viewer');
    const time = new Date(msg.time || Date.now());
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const senderName = msg.viewer_name || (isHost ? '🖥️ Хост' : '🎮 Зритель');
    const label = isMe ? '' : `<span class="chat-sender">${escapeHtml(senderName)}</span>`;
    div.innerHTML = `${label}<span class="chat-text">${escapeHtml(msg.text)}</span><span class="chat-time">${timeStr}</span>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    if (document.getElementById('chat-overlay').classList.contains('hidden') && !isMe) {
        document.getElementById('btn-chat').classList.add('has-unread');
    }
}

// ═══════════════════════════════════════════════════════
// ✏️ РИСОВАНИЕ (Advanced: pen, arrow, rect, sticky)
// ═══════════════════════════════════════════════════════
let drawColor = '#ff4444', drawSize = 3, isDrawing = false;
let lastDrawX = 0, lastDrawY = 0, drawStartX = 0, drawStartY = 0;
let currentDrawTool = 'pen';
const drawToolbar = document.getElementById('draw-toolbar');

function enableDrawMode() {
    drawingMode = true; document.getElementById('btn-draw').classList.add('active');
    drawToolbar.classList.remove('hidden'); drawCanvas.style.pointerEvents = 'auto';
    drawCanvas.style.cursor = 'crosshair'; showToast('✏️ Режим рисования');
}
function disableDrawMode() {
    drawingMode = false; document.getElementById('btn-draw').classList.remove('active');
    drawToolbar.classList.add('hidden'); drawCanvas.style.pointerEvents = 'none';
    drawCanvas.style.cursor = 'default';
}

// Tool selection
document.querySelectorAll('.draw-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentDrawTool = btn.dataset.tool;
        if (currentDrawTool === 'sticky') {
            const text = prompt('Текст стикера:');
            if (text) {
                // Place sticky at center
                const cx = 0.5, cy = 0.5;
                drawSticky(cx, cy, text, drawColor);
                send({ type: 'draw', tool: 'sticky', x: cx, y: cy, text, color: drawColor });
            }
            // Reset to pen
            document.querySelector('[data-tool="pen"]').classList.add('active');
            btn.classList.remove('active');
            currentDrawTool = 'pen';
        }
    });
});

document.querySelectorAll('.draw-color').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.draw-color').forEach(b => b.classList.remove('active'));
        btn.classList.add('active'); drawColor = btn.dataset.color;
    });
});
document.querySelectorAll('.draw-size').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.draw-size').forEach(b => b.classList.remove('active'));
        btn.classList.add('active'); drawSize = parseInt(btn.dataset.size);
    });
});
document.getElementById('draw-clear').addEventListener('click', () => {
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    send({ type: 'draw_clear' });
});

// Canvas drawing events
drawCanvas.addEventListener('mousedown', (e) => {
    if (!drawingMode) return;
    isDrawing = true;
    const r = drawCanvas.getBoundingClientRect();
    lastDrawX = drawStartX = (e.clientX - r.left) / r.width;
    lastDrawY = drawStartY = (e.clientY - r.top) / r.height;
});
drawCanvas.addEventListener('mousemove', (e) => {
    if (!drawingMode || !isDrawing) return;
    const r = drawCanvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;

    if (currentDrawTool === 'pen') {
        drawLine(lastDrawX, lastDrawY, x, y, drawColor, drawSize);
        send({ type: 'draw', tool: 'pen', x1: lastDrawX, y1: lastDrawY, x2: x, y2: y, color: drawColor, size: drawSize });
        lastDrawX = x; lastDrawY = y;
    }
    // For arrow and rect, we preview on mouseup
});
drawCanvas.addEventListener('mouseup', (e) => {
    if (!drawingMode || !isDrawing) return;
    isDrawing = false;
    const r = drawCanvas.getBoundingClientRect();
    const endX = (e.clientX - r.left) / r.width;
    const endY = (e.clientY - r.top) / r.height;

    if (currentDrawTool === 'arrow') {
        drawArrow(drawStartX, drawStartY, endX, endY, drawColor, drawSize);
        send({ type: 'draw', tool: 'arrow', x1: drawStartX, y1: drawStartY, x2: endX, y2: endY, color: drawColor, size: drawSize });
    } else if (currentDrawTool === 'rect') {
        drawRect(drawStartX, drawStartY, endX, endY, drawColor, drawSize);
        send({ type: 'draw', tool: 'rect', x1: drawStartX, y1: drawStartY, x2: endX, y2: endY, color: drawColor, size: drawSize });
    }
});
drawCanvas.addEventListener('mouseleave', () => { isDrawing = false; });

function drawLine(x1, y1, x2, y2, color, size) {
    const w = drawCanvas.width, h = drawCanvas.height;
    drawCtx.beginPath(); drawCtx.moveTo(x1 * w, y1 * h); drawCtx.lineTo(x2 * w, y2 * h);
    drawCtx.strokeStyle = color; drawCtx.lineWidth = size; drawCtx.lineCap = 'round'; drawCtx.stroke();
}
function drawArrow(x1, y1, x2, y2, color, size) {
    const w = drawCanvas.width, h = drawCanvas.height;
    const ax1 = x1 * w, ay1 = y1 * h, ax2 = x2 * w, ay2 = y2 * h;
    const headLen = 15 + size * 2;
    const angle = Math.atan2(ay2 - ay1, ax2 - ax1);
    drawCtx.strokeStyle = color; drawCtx.fillStyle = color; drawCtx.lineWidth = size; drawCtx.lineCap = 'round';
    drawCtx.beginPath(); drawCtx.moveTo(ax1, ay1); drawCtx.lineTo(ax2, ay2); drawCtx.stroke();
    drawCtx.beginPath();
    drawCtx.moveTo(ax2, ay2);
    drawCtx.lineTo(ax2 - headLen * Math.cos(angle - Math.PI / 6), ay2 - headLen * Math.sin(angle - Math.PI / 6));
    drawCtx.lineTo(ax2 - headLen * Math.cos(angle + Math.PI / 6), ay2 - headLen * Math.sin(angle + Math.PI / 6));
    drawCtx.closePath(); drawCtx.fill();
}
function drawRect(x1, y1, x2, y2, color, size) {
    const w = drawCanvas.width, h = drawCanvas.height;
    drawCtx.strokeStyle = color; drawCtx.lineWidth = size; drawCtx.lineJoin = 'round';
    drawCtx.strokeRect(x1 * w, y1 * h, (x2 - x1) * w, (y2 - y1) * h);
}
function drawSticky(x, y, text, color) {
    const w = drawCanvas.width, h = drawCanvas.height;
    const px = x * w, py = y * h;
    drawCtx.fillStyle = color + '33';
    drawCtx.strokeStyle = color;
    drawCtx.lineWidth = 2;
    const tw = Math.max(drawCtx.measureText(text).width + 20, 80);
    drawCtx.fillRect(px - tw / 2, py - 15, tw, 30);
    drawCtx.strokeRect(px - tw / 2, py - 15, tw, 30);
    drawCtx.fillStyle = '#fff';
    drawCtx.font = '14px Inter, sans-serif';
    drawCtx.textAlign = 'center';
    drawCtx.textBaseline = 'middle';
    drawCtx.fillText(text, px, py);
}
function drawRemoteShape(msg) {
    const tool = msg.tool || 'pen';
    if (tool === 'pen') drawLine(msg.x1, msg.y1, msg.x2, msg.y2, msg.color, msg.size);
    else if (tool === 'arrow') drawArrow(msg.x1, msg.y1, msg.x2, msg.y2, msg.color, msg.size);
    else if (tool === 'rect') drawRect(msg.x1, msg.y1, msg.x2, msg.y2, msg.color, msg.size);
    else if (tool === 'sticky') drawSticky(msg.x, msg.y, msg.text, msg.color);
}

// ═══════════════════════════════════════════════════════
// 📂 OrbExplorer
// ═══════════════════════════════════════════════════════
let explorerLoaded = false;
let explorerCurrentPath = '';

function renderExplorerResult(msg) {
    const list = document.getElementById('explorer-list');
    const breadcrumb = document.getElementById('explorer-breadcrumb');
    if (msg.error) { list.innerHTML = `<div class="explorer-empty">❌ ${escapeHtml(msg.error)}</div>`; return; }

    explorerCurrentPath = msg.path || '';
    // Breadcrumb
    const parts = explorerCurrentPath.replace(/\\/g, '/').split('/').filter(Boolean);
    let html = `<span class="bread-item" data-path="">🏠</span>`;
    let accumulated = '';
    parts.forEach(p => {
        accumulated += (accumulated ? '/' : '') + p;
        html += ` / <span class="bread-item" data-path="${escapeHtml(accumulated)}">${escapeHtml(p)}</span>`;
    });
    breadcrumb.innerHTML = html;
    breadcrumb.querySelectorAll('.bread-item').forEach(b => {
        b.addEventListener('click', () => send({ type: 'browse_dir', path: b.dataset.path }));
    });

    // Go Up button
    const items = msg.items || [];
    list.innerHTML = '';

    if (parts.length > 0) {
        const upPath = parts.slice(0, -1).join('/');
        list.innerHTML += `<div class="explorer-item explorer-dir" data-path="${escapeHtml(upPath)}">
            <span class="explorer-icon">⬆️</span><span class="explorer-name">..</span><span class="explorer-size"></span></div>`;
    }

    items.forEach(item => {
        const icon = item.is_dir ? '📁' : getFileIcon(item.name);
        const size = item.is_dir ? '' : formatSize(item.size);
        const fullPath = explorerCurrentPath + (explorerCurrentPath.endsWith('/') || explorerCurrentPath.endsWith('\\') ? '' : '/') + item.name;
        const cls = item.is_dir ? 'explorer-dir' : 'explorer-file';
        list.innerHTML += `<div class="explorer-item ${cls}" data-path="${escapeHtml(fullPath)}" data-isdir="${item.is_dir}">
            <span class="explorer-icon">${icon}</span><span class="explorer-name">${escapeHtml(item.name)}</span><span class="explorer-size">${size}</span></div>`;
    });

    list.querySelectorAll('.explorer-dir').forEach(el => {
        el.addEventListener('click', () => send({ type: 'browse_dir', path: el.dataset.path }));
    });
    list.querySelectorAll('.explorer-file').forEach(el => {
        el.addEventListener('click', () => {
            if (confirm(`Скачать ${el.querySelector('.explorer-name').textContent}?`)) {
                send({ type: 'download_remote_file', path: el.dataset.path });
                showToast('📥 Загрузка...');
            }
        });
    });
}

function getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const icons = {
        jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', bmp: '🖼️', svg: '🖼️',
        mp4: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬', mov: '🎬',
        mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵',
        pdf: '📕', doc: '📄', docx: '📄', txt: '📝', md: '📝',
        zip: '📦', rar: '📦', '7z': '📦', tar: '📦',
        exe: '⚙️', msi: '⚙️', bat: '⚙️', py: '🐍', js: '🟨', html: '🌐', css: '🎨'
    };
    return icons[ext] || '📄';
}
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function handleFileChunk(msg) {
    if (msg.error) { showToast(`❌ ${msg.error}`); return; }
    // Trigger download
    const link = document.createElement('a');
    link.href = `data:application/octet-stream;base64,${msg.data}`;
    link.download = msg.filename || 'file';
    link.click();
    showToast(`✅ ${msg.filename} скачан!`);
    playFile();
}

// ═══════════════════════════════════════════════════════
// 📊 Task Manager Pro
// ═══════════════════════════════════════════════════════
document.getElementById('taskmgr-refresh').addEventListener('click', () => send({ type: 'request_processes' }));

function renderProcessList(processes) {
    const list = document.getElementById('taskmgr-list');
    if (!processes.length) { list.innerHTML = '<div class="explorer-empty">Нет данных</div>'; return; }
    list.innerHTML = processes.map(p => `
        <div class="tm-row">
            <span class="tm-col-name" title="PID: ${p.pid}">${escapeHtml(p.name)}</span>
            <span class="tm-col-cpu">${p.cpu}%</span>
            <span class="tm-col-ram">${p.ram_mb} MB</span>
            <button class="tm-kill" data-pid="${p.pid}" title="Завершить">☠️</button>
        </div>
    `).join('');

    list.querySelectorAll('.tm-kill').forEach(btn => {
        btn.addEventListener('click', () => {
            const pid = parseInt(btn.dataset.pid);
            if (confirm(`Завершить процесс PID ${pid}?`)) {
                send({ type: 'kill_process', pid });
                showToast(`☠️ Завершение процесса ${pid}...`);
                setTimeout(() => send({ type: 'request_processes' }), 1000);
            }
        });
    });
}

// ═══════════════════════════════════════════════════════
// Toast & Helpers
// ═══════════════════════════════════════════════════════
let toastTimeout = null;
function showToast(message) {
    let toast = document.querySelector('.toast');
    if (!toast) { toast = document.createElement('div'); toast.className = 'toast'; document.body.appendChild(toast); }
    toast.textContent = message; toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 2500);
}
function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }
