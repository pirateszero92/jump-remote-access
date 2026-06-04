const protoPorts = { VNC: 5900, RDP: 3389, SSH: 22 };
const protoIcon = {
  VNC: '<i class="fa-solid fa-display"></i>',
  RDP: '<i class="fa-brands fa-windows"></i>',
  SSH: '<i class="fa-solid fa-terminal"></i>',
};
const SSH_TIMEOUT_KEY = 'jump:ssh-timeout-minutes';
const LOG_HEIGHT_KEY = 'jump:log-height';
const LOG_COLLAPSED_KEY = 'jump:log-collapsed';
const SIDEBAR_COLLAPSED_KEY = 'jump:sidebar-collapsed';
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour inactivity timeout
const LAST_ACTIVITY_KEY = 'jump:last-activity';
let inactivityTimer = null;
const MIN_SSH_TIMEOUT_MINUTES = 1;
const MAX_SSH_TIMEOUT_MINUTES = 240;
const DEFAULT_SSH_TIMEOUT_MINUTES = 15;
const MIN_LOG_HEIGHT = 120;
const MAX_LOG_HEIGHT = 320;
const DEFAULT_LOG_HEIGHT = 160;

let activeProto = 'VNC';
const sessions = [];
let activeSessionId = null;
let sessionSeq = 0;
let pendingDelete = null;
let selectedId = null;
let cachedTargets = [];
let targetFilterTerm = '';
let keyImportTargetId = null;
let currentUser = null;

const importInput = document.getElementById('import-file');
const targetFilterInput = document.getElementById('target-filter');
const sshTimeoutInput = document.getElementById('ssh-timeout-minutes');
const sshTimeoutWrap = document.getElementById('ssh-timeout-wrap');
const rdpAuthWrap = document.getElementById('rdp-auth-wrap');
const rdpDomainWrap = document.getElementById('rdp-domain-wrap');
const authModeSelect = document.getElementById('auth-mode');
const domainInput = document.getElementById('domain');
const usernameLabel = document.getElementById('username-label');
const passwordLabel = document.getElementById('password-label');
const qualitySelect = document.getElementById('quality');
const clearLogButton = document.getElementById('clear-log');
const toggleLogButton = document.getElementById('toggle-log');
const logHeightInput = document.getElementById('log-height');
const opsConsole = document.getElementById('ops-console');
const logPanel = document.getElementById('log-panel');
const vtLabelEl = document.getElementById('vtlabel');
const vtIpEl = document.getElementById('vtip');
const vtMetaEl = document.getElementById('vtmeta');
const vtActionsEl = document.getElementById('vt-actions');
const vtStateEl = document.getElementById('vt-state');
const vtStateTextEl = document.getElementById('vt-state-text');
const sessionTabsWrapEl = document.getElementById('session-tabs-wrap');
const sessionTabsEl = document.getElementById('session-tabs');
const sessionStageEl = document.getElementById('session-stage');
const sshBridgeChipEl = document.getElementById('chip-ssh-bridge');

function getSessionById(id) {
  return sessions.find((entry) => entry.id === id) || null;
}

function getActiveSession() {
  return getSessionById(activeSessionId);
}

function refreshSshBridgeChip() {
  const hasConnectedSsh = sessions.some((entry) => entry.proto === 'SSH' && entry.status === 'connected');
  setSshBridgeChip(hasConnectedSsh);
}

function setSshBridgeChip(isConnected) {
  if (!sshBridgeChipEl) {
    return;
  }

  sshBridgeChipEl.className = isConnected ? 'sdot g' : 'sdot a';
}

function setConnectionBadge(state, label = state) {
  if (!vtStateEl || !vtStateTextEl) {
    return;
  }

  const cssState = ({ connected: 'ok', connecting: 'warn', disconnected: 'err', timeout: 'warn', error: 'err' })[state] || '';
  vtStateEl.classList.remove('ok', 'warn', 'err');
  if (cssState) {
    vtStateEl.classList.add(cssState);
  }

  vtStateTextEl.textContent = label;
  vtStateEl.style.display = '';
}

function clearConnectionBadge() {
  if (!vtStateEl) {
    return;
  }

  vtStateEl.classList.remove('ok', 'warn', 'err');
  vtStateEl.style.display = 'none';
}

function updateConnectionHeaderForSession(session, options = {}) {
  const showMeta = Boolean(options.showMeta);
  const metaText = String(options.metaText || '').trim();
  const status = options.status || 'connected';
  const statusLabel = options.statusLabel || status;

  vtLabelEl.textContent = `${session.proto} Connected:`;
  vtIpEl.textContent = `${session.ip}:${session.port}`;
  vtIpEl.style.display = '';
  vtActionsEl.style.display = '';
  setConnectionBadge(status, statusLabel);
  refreshSshBridgeChip();

  const btnReconnect = document.getElementById('btn-reconnect');
  if (btnReconnect) {
    const isDisconnected = ['disconnected', 'error', 'timeout'].includes(session.status);
    btnReconnect.style.display = isDisconnected ? '' : 'none';
  }

  if (showMeta && metaText) {
    vtMetaEl.textContent = metaText;
    vtMetaEl.style.display = '';
  } else {
    vtMetaEl.textContent = '';
    vtMetaEl.style.display = 'none';
  }
}

function clearConnectionHeader() {
  vtLabelEl.textContent = 'No active connection';
  vtIpEl.style.display = 'none';
  vtMetaEl.style.display = 'none';
  vtMetaEl.textContent = '';
  vtActionsEl.style.display = 'none';
  clearConnectionBadge();
  refreshSshBridgeChip();

  const btnReconnect = document.getElementById('btn-reconnect');
  if (btnReconnect) {
    btnReconnect.style.display = 'none';
  }
}

function statusToBadgeState(status) {
  if (status === 'connected') {
    return 'connected';
  }

  if (status === 'connecting' || status === 'timeout') {
    return 'connecting';
  }

  return 'disconnected';
}

function statusToTabClass(status) {
  if (status === 'connected') {
    return 'ok';
  }

  if (status === 'error' || status === 'disconnected') {
    return 'err';
  }

  return '';
}

function getSessionLabel(session) {
  const preferred = String(session.label || '').trim();
  if (preferred) {
    return preferred;
  }

  return `${session.ip}:${session.port}`;
}

