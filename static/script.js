// ═══════════════════════════════════════════════════════
// Элементы
// ═══════════════════════════════════════════════════════

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


// ═══════════════════════════════════════════════════════
// Навигация
// ═══════════════════════════════════════════════════════

function showPage(name) {
    Object.values(pages).forEach(p => p.classList.remove('active'));
    pages[name].classList.add('active');
}

document.getElementById('btn-host').addEventListener('click', () => showPage('host'));
document.getElementById('btn-viewer').addEventListener('click', () => {
    showPage('viewer');
    resetPin();
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

function getPinCode() {
    return Array.from(pinDigits).map(d => d.value).join('');
}

pinDigits.forEach((digit, idx) => {
    digit.addEventListener('input', (e) => {
        const val = e.target.value.replace(/\D/g, '');
        e.target.value = val.slice(-1);
        if (val) {
            digit.classList.add('filled');
            digit.classList.remove('error');
            if (idx < pinDigits.length - 1) pinDigits[idx + 1].focus();
        } else {
            digit.classList.remove('filled');
        }
        const code = getPinCode();
        if (code.length === 6) {
            checkSessionForPassword(code);
        }
        connectBtn.disabled = code.length < 6;
        pinError.textContent = '';
    });

    digit.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !digit.value && idx > 0) {
            pinDigits[idx - 1].focus();
            pinDigits[idx - 1].value = '';
            pinDigits[idx - 1].classList.remove('filled');
        }
        if (e.key === 'Enter' && getPinCode().length === 6) connectViewer();
    });

    digit.addEventListener('paste', (e) => {
        e.preventDefault();
        const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
        if (paste.length >= 6) {
            paste.slice(0, 6).split('').forEach((ch, i) => {
                pinDigits[i].value = ch;
                pinDigits[i].classList.add('filled');
            });
            pinDigits[5].focus();
            connectBtn.disabled = false;
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
        if (data.online && data.has_password) {
            pwSection.classList.remove('hidden');
        } else {
            pwSection.classList.add('hidden');
        }
    } catch { }
}


// ═══════════════════════════════════════════════════════
// FPS & Adaptive Flow
// ═══════════════════════════════════════════════════════

let frameCount = 0;
let lastFpsUpdate = performance.now();
let measuredFps = 0;
let fpsHistory = [];
let autoQualityEnabled = true;
let currentQualityProfile = 'medium';

function updateFpsCounter() {
    frameCount++;
    const now = performance.now();
    if (now - lastFpsUpdate >= 1000) {
        measuredFps = Math.round(frameCount * 1000 / (now - lastFpsUpdate));
        frameCount = 0;
        lastFpsUpdate = now;
        const fpsEl = document.getElementById('info-fps');
        if (fpsEl) fpsEl.textContent = measuredFps;

        // Adaptive Flow — обновляем индикатор
        updateConnectionIndicator(measuredFps);

        // Adaptive auto-quality
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
    if (fps >= 25) {
        indicator.classList.add('good');
        text.textContent = `${fps} FPS`;
    } else if (fps >= 12) {
        indicator.classList.add('medium');
        text.textContent = `${fps} FPS`;
    } else {
        indicator.classList.add('bad');
        text.textContent = `${fps} FPS`;
    }
}

function autoAdjustQuality(avgFps) {
    if (currentQualityProfile === 'high' && avgFps < 20) {
        switchQuality('medium');
    } else if (currentQualityProfile === 'medium' && avgFps < 10) {
        switchQuality('low');
    } else if (currentQualityProfile === 'low' && avgFps > 25) {
        switchQuality('medium');
    }
}

function switchQuality(profile) {
    currentQualityProfile = profile;
    send({ action: 'set_quality', profile });

    const qualitySelector = document.getElementById('quality-selector');
    qualitySelector.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active'));
    const btn = qualitySelector.querySelector(`[data-quality="${profile}"]`);
    if (btn) btn.classList.add('active');

    const labels = { 'low': 'Низкое', 'medium': 'Среднее', 'high': 'Высокое' };
    showToast(`📊 Авто-качество: ${labels[profile]}`);
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
            connectBtn.disabled = false;
            connectBtn.textContent = 'Подключиться';
            return;
        }
    } catch {
        pinError.textContent = 'Ошибка связи с сервером';
        connectBtn.disabled = false;
        connectBtn.textContent = 'Подключиться';
        return;
    }

    sessionCode = code;
    showPage('remote');
    loader.style.display = '';
    canvas.style.display = 'none';
    drawCanvas.style.display = 'none';
    document.getElementById('session-status').textContent = 'Подключение...';
    updateControlBadge(false);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const password = document.getElementById('session-password').value;
    ws = new WebSocket(`${protocol}//${location.host}/ws/viewer?code=${code}&password=${encodeURIComponent(password)}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        loader.style.display = 'none';
        canvas.style.display = '';
        drawCanvas.style.display = '';
        document.getElementById('session-status').textContent = 'В сети';
        connectionTime = Date.now();
        showToast('✅ Подключено!');
    };

    ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            updateFpsCounter();
            const blob = new Blob([e.data], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                if (canvas.width !== img.width || canvas.height !== img.height) {
                    canvas.width = img.width;
                    canvas.height = img.height;
                    drawCanvas.width = img.width;
                    drawCanvas.height = img.height;
                    const resEl = document.getElementById('info-resolution');
                    if (resEl) resEl.textContent = `${img.width}×${img.height}`;
                }
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
            };
            img.src = url;
        } else {
            try {
                const msg = JSON.parse(e.data);
                handleServerMessage(msg);
            } catch { }
        }
    };

    ws.onclose = (e) => {
        const msgs = {
            4001: 'Неверный код или хост оффлайн',
            4002: 'Слишком много зрителей',
            4003: '❌ Неверный пароль',
            4010: 'Хост завершил сеанс',
            4020: 'Хост вас выгнал',
        };
        if (msgs[e.code]) {
            showPage('viewer');
            pinError.textContent = msgs[e.code];
            pinDigits.forEach(d => d.classList.add('error'));
        } else {
            document.getElementById('session-status').textContent = 'Отключено';
        }
        connectBtn.disabled = false;
        connectBtn.textContent = 'Подключиться';
        closeAllOverlays();
        stopRecording();
    };

    setInterval(() => {
        if (connectionTime && ws && ws.readyState === WebSocket.OPEN) {
            const latencyEl = document.getElementById('info-latency');
            if (latencyEl) {
                const elapsed = Math.round((Date.now() - connectionTime) / 1000);
                const min = Math.floor(elapsed / 60);
                const sec = elapsed % 60;
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
            break;

        case 'monitor_list':
            renderMonitorSelector(msg.monitors || []);
            break;

        case 'chat':
            addChatMessage(msg);
            break;

        case 'draw':
            drawRemoteLine(msg);
            break;

        case 'draw_clear':
            drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
            break;

        case 'viewer_identity':
            myViewerId = msg.viewer_id;
            break;

        case 'cursor_pos':
            updateGhostCursor(msg);
            break;

        case 'cursor_remove':
            removeGhostCursor(msg.viewer_id);
            break;

        case 'clipboard_sync':
            handleClipboardReceive(msg.text);
            break;

        case 'screenshot_result':
            showScreenshot(msg.data);
            break;
    }
}


function updateControlBadge(allowed) {
    controlBadge.className = 'control-badge ' + (allowed ? 'allowed' : 'denied');
    controlBadge.textContent = allowed ? '🎮 Управление' : '👁️ Просмотр';
}

document.getElementById('close-session').addEventListener('click', () => {
    if (ws) ws.close();
    ws = null;
    sessionCode = '';
    connectionTime = 0;
    showPage('landing');
    closeAllOverlays();
    disableDrawMode();
    stopRecording();
    clearGhostCursors();
});


// ═══════════════════════════════════════════════════════
// УПРАВЛЕНИЕ: мышь + клавиатура
// ═══════════════════════════════════════════════════════

function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function sendControl(data) {
    if (!controlAllowed) return;
    send(data);
}

function coords(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

let lastMove = 0;
let lastCursorSend = 0;
canvas.addEventListener('mousemove', (e) => {
    if (drawingMode) return;
    const now = Date.now();
    // Отправляем позицию курсора для ghost cursors (каждые 100ms)
    if (now - lastCursorSend > 100) {
        const c = coords(e);
        send({ type: 'cursor_pos', x: c.x, y: c.y });
        lastCursorSend = now;
    }
    if (!controlAllowed) return;
    if (now - lastMove > 50) {
        sendControl({ action: 'move', ...coords(e) });
        lastMove = now;
    }
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
    if (e.target.closest('.overlay-panel') || e.target.closest('.chat-input-area')) return;
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


// ═══════════════════════════════════════════════════════
// Focus Mode
// ═══════════════════════════════════════════════════════

let focusMode = false;
document.getElementById('btn-focus').addEventListener('click', () => {
    focusMode = !focusMode;
    const nav = document.getElementById('glass-nav');
    const toolbar = document.querySelector('.floating-toolbar');
    if (focusMode) {
        nav.classList.add('nav-hidden');
        toolbar.classList.add('toolbar-hidden');
        showToast('👁️ Focus Mode — двойной клик для выхода');
    } else {
        nav.classList.remove('nav-hidden');
        toolbar.classList.remove('toolbar-hidden');
    }
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

const settingsOverlay = document.getElementById('settings-overlay');
const syskeysOverlay = document.getElementById('syskeys-overlay');
const chatOverlay = document.getElementById('chat-overlay');
const quickActionsOverlay = document.getElementById('quickactions-overlay');
const btnSettings = document.getElementById('btn-settings');
const btnSyskeys = document.getElementById('btn-syskeys');
const btnChat = document.getElementById('btn-chat');
const btnDraw = document.getElementById('btn-draw');
const btnQuickActions = document.getElementById('btn-quickactions');

function closeAllOverlays() {
    settingsOverlay.classList.add('hidden');
    syskeysOverlay.classList.add('hidden');
    chatOverlay.classList.add('hidden');
    quickActionsOverlay.classList.add('hidden');
    btnSettings.classList.remove('active');
    btnSyskeys.classList.remove('active');
    btnChat.classList.remove('active');
    btnQuickActions.classList.remove('active');
}

function toggleOverlay(overlay, btn) {
    const isHidden = overlay.classList.contains('hidden');
    closeAllOverlays();
    if (isHidden) {
        overlay.classList.remove('hidden');
        btn.classList.add('active');
    }
}

btnSettings.addEventListener('click', () => toggleOverlay(settingsOverlay, btnSettings));
btnSyskeys.addEventListener('click', () => toggleOverlay(syskeysOverlay, btnSyskeys));
btnQuickActions.addEventListener('click', () => toggleOverlay(quickActionsOverlay, btnQuickActions));
btnChat.addEventListener('click', () => {
    toggleOverlay(chatOverlay, btnChat);
    btnChat.classList.remove('has-unread');
    if (!chatOverlay.classList.contains('hidden')) {
        document.getElementById('chat-input').focus();
    }
});

btnDraw.addEventListener('click', () => {
    if (drawingMode) disableDrawMode();
    else enableDrawMode();
});

document.querySelectorAll('.overlay-close').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.dataset.close;
        if (targetId) {
            document.getElementById(targetId).classList.add('hidden');
        }
        // Screenshot modal
        if (btn.id === 'screenshot-close') {
            document.getElementById('screenshot-modal').classList.add('hidden');
        }
        btnSettings.classList.remove('active');
        btnSyskeys.classList.remove('active');
        btnChat.classList.remove('active');
        btnQuickActions.classList.remove('active');
    });
});

document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.overlay-panel') &&
        !e.target.closest('.nav-icon-btn') &&
        !e.target.closest('.draw-toolbar') &&
        !e.target.closest('.screenshot-modal')) {
        closeAllOverlays();
    }
});


// ═══ Quality Selector ═══
const qualitySelector = document.getElementById('quality-selector');
qualitySelector.addEventListener('click', (e) => {
    const btn = e.target.closest('.q-btn');
    if (!btn) return;
    const quality = btn.dataset.quality;

    qualitySelector.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentQualityProfile = quality;

    send({ action: 'set_quality', profile: quality });
    showToast(`📊 Качество: ${{ 'low': 'Низкое (15 FPS)', 'medium': 'Среднее (30 FPS)', 'high': 'Высокое (60 FPS)' }[quality]}`);
});


// ═══ Monitor Selector ═══
function renderMonitorSelector(monitors) {
    const container = document.getElementById('monitor-selector');
    if (!monitors.length) {
        container.innerHTML = '<span class="monitor-info">1 монитор</span>';
        return;
    }
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
        if (heldModifiers.has(mod)) {
            heldModifiers.delete(mod);
            btn.classList.remove('held');
            sendControl({ action: 'keyup', key: mod });
        } else {
            heldModifiers.add(mod);
            btn.classList.add('held');
            sendControl({ action: 'keydown', key: mod });
        }
    });
});

document.querySelectorAll('.syskey-btn:not(.modifier-btn):not(.hotkey-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (!key) return;
        if (heldModifiers.size > 0) {
            const keys = [...heldModifiers, key];
            sendControl({ action: 'hotkey', keys });
            releaseAllModifiers();
        } else {
            sendControl({ action: 'key', key });
        }
        btn.style.transform = 'scale(0.9)';
        setTimeout(() => btn.style.transform = '', 150);
    });
});

document.querySelectorAll('.hotkey-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const hotkey = btn.dataset.hotkey;
        if (!hotkey) return;
        const keys = hotkey.split(',');
        sendControl({ action: 'hotkey', keys });
        btn.style.transform = 'scale(0.9)';
        setTimeout(() => btn.style.transform = '', 150);
    });
});

function releaseAllModifiers() {
    heldModifiers.forEach(mod => {
        sendControl({ action: 'keyup', key: mod });
    });
    heldModifiers.clear();
    document.querySelectorAll('.modifier-btn').forEach(b => b.classList.remove('held'));
}


// ═══════════════════════════════════════════════════════
// ⚡ Quick Actions
// ═══════════════════════════════════════════════════════

document.querySelectorAll('.qa-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const quick = btn.dataset.quick;
        if (!quick) return;

        if (quick === 'lock_screen') {
            if (!confirm('Заблокировать экран хоста? Потребуется ввести пароль Windows.')) return;
        }

        sendControl({ action: 'quick_action', quick });

        btn.style.transform = 'scale(0.92)';
        setTimeout(() => btn.style.transform = '', 200);

        const labels = {
            minimize_all: '🗕 Свернуто',
            show_desktop: '🖥️ Рабочий стол',
            task_manager: '📊 Диспетчер задач',
            open_explorer: '📁 Проводник',
            screenshot: '📸 Скриншот...',
            lock_screen: '🔒 Блокировка',
        };
        showToast(labels[quick] || '⚡ Действие отправлено');
    });
});


// ═══════════════════════════════════════════════════════
// 📋 Clipboard Sync
// ═══════════════════════════════════════════════════════

document.getElementById('btn-clipboard').addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            send({ type: 'clipboard_sync', text: text.substring(0, 10000) });
            showToast('📋 Буфер отправлен хосту');
        } else {
            showToast('📋 Буфер пуст');
        }
    } catch (err) {
        showToast('📋 Нет доступа к буферу (нужен HTTPS)');
    }
});

function handleClipboardReceive(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        showToast(`📋 Буфер получен (${text.length} символов)`);
    }).catch(() => {
        showToast('📋 Не удалось записать в буфер');
    });
}


// ═══════════════════════════════════════════════════════
// 👻 Ghost Cursors
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
            <span class="ghost-label" style="background:${msg.color}">${msg.viewer_id}</span>
        `;
        ghostLayer.appendChild(cursor);
        ghostCursors[msg.viewer_id] = cursor;
    }

    // Позиционирование относительно viewport
    const rect = canvas.getBoundingClientRect();
    const layerRect = ghostLayer.getBoundingClientRect();
    const x = rect.left - layerRect.left + msg.x * rect.width;
    const y = rect.top - layerRect.top + msg.y * rect.height;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
}

function removeGhostCursor(viewerId) {
    const cursor = ghostCursors[viewerId];
    if (cursor) {
        cursor.style.opacity = '0';
        setTimeout(() => {
            cursor.remove();
            delete ghostCursors[viewerId];
        }, 300);
    }
}

function clearGhostCursors() {
    Object.keys(ghostCursors).forEach(id => {
        ghostCursors[id].remove();
        delete ghostCursors[id];
    });
}


// ═══════════════════════════════════════════════════════
// 📁 OrbDrop — File Drag & Drop
// ═══════════════════════════════════════════════════════

const viewportContainer = document.getElementById('viewport-container');
const dropOverlay = document.getElementById('drop-overlay');
let dragCounter = 0;

viewportContainer.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.remove('hidden');
});

viewportContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
        dragCounter = 0;
        dropOverlay.classList.add('hidden');
    }
});

viewportContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
});

viewportContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.add('hidden');

    const files = e.dataTransfer.files;
    if (!files.length || !sessionCode) return;

    for (const file of files) {
        if (file.size > 50 * 1024 * 1024) {
            showToast(`❌ ${file.name} слишком большой (макс. 50 MB)`);
            continue;
        }

        showToast(`📤 Отправка: ${file.name}...`);

        const formData = new FormData();
        formData.append('file', file);

        try {
            const resp = await fetch(`/api/upload/${sessionCode}`, {
                method: 'POST',
                body: formData,
            });
            if (resp.ok) {
                const data = await resp.json();
                showToast(`✅ ${file.name} отправлен (${data.size_kb} KB)`);
            } else {
                showToast(`❌ Ошибка отправки ${file.name}`);
            }
        } catch {
            showToast(`❌ Ошибка сети при отправке ${file.name}`);
        }
    }
});


// ═══════════════════════════════════════════════════════
// 📸 Screenshot Modal
// ═══════════════════════════════════════════════════════

function showScreenshot(base64Data) {
    const modal = document.getElementById('screenshot-modal');
    const img = document.getElementById('screenshot-img');
    const dl = document.getElementById('screenshot-download');

    img.src = `data:image/png;base64,${base64Data}`;
    dl.href = img.src;
    modal.classList.remove('hidden');
    showToast('📸 Скриншот готов!');
}