function renderSessionTabs() {
  if (!sessionTabsEl || !sessionTabsWrapEl) {
    return;
  }

  if (!sessions.length) {
    sessionTabsWrapEl.style.display = 'none';
    sessionTabsEl.innerHTML = '';
    return;
  }

  sessionTabsWrapEl.style.display = '';
  sessionTabsEl.innerHTML = sessions.map((session) => {
    const tabStateClass = statusToTabClass(session.status);
    const activeClass = session.id === activeSessionId ? 'active' : '';
    const iconClass = session.proto === 'SSH'
      ? 'fa-solid fa-terminal'
      : session.proto === 'RDP'
        ? 'fa-brands fa-windows'
        : 'fa-solid fa-display';
    const title = getSessionLabel(session);

    return `
      <div class="session-tab ${activeClass}" id="session-tab-${session.id}" onclick="activateSession('${session.id}')">
        <span class="session-tab-icon"><i class="${iconClass}"></i></span>
        <span class="session-tab-name" title="${esca(title)}">${esc(title)}</span>
        <span class="session-tab-state ${tabStateClass}"></span>
        <button type="button" class="session-tab-close" onclick="closeSessionFromTab(event, '${session.id}')" aria-label="Close session"><i class="fa-solid fa-xmark"></i></button>
      </div>
    `;
  }).join('');
}

function applySessionView(session) {
  if (!session) {
    clearConnectionHeader();
    setView('idle');
    return;
  }

  setView('vnc');
  updateConnectionHeaderForSession(session, {
    showMeta: session.showHeaderMeta,
    metaText: session.headerMeta,
    status: statusToBadgeState(session.status),
    statusLabel: session.statusLabel || session.status || 'connected',
  });
}

function notifyEmbeddedRdpSessionsResize() {
  sessions.forEach((session) => {
    if (session.proto !== 'RDP' || !session.iframeEl?.contentWindow) {
      return;
    }

    session.iframeEl.contentWindow.postMessage(
      { type: 'jump-rdp-resize' },
      window.location.origin,
    );
  });
}

function activateSession(sessionId) {
  const next = getSessionById(sessionId);
  if (!next) {
    return;
  }

  activeSessionId = sessionId;

  sessions.forEach((session) => {
    if (session.paneEl) {
      session.paneEl.classList.toggle('active', session.id === sessionId);
    }
  });

  renderSessionTabs();
  applySessionView(next);
  requestAnimationFrame(notifyEmbeddedRdpSessionsResize);
}

function createSessionPane(url, title) {
  const paneEl = document.createElement('div');
  paneEl.className = 'session-pane';

  const iframe = document.createElement('iframe');
  iframe.allow = 'fullscreen';
  iframe.title = title;
  iframe.src = url;

  iframe.addEventListener('load', () => {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) {
        bindActivityListeners(doc);
      }
    } catch (error) {
      console.warn('Failed to bind activity listeners inside iframe:', error);
    }
  });

  paneEl.appendChild(iframe);
  sessionStageEl.appendChild(paneEl);

  return { paneEl, iframe };
}

function findSessionBySourceWindow(sourceWindow) {
  return sessions.find((entry) => entry.iframeEl?.contentWindow === sourceWindow) || null;
}

function updateSessionStatus(session, status, statusLabel = status) {
  if (!session) {
    return;
  }

  const previousStatus = session.status;
  session.status = status;
  session.statusLabel = statusLabel;

  renderSessionTabs();
  refreshSshBridgeChip();

  if (session.id === activeSessionId) {
    applySessionView(session);
  }

  if (previousStatus !== status) {
    if (status === 'timeout') {
      addLog('warn', `${getSessionLabel(session)} idle-timeout`);
    } else if (status === 'disconnected') {
      addLog('warn', `${getSessionLabel(session)} disconnected`);
    } else if (status === 'error') {
      addLog('err', `${getSessionLabel(session)} error`);
    }
  }
}

async function cleanupSessionResources(session) {
  if (!session) {
    return;
  }

  if (session.token && (session.proto === 'VNC' || session.proto === 'RDP')) {
    try {
      await api('DELETE', `/session/${session.token}`);
    } catch {
      // Ignore cleanup errors
    }
  }

  if (session.iframeEl) {
    session.iframeEl.src = '';
  }

  session.paneEl?.remove();
}

async function closeSessionById(sessionId, options = {}) {
  const index = sessions.findIndex((entry) => entry.id === sessionId);
  if (index === -1) {
    return;
  }

  const [session] = sessions.splice(index, 1);
  await cleanupSessionResources(session);

  if (activeSessionId === sessionId) {
    const replacement = sessions[index] || sessions[index - 1] || null;
    activeSessionId = replacement ? replacement.id : null;
  }

  renderSessionTabs();

  if (activeSessionId) {
    activateSession(activeSessionId);
  } else {
    clearConnectionHeader();
    setView('idle');
  }

  if (!options.silent) {
    addLog('warn', `Closed session: ${getSessionLabel(session)}`);
  }
}

async function closeAllSessions() {
  const ids = sessions.map((entry) => entry.id);
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await closeSessionById(id, { silent: true });
  }
}