document.getElementById('screenshot-close').addEventListener('click', () => {
    document.getElementById('screenshot-modal').classList.add('hidden');
});


// ═══════════════════════════════════════════════════════
// ⏺ Session Recording
// ═══════════════════════════════════════════════════════

let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;

const btnRecord = document.getElementById('btn-record');

btnRecord.addEventListener('click', () => {
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
});

function startRecording() {
    try {
        const stream = canvas.captureStream(30);
        mediaRecorder = new MediaRecorder(stream, {
            mimeType: 'video/webm;codecs=vp9',
            videoBitsPerSecond: 3000000,
        });

        recordedChunks = [];
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const now = new Date();
            a.download = `OrbDesk_${now.toISOString().slice(0, 19).replace(/[:-]/g, '')}.webm`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('💾 Запись сохранена!');
        };

        mediaRecorder.start(1000);
        isRecording = true;
        btnRecord.classList.add('recording');
        btnRecord.textContent = '⏹';
        showToast('⏺ Запись начата');
    } catch (err) {
        showToast('❌ Не удалось начать запись');
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        btnRecord.classList.remove('recording');
        btnRecord.textContent = '⏺';
    }
}


// ═══════════════════════════════════════════════════════
// 💬 ЧАТ
// ═══════════════════════════════════════════════════════

const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send');
const chatMessages = document.getElementById('chat-messages');

chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
    e.stopPropagation();
});

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    const msg = { type: 'chat', text, time: Date.now() };
    send(msg);
    addChatMessage({ ...msg, from: 'me' });
    chatInput.value = '';
}

function addChatMessage(msg) {
    const div = document.createElement('div');
    const isMe = msg.from === 'me';
    const isHost = msg.from === 'host';
    div.className = 'chat-bubble ' + (isMe ? 'chat-me' : isHost ? 'chat-host' : 'chat-viewer');

    const time = new Date(msg.time || Date.now());
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const label = isMe ? '' : isHost ? '<span class="chat-sender">🖥️ Хост</span>' : '<span class="chat-sender">🎮 Зритель</span>';
    div.innerHTML = `${label}<span class="chat-text">${escapeHtml(msg.text)}</span><span class="chat-time">${timeStr}</span>`;

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (chatOverlay.classList.contains('hidden') && !isMe) {
        btnChat.classList.add('has-unread');
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}


// ═══════════════════════════════════════════════════════
// ✏️ РИСОВАНИЕ
// ═══════════════════════════════════════════════════════

let drawColor = '#ff4444';
let drawSize = 3;
let isDrawing = false;
let lastDrawX = 0, lastDrawY = 0;
const drawToolbar = document.getElementById('draw-toolbar');

function enableDrawMode() {
    drawingMode = true;
    btnDraw.classList.add('active');
    drawToolbar.classList.remove('hidden');
    drawCanvas.style.pointerEvents = 'auto';
    drawCanvas.style.cursor = 'crosshair';
    showToast('✏️ Режим рисования');
}

function disableDrawMode() {
    drawingMode = false;
    btnDraw.classList.remove('active');
    drawToolbar.classList.add('hidden');
    drawCanvas.style.pointerEvents = 'none';
    drawCanvas.style.cursor = 'default';
}

document.querySelectorAll('.draw-color').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.draw-color').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        drawColor = btn.dataset.color;
    });
});