async function closeSessionFromTab(event, sessionId) {
  event.stopPropagation();
  await closeSessionById(sessionId);
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function getSshTimeoutMinutes() {
  return clampInteger(sshTimeoutInput?.value, DEFAULT_SSH_TIMEOUT_MINUTES, MIN_SSH_TIMEOUT_MINUTES, MAX_SSH_TIMEOUT_MINUTES);
}

function persistSshTimeoutMinutes() {
  if (!sshTimeoutInput) {
    return;
  }

  const normalized = getSshTimeoutMinutes();
  sshTimeoutInput.value = String(normalized);
  localStorage.setItem(SSH_TIMEOUT_KEY, String(normalized));
}

function setLogHeight(height) {
  const normalized = clampInteger(height, DEFAULT_LOG_HEIGHT, MIN_LOG_HEIGHT, MAX_LOG_HEIGHT);
  document.documentElement.style.setProperty('--ops-height', `${normalized}px`);
  if (logHeightInput) {
    logHeightInput.value = String(normalized);
  }

  localStorage.setItem(LOG_HEIGHT_KEY, String(normalized));
}

function setLogCollapsed(collapsed) {
  if (!opsConsole) {
    return;
  }

  opsConsole.classList.toggle('collapsed', collapsed);
  if (toggleLogButton) {
    toggleLogButton.textContent = collapsed ? 'Show' : 'Hide';
  }

  if (logHeightInput) {
    logHeightInput.disabled = collapsed;
  }

  localStorage.setItem(LOG_COLLAPSED_KEY, collapsed ? '1' : '0');
}

function setSidebarCollapsed(collapsed) {
  const panelLeft = document.querySelector('.panel-left');
  const btn = document.getElementById('sidebar-toggle-btn');
  if (!panelLeft) {
    return;
  }

  panelLeft.classList.toggle('collapsed', collapsed);
  if (btn) {
    btn.classList.toggle('collapsed', collapsed);
    btn.title = collapsed ? 'Show Panel' : 'Hide Panel';
    btn.innerHTML = collapsed ? '<i class="fa-solid fa-chevron-right"></i>' : '<i class="fa-solid fa-bars"></i>';
  }

  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');

  // Trigger resize for embedded sessions (VNC/SSH listen on parent resize; RDP uses postMessage)
  window.dispatchEvent(new Event('resize'));
  notifyEmbeddedRdpSessionsResize();
}

function toggleSidebar() {
  const panelLeft = document.querySelector('.panel-left');
  const isCollapsed = panelLeft ? panelLeft.classList.contains('collapsed') : false;
  setSidebarCollapsed(!isCollapsed);
}

function resetInactivityTimeout() {
  localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
  scheduleInactivityLogout();
}

function checkInactivity() {
  const lastActivity = Number.parseInt(localStorage.getItem(LAST_ACTIVITY_KEY) || '0', 10);
  if (!lastActivity) {
    resetInactivityTimeout();
    return;
  }

  const elapsed = Date.now() - lastActivity;
  if (elapsed >= INACTIVITY_TIMEOUT_MS) {
    addLog('warn', 'Session expired due to inactivity');
    handleLogout();
  }
}

function scheduleInactivityLogout() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }

  const lastActivity = Number.parseInt(localStorage.getItem(LAST_ACTIVITY_KEY) || '0', 10);
  const elapsed = Date.now() - (lastActivity || Date.now());
  const remaining = Math.max(0, INACTIVITY_TIMEOUT_MS - elapsed);

  inactivityTimer = setTimeout(() => {
    checkInactivity();
  }, remaining + 100);
}

function bindActivityListeners(targetWindowOrDocument) {
  const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'];

  let lastMouseMoveTime = 0;
  const onMouseMove = () => {
    const now = Date.now();
    if (now - lastMouseMoveTime > 2000) {
      lastMouseMoveTime = now;
      resetInactivityTimeout();
    }
  };

  events.forEach((type) => {
    try {
      targetWindowOrDocument.addEventListener(type, resetInactivityTimeout, { capture: true, passive: true });
    } catch (e) {
      console.warn(`Failed to add ${type} capture event listener:`, e);
    }
  });

  try {
    targetWindowOrDocument.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
  } catch (e) {
    console.warn('Failed to add mousemove event listener:', e);
  }
}

function triggerKeyImport(targetId = null) {
  keyImportTargetId = targetId;
  document.getElementById('key-file').click();
}

async function importKeyFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';

  if (!file) {
    keyImportTargetId = null;
    return;
  }

  try {
    const text = await file.text().then((content) => content.trim());
    if (!text.includes('PRIVATE KEY')) {
      showToast('ไฟล์นี้ไม่ใช่ private key ที่รองรับ');
      addLog('warn', `Key import skipped: ${file.name} does not look like a PEM private key`);
      return;
    }

    const fieldId = keyImportTargetId ? `epriv-${keyImportTargetId}` : 'privateKey';
    const field = document.getElementById(fieldId);
    if (!field) {
      throw new Error('Private key field not found');
    }

    field.value = text;
    addLog('ok', `Imported private key from ${file.name}`);
    showToast(`นำเข้า private key จาก ${file.name} แล้ว`);
  } catch (error) {
    showToast('อ่านไฟล์ private key ไม่สำเร็จ');
    addLog('err', `Key import error: ${error.message}`);
  } finally {
    keyImportTargetId = null;
  }
}

function restoreUiPreferences() {
  if (!sshTimeoutInput) {
    return;
  }

  const timeoutMinutes = clampInteger(localStorage.getItem(SSH_TIMEOUT_KEY), DEFAULT_SSH_TIMEOUT_MINUTES, MIN_SSH_TIMEOUT_MINUTES, MAX_SSH_TIMEOUT_MINUTES);
  sshTimeoutInput.value = String(timeoutMinutes);

  const logHeight = clampInteger(localStorage.getItem(LOG_HEIGHT_KEY), DEFAULT_LOG_HEIGHT, MIN_LOG_HEIGHT, MAX_LOG_HEIGHT);
  setLogHeight(logHeight);

  const logCollapsed = localStorage.getItem(LOG_COLLAPSED_KEY) === '1';
  setLogCollapsed(logCollapsed);

  const sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  setSidebarCollapsed(sidebarCollapsed);
}

function isDomainAuthMode() {
  return authModeSelect?.value === 'domain';
}

function updateProtocolDependentControls() {
  if (!qualitySelect || !sshTimeoutWrap) {
    return;
  }

  const isVnc = activeProto === 'VNC';
  const isSsh = activeProto === 'SSH';
  const isRdp = activeProto === 'RDP';

  qualitySelect.style.opacity = isVnc ? '1' : '0.4';
  qualitySelect.disabled = !isVnc;
  sshTimeoutWrap.style.display = isSsh ? '' : 'none';
  document.getElementById('privatekey-wrap').style.display = isSsh ? '' : 'none';

  if (rdpAuthWrap) {
    rdpAuthWrap.style.display = isRdp ? '' : 'none';
  }

  if (rdpDomainWrap) {
    rdpDomainWrap.style.display = isRdp && isDomainAuthMode() ? '' : 'none';
  }

  if (usernameLabel) {
    usernameLabel.textContent = isVnc ? 'Username (optional)' : 'Username';
  }

  if (passwordLabel) {
    passwordLabel.textContent = isVnc ? 'Password (optional)' : 'Password';
  }
}