document.querySelectorAll('.draw-size').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.draw-size').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        drawSize = parseInt(btn.dataset.size);
    });
});

document.getElementById('draw-clear').addEventListener('click', () => {
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    send({ type: 'draw_clear' });
});

drawCanvas.addEventListener('mousedown', (e) => {
    if (!drawingMode) return;
    isDrawing = true;
    const r = drawCanvas.getBoundingClientRect();
    lastDrawX = (e.clientX - r.left) / r.width;
    lastDrawY = (e.clientY - r.top) / r.height;
});

drawCanvas.addEventListener('mousemove', (e) => {
    if (!drawingMode || !isDrawing) return;
    const r = drawCanvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;

    drawLine(lastDrawX, lastDrawY, x, y, drawColor, drawSize);
    send({ type: 'draw', x1: lastDrawX, y1: lastDrawY, x2: x, y2: y, color: drawColor, size: drawSize });

    lastDrawX = x;
    lastDrawY = y;
});

drawCanvas.addEventListener('mouseup', () => { isDrawing = false; });
drawCanvas.addEventListener('mouseleave', () => { isDrawing = false; });

function drawLine(x1, y1, x2, y2, color, size) {
    const w = drawCanvas.width;
    const h = drawCanvas.height;
    drawCtx.beginPath();
    drawCtx.moveTo(x1 * w, y1 * h);
    drawCtx.lineTo(x2 * w, y2 * h);
    drawCtx.strokeStyle = color;
    drawCtx.lineWidth = size;
    drawCtx.lineCap = 'round';
    drawCtx.stroke();
}

function drawRemoteLine(msg) {
    drawLine(msg.x1, msg.y1, msg.x2, msg.y2, msg.color, msg.size);
}


// ═══════════════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════════════

let toastTimeout = null;

function showToast(message) {
    let toast = document.querySelector('.toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 2500);
}