function setProto(proto, el, options = {}) {
  const applyDefaultPort = options.applyDefaultPort !== false;
  activeProto = proto;
  document.querySelectorAll('.ptab').forEach((tab) => tab.classList.remove('av', 'as'));

  if (el) {
    el.classList.add(proto === 'VNC' ? 'av' : 'as');
  }

  if (applyDefaultPort) {
    document.getElementById('port').value = protoPorts[proto];
  }

  updateProtocolDependentControls();
}

function togglePass(id, btn) {
  const input = document.getElementById(id);
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.innerHTML = input.type === 'password' ? '<i class="fa-regular fa-eye"></i>' : '<i class="fa-regular fa-eye-slash"></i>';
}

function toggleEditPass(id, btn) {
  const input = document.getElementById(`epass-${id}`);
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.innerHTML = input.type === 'password' ? '<i class="fa-regular fa-eye"></i>' : '<i class="fa-regular fa-eye-slash"></i>';
}

async function api(method, route, body) {
  const response = await fetch(`/api${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = { error: await response.text() };
    }

    if (response.status === 401 && !window.location.pathname.endsWith('login.html')) {
      window.location.href = '/login.html';
      return;
    }

    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function loadHealth() {
  const apiChip = document.getElementById('chip-api');
  const wsChip = document.getElementById('chip-websockify');

  try {
    await api('GET', '/health');
    apiChip.className = 'sdot g';
    wsChip.className = 'sdot g';
  } catch {
    apiChip.className = 'sdot a';
    wsChip.className = 'sdot a';
  }
}

async function loadTargets() {
  try {
    cachedTargets = await api('GET', '/targets');
    renderTargets();
  } catch (error) {
    document.getElementById('tcon').innerHTML = `<div class="empty-t">Load failed<br>${esc(error.message)}</div>`;
  }
}

function getFilteredTargets() {
  if (!targetFilterTerm) {
    return cachedTargets;
  }

  return cachedTargets.filter((target) => {
    const indexText = `${target.name} ${target.ip} ${target.port} ${target.proto} ${target.user || ''}`.toLowerCase();
    return indexText.includes(targetFilterTerm);
  });
}

function renderTargets() {
  const container = document.getElementById('tcon');
  const targets = getFilteredTargets();

  if (!cachedTargets.length) {
    container.innerHTML = '<div class="empty-t">ยังไม่มี Saved Targets<br>กด Connect เพื่อบันทึกรายการใหม่</div>';
    return;
  }

  if (!targets.length) {
    container.innerHTML = '<div class="empty-t">ไม่พบ server ตามเงื่อนไข filter</div>';
    return;
  }

  container.innerHTML = targets.map((target) => `
    <div class="titem ${target.id === selectedId ? 'sel' : ''}" id="ti-${target.id}">
      <div class="tmain compact" onclick="selectTarget('${target.id}')">
        <div class="tico-small ${target.proto.toLowerCase()}">${protoIcon[target.proto] || '<i class="fa-solid fa-server"></i>'}</div>
        <div class="tinfo">
          <div class="tname" title="${esc(target.ip)}:${target.port} - ${target.proto}">${esc(target.name || target.ip)}</div>
        </div>
        <div class="tacts-compact">
          <button class="tcbtn cb" type="button" title="เชื่อมต่อ" onclick="quickConnect('${target.id}'); event.stopPropagation();"><i class="fa-solid fa-play"></i></button>
          ${currentUser?.permissions?.manageTargets ? `
          <button class="tcbtn eb" type="button" title="แก้ไข" onclick="toggleEdit('${target.id}'); event.stopPropagation();"><i class="fa-solid fa-pen"></i></button>
          <button class="tcbtn db" type="button" title="ลบ" onclick="askDelete('${target.id}', '${esca(target.name)}'); event.stopPropagation();"><i class="fa-solid fa-trash"></i></button>
          ` : ''}
        </div>
      </div>
      <div class="tedit" id="edit-${target.id}">
        <div class="egrid">
          <div class="full"><div class="elabel">Label</div><input class="einput" id="en-${target.id}" value="${esca(target.name)}"></div>
          <div><div class="elabel">IP / Host</div><input class="einput" id="eip-${target.id}" value="${esca(target.ip)}"></div>
          <div><div class="elabel">Port</div><input class="einput" type="number" id="eport-${target.id}" value="${target.port}"></div>
          <div><div class="elabel">Username</div><input class="einput" id="euser-${target.id}" value="${esca(target.user || '')}"></div>
          <div>
            <div class="elabel">Password</div>
            <div class="epwrap">
              <input class="einput" type="password" id="epass-${target.id}" value="${esca(target.pass || '')}">
              <button class="eptoggle" type="button" onclick="toggleEditPass('${target.id}', this)" aria-label="Toggle saved password visibility"><i class="fa-regular fa-eye"></i></button>
            </div>
          </div>
          <div class="full ssh-edit-key" style="display: ${target.proto === 'SSH' ? '' : 'none'}">
            <div class="elabel">Private Key (PEM)</div>
            <div class="key-import-row">
              <textarea class="einput" id="epriv-${target.id}" style="resize: vertical; min-height: 80px;" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----">${esca(target.privateKey || '')}</textarea>
              <button class="tool-btn" type="button" onclick="triggerKeyImport('${target.id}'); event.stopPropagation();"><i class="fa-solid fa-upload"></i> Upload</button>
            </div>
          </div>
          <div class="full" style="display: ${target.proto === 'RDP' ? '' : 'none'}">
            <div class="elabel">Auth Mode</div>
            <select class="einput" id="eauth-${target.id}">
              <option value="local" ${(target.authMode || 'local') === 'local' ? 'selected' : ''}>Local</option>
              <option value="domain" ${target.authMode === 'domain' ? 'selected' : ''}>Domain</option>
            </select>
          </div>
          <div class="full" style="display: ${target.proto === 'RDP' ? '' : 'none'}">
            <div class="elabel">Domain</div>
            <input class="einput" id="edomain-${target.id}" value="${esca(target.domain || '')}" placeholder="CORP">
          </div>
          <div class="full">
            <div class="elabel">Protocol</div>
            <select class="einput" id="eproto-${target.id}">
              <option value="VNC" ${target.proto === 'VNC' ? 'selected' : ''}>VNC</option>
              <option value="RDP" ${target.proto === 'RDP' ? 'selected' : ''}>RDP</option>
              <option value="SSH" ${target.proto === 'SSH' ? 'selected' : ''}>SSH</option>
            </select>
          </div>
        </div>
        <div class="ebtns">
          <button class="btn-save" type="button" onclick="saveEdit('${target.id}')">บันทึก</button>
          <button class="btn-ce" type="button" onclick="toggleEdit('${target.id}')">ยกเลิก</button>
        </div>
      </div>
    </div>
  `).join('');
}

function toggleEdit(id) {
  document.getElementById(`edit-${id}`).classList.toggle('open');
}

async function saveEdit(id) {
  const body = {
    name: document.getElementById(`en-${id}`).value.trim(),
    ip: document.getElementById(`eip-${id}`).value.trim(),
    port: Number.parseInt(document.getElementById(`eport-${id}`).value, 10),
    user: document.getElementById(`euser-${id}`).value.trim(),
    pass: document.getElementById(`epass-${id}`).value,
    privateKey: document.getElementById(`epriv-${id}`).value.trim(),
    domain: document.getElementById(`edomain-${id}`)?.value.trim() || '',
    authMode: document.getElementById(`eauth-${id}`)?.value || 'local',
    proto: document.getElementById(`eproto-${id}`).value,
  };

  try {
    await api('PUT', `/targets/${id}`, body);
    addLog('ok', `Updated: ${body.name || body.ip}`);
    showToast(`บันทึก "${body.name || body.ip}" แล้ว`);
    await loadTargets();
  } catch (error) {
    addLog('err', `Update failed: ${error.message}`);
    showToast('บันทึกไม่สำเร็จ');
  }
}

window.quickConnect = function quickConnect(id) {
  selectTarget(id);
  handleConnect();
};

async function selectTarget(id) {
  try {
    let target = cachedTargets.find((entry) => entry.id === id);

    if (!target) {
      await loadTargets();
      target = cachedTargets.find((entry) => entry.id === id);
    }

    if (!target) {
      return;
    }

    selectedId = id;
    document.getElementById('ip').value = target.ip;
    document.getElementById('port').value = target.port;
    document.getElementById('username').value = target.user || '';
    document.getElementById('password').value = target.pass || '';
    document.getElementById('privateKey').value = target.privateKey || '';
    document.getElementById('label').value = target.name;
    if (authModeSelect) {
      authModeSelect.value = target.authMode === 'domain' ? 'domain' : 'local';
    }
    if (domainInput) {
      domainInput.value = target.domain || '';
    }

    const tabId = target.proto === 'SSH' ? 'tab-ssh' : target.proto === 'RDP' ? 'tab-rdp' : 'tab-vnc';
    setProto(target.proto, document.getElementById(tabId), { applyDefaultPort: false });

    await loadTargets();
    addLog('info', `Selected: ${target.name} (${target.ip})`);
  } catch (error) {
    showToast(error.message);
  }
}

async function handleConnect() {
  const ip = document.getElementById('ip').value.trim();
  const port = Number.parseInt(document.getElementById('port').value, 10);
  const user = document.getElementById('username').value.trim();
  const pass = document.getElementById('password').value;
  const privateKey = document.getElementById('privateKey').value.trim();
  const domain = domainInput?.value.trim() || '';
  const authMode = authModeSelect?.value === 'domain' ? 'domain' : 'local';
  const label = document.getElementById('label').value.trim() || ip;
  const proto = activeProto;

  if (!ip) {
    showToast('กรุณาใส่ IP Address ก่อน');
    return;
  }

  if (proto === 'SSH' && !user) {
    showToast('SSH ต้องใส่ Username');
    return;
  }

  if (proto === 'SSH' && !pass && !privateKey) {
    showToast('SSH ต้องใส่ Password หรือ Private Key');
    return;
  }

  if (proto === 'RDP' && !user) {
    showToast('RDP ต้องใส่ Username');
    return;
  }

  if (proto === 'RDP' && !pass) {
    showToast('RDP ต้องใส่ Password');
    return;
  }

  if (proto === 'RDP' && authMode === 'domain' && !domain) {
    showToast('RDP แบบ Domain ต้องใส่ Domain');
    return;
  }

  if (proto === 'SSH') {
    persistSshTimeoutMinutes();
  }

  try {
    const alreadySaved = cachedTargets.find((target) => target.ip === ip && target.port === port && target.proto === proto);

    if (!alreadySaved && currentUser?.permissions?.manageTargets) {
      await api('POST', '/targets', {
        name: label,
        ip,
        port,
        proto,
        user,
        pass,
        privateKey,
        domain,
        authMode,
      });

      addLog('ok', `Saved target: ${label}`);
    }
  } catch (error) {
    addLog('warn', `Save skipped: ${error.message}`);
  }

  await startSession({ ip, port, user, pass, privateKey, domain, authMode, label, proto });
  await loadTargets();
}

async function startSession({ ip, port, user, pass, privateKey, domain, authMode, label, proto }) {
  document.getElementById('conn-label-text').textContent = `กำลังเชื่อมต่อ ${ip}`;
  document.getElementById('conn-sub-text').textContent = 'กำลังสร้าง session...';
  document.getElementById('btn-connect').disabled = true;
  addLog('info', `Creating ${proto} session -> ${ip}:${port}`);

  try {
    let url = '';
    let token = null;
    let headerMeta = '';
    let showHeaderMeta = false;
    const sessionId = `s${Date.now()}-${++sessionSeq}`;

    if (proto === 'VNC') {
      const response = await api('POST', '/session', { ip, port, proto: 'VNC', targetId: selectedId || undefined });
      token = response.token;

      if (!token) {
        throw new Error('VNC token not created');
      }

      const host = window.location.hostname;
      const appPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      const wsPath = encodeURIComponent(`websockify/?token=${token}`);

      url = `/novnc/vnc.html?host=${encodeURIComponent(host)}&port=${encodeURIComponent(appPort)}&path=${wsPath}&autoconnect=1&resize=scale&auto_approve=1`;

      if (pass) {
        url += `&password=${encodeURIComponent(pass)}`;
      }

      addLog('ok', `VNC token auto-created: ${token.slice(0, 10)}...`);
    } else if (proto === 'RDP') {
      const response = await api('POST', '/session', {
        ip,
        port,
        proto: 'RDP',
        user,
        pass,
        domain,
        authMode,
        targetId: selectedId || undefined,
      });
      token = response.token;

      if (!token) {
        throw new Error('RDP token not created');
      }

      const params = new URLSearchParams({
        token,
        uiNonce: String(Date.now()),
      });

      url = `/rdp/index.html?${params.toString()}`;
      const domainLabel = authMode === 'domain' && domain ? `${domain}\\${user}` : user;
      addLog('ok', `RDP session -> ${domainLabel}@${ip}:${port}`);
      headerMeta = `RDP ${domainLabel}@${ip}:${port}`;
      showHeaderMeta = true;
    } else {
      const sshTimeoutMinutes = getSshTimeoutMinutes();
      const response = await api('POST', '/session', {
        ip,
        port,
        proto: 'SSH',
        user,
        pass,
        privateKey,
        label: label || `${user}@${ip}`,
        targetId: selectedId || undefined,
      });
      token = response.token;

      if (!token) {
        throw new Error('SSH token not created');
      }

      const params = new URLSearchParams({
        token: token,
        idleTimeoutMs: String(sshTimeoutMinutes * 60 * 1000),
        uiNonce: String(Date.now()),
      });

      url = `/ssh/index.html?${params.toString()}`;
      addLog('ok', `SSH bridge -> ${user}@${ip}:${port}`);
      addLog('info', `SSH idle timeout: ${sshTimeoutMinutes} minute(s)`);
      headerMeta = `SSH ${user}@${ip}:${port} - idle timeout ${sshTimeoutMinutes}m`;
      showHeaderMeta = true;
    }

    const { paneEl, iframe } = createSessionPane(url, `${proto} ${ip}:${port}`);
    const session = {
      id: sessionId,
      token,
      targetId: selectedId || null,
      ip,
      port,
      pass,
      user,
      privateKey,
      domain,
      authMode,
      proto,
      url,
      label: label || `${user}@${ip}`,
      headerMeta,
      showHeaderMeta,
      status: 'connecting',
      statusLabel: 'connecting',
      paneEl,
      iframeEl: iframe,
    };

    sessions.push(session);
    renderSessionTabs();
    activateSession(sessionId);

    if (proto === 'VNC') {
      iframe.addEventListener('load', () => {
        if (!getSessionById(sessionId)) {
          return;
        }

        updateSessionStatus(session, 'connected', 'connected');
        addLog('ok', `${proto} session ready -> ${ip}:${port}`);
      }, { once: true });
    }

    document.getElementById('btn-connect').disabled = false;
  } catch (error) {
    document.getElementById('btn-connect').disabled = false;
    addLog('err', `Session failed: ${error.message}`);
    showToast(`เชื่อมต่อไม่สำเร็จ: ${error.message}`);
  }
}

async function disconnect() {
  const active = getActiveSession();
  if (!active) {
    return;
  }

  await closeSessionById(active.id);
  showToast('Disconnected');
}

async function reconnectSession(session) {
  if (!session) {
    return;
  }

  addLog('info', `Reconnecting ${session.proto} session -> ${session.ip}:${session.port}`);

  // Disable Reconnect button to prevent double clicks
  const btnReconnect = document.getElementById('btn-reconnect');
  if (btnReconnect) {
    btnReconnect.disabled = true;
  }

  // Update session status to connecting
  updateSessionStatus(session, 'connecting', 'connecting');

  if (session.token && (session.proto === 'VNC' || session.proto === 'RDP')) {
    try {
      await api('DELETE', `/session/${session.token}`);
    } catch {
      // Ignore
    }
  }

  try {
    let url = '';
    let token = null;

    if (session.proto === 'VNC') {
      const response = await api('POST', '/session', {
        ip: session.ip,
        port: session.port,
        proto: 'VNC',
        targetId: session.targetId || undefined,
      });
      token = response.token;
      if (!token) {
        throw new Error('VNC token not created');
      }

      const host = window.location.hostname;
      const appPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      const wsPath = encodeURIComponent(`websockify/?token=${token}`);
      url = `/novnc/vnc.html?host=${encodeURIComponent(host)}&port=${encodeURIComponent(appPort)}&path=${wsPath}&autoconnect=1&resize=scale&auto_approve=1`;
      if (session.pass) {
        url += `&password=${encodeURIComponent(session.pass)}`;
      }

      addLog('ok', `VNC token auto-created: ${token.slice(0, 10)}...`);
    } else if (session.proto === 'RDP') {
      const response = await api('POST', '/session', {
        ip: session.ip,
        port: session.port,
        proto: 'RDP',
        user: session.user,
        pass: session.pass,
        domain: session.domain,
        authMode: session.authMode,
        targetId: session.targetId || undefined,
      });
      token = response.token;
      if (!token) {
        throw new Error('RDP token not created');
      }
      url = `/rdp/index.html?token=${encodeURIComponent(token)}&uiNonce=${Date.now()}`;
      const domainLabel = session.authMode === 'domain' && session.domain
        ? `${session.domain}\\${session.user}`
        : session.user;
      addLog('ok', `RDP session -> ${domainLabel}@${session.ip}:${session.port}`);
      session.headerMeta = `RDP ${domainLabel}@${session.ip}:${session.port}`;
      session.showHeaderMeta = true;
    } else {
      const sshTimeoutMinutes = getSshTimeoutMinutes();
      const response = await api('POST', '/session', {
        ip: session.ip,
        port: session.port,
        proto: 'SSH',
        user: session.user,
        pass: session.pass,
        privateKey: session.privateKey,
        label: session.label || `${session.user}@${session.ip}`,
        targetId: session.targetId || undefined,
      });
      token = response.token;
      if (!token) {
        throw new Error('SSH token not created');
      }
      const params = new URLSearchParams({
        token: token,
        idleTimeoutMs: String(sshTimeoutMinutes * 60 * 1000),
        uiNonce: String(Date.now()),
      });
      url = `/ssh/index.html?${params.toString()}`;
      addLog('ok', `SSH bridge -> ${session.user}@${session.ip}:${session.port}`);
      session.headerMeta = `SSH ${session.user}@${session.ip}:${session.port} - idle timeout ${sshTimeoutMinutes}m`;
      session.showHeaderMeta = true;
    }

    // Update session info
    session.token = token;
    session.url = url;

    // Refresh the iframe src
    if (session.iframeEl) {
      session.iframeEl.src = url;
    }

    if (session.proto === 'VNC') {
      session.iframeEl.addEventListener('load', () => {
        if (!getSessionById(session.id)) {
          return;
        }
        updateSessionStatus(session, 'connected', 'connected');
        addLog('ok', `${session.proto} session ready -> ${session.ip}:${session.port}`);
      }, { once: true });
    }

    applySessionView(session);
  } catch (error) {
    updateSessionStatus(session, 'error', 'error');
    addLog('err', `Reconnection failed: ${error.message}`);
    showToast(`เชื่อมต่อใหม่ไม่สำเร็จ: ${error.message}`);
  } finally {
    if (btnReconnect) {
      btnReconnect.disabled = false;
    }
  }
}

async function reconnectActiveSession() {
  const active = getActiveSession();
  if (!active) {
    return;
  }
  await reconnectSession(active);
}

async function handleLogout() {
  try {
    await api('POST', '/logout');
    window.location.href = '/login.html';
  } catch (error) {
    console.error('Logout failed:', error);
    window.location.href = '/login.html';
  }
}

function popOut() {
  const active = getActiveSession();
  if (!active?.url) {
    return;
  }

  // RDP/VNC allow only one live client per session token; blank the iframe first
  // so Pop Out does not open a second connection and kick the embedded session.
  if (active.iframeEl) {
    active.iframeEl.src = 'about:blank';
  }

  const features = 'width=1366,height=900,menubar=no,toolbar=no,status=no';
  const popoutWindow = window.open(active.url, `jump-${active.id}`, features);

  if (!popoutWindow) {
    if (active.iframeEl) {
      active.iframeEl.src = active.url;
      if (active.proto === 'RDP') {
        requestAnimationFrame(notifyEmbeddedRdpSessionsResize);
      }
    }
    addLog('warn', 'Pop-out blocked by browser popup blocker');
    showToast('เปิดหน้าต่างใหม่ไม่ได้ — อนุญาต pop-up สำหรับ localhost');
    return;
  }

  active.poppedOut = true;
  active.popoutWindow = popoutWindow;
  updateSessionStatus(active, 'connected', 'popped out');
  addLog('info', `Popped out: ${active.ip}:${active.port}`);

  const watchPopout = setInterval(() => {
    const session = getSessionById(active.id);
    if (!session || popoutWindow.closed) {
      clearInterval(watchPopout);
    }

    if (!session || !popoutWindow.closed) {
      return;
    }

    session.poppedOut = false;
    session.popoutWindow = null;

    if (session.iframeEl && session.id === activeSessionId) {
      session.iframeEl.src = session.url;
      if (session.proto === 'RDP') {
        requestAnimationFrame(notifyEmbeddedRdpSessionsResize);
      }
    }

    updateSessionStatus(session, 'disconnected', 'pop-out closed');
    addLog('info', `Pop-out closed: ${session.ip}:${session.port}`);
  }, 500);
}

function setView(state) {
  document.getElementById('idle').style.display = state === 'idle' ? '' : 'none';
  document.getElementById('connecting').classList.toggle('show', state === 'connecting');
  document.getElementById('vnc-frame').classList.toggle('show', state === 'vnc');
}

function handleEmbeddedRdpStatus(event) {
  if (!event.data || event.data.type !== 'jump-rdp-status') {
    return;
  }

  const active = getActiveSession();
  if (!active || active.proto !== 'RDP') {
    return;
  }

  const { state, isError, message } = event.data;

  if (state === 'connected') {
    updateSessionStatus(active, 'connected', 'connected');
    addLog('ok', `RDP session ready -> ${active.ip}:${active.port}`);
    requestAnimationFrame(notifyEmbeddedRdpSessionsResize);
    return;
  }

  if (isError || state === 'error') {
    updateSessionStatus(active, 'error', 'error');
    addLog('err', `RDP error: ${message || state}`);
    return;
  }

  if (state === 'disconnected') {
    updateSessionStatus(active, 'disconnected', 'disconnected');
  }
}

function handleEmbeddedSshStatus(event) {
  if (event.origin !== window.location.origin) {
    return;
  }

  const payload = event.data;
  if (!payload || payload.type !== 'jump-ssh-status') {
    return;
  }

  const session = findSessionBySourceWindow(event.source);
  if (!session || session.proto !== 'SSH') {
    return;
  }

  if (payload.state === 'ready' || payload.state === 'connected') {
    updateSessionStatus(session, 'connected', 'connected');
    addLog('ok', `SSH session ready -> ${session.ip}:${session.port}`);
    return;
  }

  if (payload.state === 'idle-timeout' || payload.state === 'idle timeout') {
    updateSessionStatus(session, 'timeout', 'idle-timeout');
    return;
  }

  if (payload.state === 'closed' || payload.state === 'session closed' || payload.state === 'disconnected') {
    updateSessionStatus(session, 'disconnected', 'disconnected');
    return;
  }

  if (payload.state === 'error' || payload.state === 'websocket error') {
    updateSessionStatus(session, 'error', 'error');
    if (payload.message) {
      addLog('err', `${getSessionLabel(session)} error: ${payload.message}`);
    }

    return;
  }

  updateSessionStatus(session, payload.isError ? 'error' : 'connected', String(payload.state || 'connected'));
}

function askDelete(id, name) {
  pendingDelete = id;
  document.getElementById('modal-name').textContent = name;
  document.getElementById('modal').classList.add('show');
}

function closeModal() {
  pendingDelete = null;
  document.getElementById('modal').classList.remove('show');
}

async function confirmDelete() {
  if (!pendingDelete) {
    return;
  }

  try {
    await api('DELETE', `/targets/${pendingDelete}`);

    if (selectedId === pendingDelete) {
      selectedId = null;
    }

    addLog('warn', 'Deleted target');
    showToast('ลบ Target แล้ว');
    await loadTargets();
  } catch (error) {
    showToast(`ลบไม่สำเร็จ: ${error.message}`);
  }

  closeModal();
}

function triggerImport() {
  importInput.value = '';
  importInput.click();
}

async function importTargetsFromFile(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    const raw = await file.text();
    const parsed = JSON.parse(raw);
    const targets = Array.isArray(parsed) ? parsed : Array.isArray(parsed.targets) ? parsed.targets : null;

    if (!targets) {
      throw new Error('ไฟล์ต้องเป็น array หรือมี key: targets');
    }

    const replace = window.confirm('Import แบบทับข้อมูลทั้งหมดหรือไม่?\nOK = ทับทั้งหมด, Cancel = merge');
    const result = await api('POST', '/targets/import', { targets, replace });

    showToast(`Import สำเร็จ: ${result.total} targets`);
    addLog('ok', `Imported ${result.imported} targets (total ${result.total})`);
    await loadTargets();
  } catch (error) {
    showToast(`Import ไม่สำเร็จ: ${error.message}`);
  }
}

async function exportTargets() {
  try {
    const response = await fetch('/api/targets/export');

    if (!response.ok) {
      throw new Error('Export failed');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = `jump-targets-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
    showToast('Export JSON สำเร็จ');
    addLog('ok', 'Exported targets JSON');
  } catch (error) {
    showToast(error.message);
  }
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function esca(value) {
  return String(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function addLog(type, message) {
  const timestamp = new Date().toTimeString().slice(0, 8);
  const cssClass = ({ ok: 'ok', err: 'err', warn: 'warn' })[type] || '';

  const row = document.createElement('div');
  row.className = 'logline';
  row.innerHTML = `<span class="logts">${timestamp}</span><span class="logmsg ${cssClass}">${esc(message)}</span>`;

  logPanel.appendChild(row);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = message;
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

function renderClock() {
  document.getElementById('clock').textContent = new Date().toTimeString().slice(0, 8);
}

setInterval(renderClock, 1000);
renderClock();

importInput.addEventListener('change', importTargetsFromFile);
targetFilterInput?.addEventListener('input', () => {
  targetFilterTerm = targetFilterInput.value.trim().toLowerCase();
  renderTargets();
});
sshTimeoutInput?.addEventListener('input', persistSshTimeoutMinutes);
sshTimeoutInput?.addEventListener('change', persistSshTimeoutMinutes);
logHeightInput?.addEventListener('input', () => {
  setLogHeight(logHeightInput.value);
});
clearLogButton?.addEventListener('click', () => {
  logPanel.innerHTML = '';
  addLog('info', 'Log cleared');
});
toggleLogButton?.addEventListener('click', () => {
  if (!opsConsole) {
    return;
  }

  setLogCollapsed(!opsConsole.classList.contains('collapsed'));
});
authModeSelect?.addEventListener('change', updateProtocolDependentControls);
window.addEventListener('message', handleEmbeddedSshStatus);
window.addEventListener('message', handleEmbeddedRdpStatus);
window.addEventListener('beforeunload', () => {
  if (sessions.length) {
    closeAllSessions();
  }
});

// Start inactivity tracking
bindActivityListeners(document);
checkInactivity();
window.addEventListener('storage', (event) => {
  if (event.key === LAST_ACTIVITY_KEY) {
    scheduleInactivityLogout();
  }
});

function applyPermissionsUI() {
  const reportsLink = document.querySelector('a.reports-link[href="/reports.html"]');
  const usersLink = document.getElementById('users-admin-link');
  const savedTools = document.getElementById('saved-tools-panel');
  const newConnectionPanel = document.getElementById('new-connection-panel');
  const userChip = document.getElementById('user-chip');

  if (reportsLink) {
    reportsLink.style.display = currentUser?.permissions?.reports ? '' : 'none';
  }

  if (usersLink) {
    usersLink.style.display = currentUser?.permissions?.manageUsers ? '' : 'none';
  }

  if (savedTools) {
    savedTools.style.display = currentUser?.permissions?.manageTargets ? '' : 'none';
  }

  if (newConnectionPanel) {
    newConnectionPanel.style.display = currentUser?.permissions?.manageTargets ? '' : 'none';
  }

  if (userChip && currentUser) {
    userChip.textContent = `${currentUser.username} (${currentUser.role})`;
    userChip.title = currentUser.displayName || currentUser.username;
  }
}

async function initThemePicker() {
  const select = document.getElementById('theme-select');
  if (!select) {
    return;
  }

  try {
    const themes = await api('GET', '/themes');
    select.innerHTML = themes.map((t) => `<option value="${t.id}">${t.label}</option>`).join('');

    // Normalize legacy 'default' theme to 'dark'
    const savedTheme = currentUser?.theme || 'dark';
    const normalized = savedTheme === 'default' ? 'dark' : savedTheme;
    select.value = normalized;

    // Attach listener only once
    if (!select.dataset.listenerAttached) {
      select.dataset.listenerAttached = '1';
      select.addEventListener('change', () => {
        window.jumpTheme?.save(select.value);
      });
    }
  } catch {
    select.innerHTML = '<option value="dark">🌙 Dark</option><option value="light">☀️ Light</option><option value="system">🖥️ System</option>';
  }
}

async function loadProfile() {
  currentUser = await api('GET', '/me');
  applyPermissionsUI();
  if (window.jumpTheme?.apply && currentUser.theme) {
    window.jumpTheme.apply(currentUser.theme);
  }

  await initThemePicker();
  addLog('info', `Signed in as ${currentUser.displayName || currentUser.username} (${currentUser.role})`);
}

restoreUiPreferences();
updateProtocolDependentControls();
refreshSshBridgeChip();
loadHealth();
setInterval(loadHealth, 30000);
loadProfile()
  .catch((error) => {
    addLog('err', `Profile load failed: ${error.message}`);
  })
  .then(() => loadTargets())
  .catch((error) => {
    addLog('err', `Targets load failed: ${error.message}`);
  });
addLog('info', 'Jump Server UI initialized');
addLog('ok', 'Dynamic token for VNC is enabled');
addLog('ok', 'RDP desktop via guacd is enabled');
addLog('info', 'Ready for DHCP / Static IP connections');
