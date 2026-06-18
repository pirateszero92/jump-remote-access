(function bootstrap() {
  const yearSelect = document.getElementById('filter-year');
  const monthSelect = document.getElementById('filter-month');
  const userSelect = document.getElementById('filter-user');
  const loadButton = document.getElementById('btn-load-report');
  const sessionListEl = document.getElementById('session-list');
  const reportCountEl = document.getElementById('report-count');
  const reportEmptyEl = document.getElementById('report-empty');
  const reportDetailEl = document.getElementById('report-detail');
  const detailTitleEl = document.getElementById('detail-title');
  const replayTerminalEl = document.getElementById('replay-terminal');
  const replaySpeedEl = document.getElementById('replay-speed');
  const playButton = document.getElementById('btn-replay-play');
  const pauseButton = document.getElementById('btn-replay-pause');
  const resetButton = document.getElementById('btn-replay-reset');
  const timelineScrubEl = document.getElementById('timeline-scrub');
  const timelineCurrentEl = document.getElementById('timeline-current');
  const timelineTotalEl = document.getElementById('timeline-total');
  const timelineMarkersEl = document.getElementById('timeline-markers');
  const reportsSidebarEl = document.getElementById('reports-sidebar');
  const sidebarBackdropEl = document.getElementById('sidebar-backdrop');
  const sidebarToggleBtn = document.getElementById('btn-sidebar-toggle');
  const resizerEl = document.getElementById('replay-resizer');
  const keystrokePanelEl = document.getElementById('keystroke-panel');
  const keystrokeSearchEl = document.getElementById('keystroke-search');
  const keystrokeListEl = document.getElementById('keystroke-list');

  let terminal = null;
  let fitAddon = null;
  let castEvents = [];
  let castHeader = null;
  let fullReport = null;
  let keyEntries = [];
  let groupedKeystrokes = [];
  let keystrokeSearchQuery = '';
  let isDragging = false;
  let sessionDurationSec = 0;
  let replayTimer = null;
  let replayIndex = 0;
  let replayStartedAt = 0;
  let replayPausedAt = 0;
  let replayPaused = true;
  let scrubbing = false;
  let activeSessionId = null;
  let resizeObserver = null;
  let currentUser = null;

  function initYearOptions() {
    const now = new Date();
    const currentYear = now.getFullYear();

    for (let year = currentYear; year >= currentYear - 5; year -= 1) {
      const option = document.createElement('option');
      option.value = String(year);
      option.textContent = String(year);
      yearSelect.appendChild(option);
    }

    yearSelect.value = String(currentYear);
    monthSelect.value = String(now.getMonth() + 1);
  }

  function isNarrowLayout() {
    return window.matchMedia('(max-width: 960px)').matches;
  }

  function openSidebar() {
    reportsSidebarEl.classList.add('open');
    sidebarBackdropEl.classList.remove('hidden');
    sidebarBackdropEl.classList.add('show');
  }

  function closeSidebar() {
    reportsSidebarEl.classList.remove('open');
    sidebarBackdropEl.classList.add('hidden');
    sidebarBackdropEl.classList.remove('show');
  }

  function toggleSidebar() {
    if (reportsSidebarEl.classList.contains('open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  }

  async function api(path) {
    const response = await fetch(path, { credentials: 'same-origin' });
    if (response.status === 401) {
      window.location.href = '/login.html';
      throw new Error('Unauthorized');
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const payload = await response.json();
        message = payload.error || message;
      } catch {
        // Ignore
      }

      throw new Error(message);
    }

    return response.json();
  }

  function formatDuration(seconds) {
    const total = Number(seconds) || 0;
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}m ${secs}s`;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function formatDateTime(value) {
    if (!value) {
      return '-';
    }

    return new Date(value).toLocaleString();
  }

  function formatKeyChar(keys) {
    if (!keys) return '';
    let formatted = '';
    for (let i = 0; i < keys.length; i++) {
      const charCode = keys.charCodeAt(i);
      if (keys.substring(i).startsWith('\u001b[A')) {
        formatted += '<span class="keystroke-special">↑</span>';
        i += 2;
      } else if (keys.substring(i).startsWith('\u001b[B')) {
        formatted += '<span class="keystroke-special">↓</span>';
        i += 2;
      } else if (keys.substring(i).startsWith('\u001b[C')) {
        formatted += '<span class="keystroke-special">→</span>';
        i += 2;
      } else if (keys.substring(i).startsWith('\u001b[D')) {
        formatted += '<span class="keystroke-special">←</span>';
        i += 2;
      } else if (charCode === 13 || charCode === 10) {
        formatted += '<span class="keystroke-special">Enter</span>';
      } else if (charCode === 127 || charCode === 8) {
        formatted += '<span class="keystroke-special">Backspace</span>';
      } else if (charCode === 9) {
        formatted += '<span class="keystroke-special">Tab</span>';
      } else if (charCode === 27) {
        formatted += '<span class="keystroke-special">Esc</span>';
      } else if (charCode === 3) {
        formatted += '<span class="keystroke-special">Ctrl+C</span>';
      } else if (charCode === 4) {
        formatted += '<span class="keystroke-special">Ctrl+D</span>';
      } else if (charCode < 32) {
        formatted += `<span class="keystroke-special">Ctrl+${String.fromCharCode(charCode + 64)}</span>`;
      } else {
        const char = keys[i];
        if (char === '<') formatted += '&lt;';
        else if (char === '>') formatted += '&gt;';
        else if (char === '&') formatted += '&amp;';
        else formatted += char;
      }
    }
    return formatted;
  }

  function isSpecialKey(keys) {
    if (!keys) return false;
    for (let i = 0; i < keys.length; i++) {
      const charCode = keys.charCodeAt(i);
      if (charCode < 32 || charCode === 127 || keys.includes('\u001b[')) {
        return true;
      }
    }
    return false;
  }

  function groupKeystrokes(entries) {
    const groups = [];
    let currentGroup = null;

    entries.forEach((entry) => {
      const isSpecial = isSpecialKey(entry.keys);
      
      if (!currentGroup) {
        currentGroup = {
          t: entry.t,
          keys: entry.keys,
          isSpecial: isSpecial
        };
      } else {
        const prevEntry = entries[entries.indexOf(entry) - 1];
        const timeFromLast = prevEntry ? (entry.t - prevEntry.t) : 0;
        
        if (timeFromLast > 1.5 || isSpecial || currentGroup.isSpecial) {
          groups.push(currentGroup);
          currentGroup = {
            t: entry.t,
            keys: entry.keys,
            isSpecial: isSpecial
          };
        } else {
          currentGroup.keys += entry.keys;
        }
      }
    });

    if (currentGroup) {
      groups.push(currentGroup);
    }

    return groups;
  }

  function renderKeystrokeList() {
    keystrokeListEl.innerHTML = '';
    
    const query = keystrokeSearchQuery.toLowerCase().trim();
    const filtered = groupedKeystrokes.filter(item => {
      return item.keys.toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      keystrokeListEl.innerHTML = '<div class="reports-hint" style="text-align: center; padding: 20px;">No keystrokes found</div>';
      return;
    }

    filtered.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'keystroke-item';
      div.dataset.t = item.t;
      
      const formattedTime = formatClock(item.t);
      
      div.innerHTML = `
        <span class="keystroke-time">${formattedTime}</span>
        <span class="keystroke-value">${formatKeyChar(item.keys)}</span>
      `;
      
      div.addEventListener('click', () => {
        seekTo(item.t, { resume: true });
      });
      
      keystrokeListEl.appendChild(div);
    });
  }

  function highlightCurrentKeystroke(elapsed) {
    let activeItem = null;
    
    for (let i = 0; i < groupedKeystrokes.length; i++) {
      if (groupedKeystrokes[i].t <= elapsed) {
        activeItem = groupedKeystrokes[i];
      } else {
        break;
      }
    }
    
    const items = keystrokeListEl.querySelectorAll('.keystroke-item');
    items.forEach(el => el.classList.remove('active'));
    
    if (activeItem) {
      const activeEl = Array.from(items).find(el => parseFloat(el.dataset.t) === activeItem.t);
      if (activeEl) {
        activeEl.classList.add('active');
        activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  function getTotalDuration() {
    if (castEvents.length > 0) {
      return castEvents[castEvents.length - 1][0];
    }

    return sessionDurationSec || 0;
  }

  function getUserKey(session) {
    return session.jumpUser || '';
  }

  function populateUserFilter(report) {
    const currentVal = userSelect.value;
    const users = new Set();

    report.days.forEach((dayGroup) => {
      dayGroup.sessions.forEach((session) => {
        const key = getUserKey(session);
        if (key) users.add(key);
      });
    });

    // Rebuild options
    userSelect.innerHTML = '<option value="">All users</option>';
    Array.from(users).sort().forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u;
      opt.textContent = u;
      userSelect.appendChild(opt);
    });

    // Restore previous selection if still valid
    if (currentVal && users.has(currentVal)) {
      userSelect.value = currentVal;
    }
  }

  function applyUserFilter(report) {
    const selectedUser = userSelect.value;
    if (!selectedUser) return report;

    const filteredDays = report.days
      .map((dayGroup) => ({
        ...dayGroup,
        sessions: dayGroup.sessions.filter((s) => getUserKey(s) === selectedUser),
      }))
      .filter((dayGroup) => dayGroup.sessions.length > 0);

    return { ...report, days: filteredDays, total: filteredDays.reduce((n, d) => n + d.sessions.length, 0) };
  }

  async function confirmDeleteSession(session) {
    const confirmed = confirm(`ต้องการลบ session "${session.label}" ใช่หรือไม่?\nการดำเนินการนี้จะลบไฟล์บันทึกทั้งหมดอย่างถาวรและไม่สามารถเรียกคืนได้`);
    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(`/api/ssh-recordings/${encodeURIComponent(session.id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          message = payload.error || message;
        } catch {}
        throw new Error(message);
      }

      if (activeSessionId === session.id) {
        activeSessionId = null;
        stopReplay();
        reportEmptyEl.classList.remove('hidden');
        reportDetailEl.classList.add('hidden');
      }

      await loadReport();
    } catch (error) {
      alert(`ลบไม่สำเร็จ: ${error.message}`);
    }
  }

  function renderSessionList(report) {
    sessionListEl.innerHTML = '';

    if (!report.days.length) {
      sessionListEl.innerHTML = '<p class="reports-hint">ไม่มี session ในช่วงที่เลือก</p>';
      return;
    }

    const isSuperAdmin = currentUser && currentUser.role === 'superadmin';

    report.days.forEach((dayGroup) => {
      const group = document.createElement('div');
      group.className = 'day-group';

      const title = document.createElement('div');
      title.className = 'day-group-title';
      title.textContent = `Day ${dayGroup.day}`;
      group.appendChild(title);

      dayGroup.sessions.forEach((session) => {
        const itemWrap = document.createElement('div');
        itemWrap.className = 'session-item-wrap';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'session-item';
        button.dataset.sessionId = session.id;
        const userHtml = session.jumpUser
          ? `<span class="session-user-jump">${session.jumpUser}</span>`
          : `<span class="session-user-unknown">—</span>`;
        button.innerHTML = `
          <div class="session-item-title">${session.label}</div>
          <div class="session-item-meta">${formatDateTime(session.startedAt)} · ${formatDuration(session.durationSec)}</div>
          <div class="session-item-user"><i class="fa-solid fa-user"></i> ${userHtml}</div>
        `;

        button.addEventListener('click', () => {
          selectSession(session.id);
          if (isNarrowLayout()) {
            closeSidebar();
          }
        });

        itemWrap.appendChild(button);

        if (isSuperAdmin) {
          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'session-delete-btn';
          deleteBtn.title = 'Delete recording';
          deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
          deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            confirmDeleteSession(session);
          });
          itemWrap.appendChild(deleteBtn);
        }

        group.appendChild(itemWrap);
      });

      sessionListEl.appendChild(group);
    });
  }

  function applyFilterAndRender() {
    if (!fullReport) return;
    const filtered = applyUserFilter(fullReport);
    reportCountEl.textContent = `${filtered.total} session(s)`;
    renderSessionList(filtered);
  }

  async function loadReport() {
    const year = yearSelect.value;
    const month = monthSelect.value;
    const query = new URLSearchParams({ year });
    if (month) {
      query.set('month', month);
    }

    const report = await api(`/api/ssh-recordings/report?${query.toString()}`);
    fullReport = report;
    populateUserFilter(report);
    applyFilterAndRender();
  }

  function ensureTerminal() {
    if (terminal) {
      terminal.dispose();
      terminal = null;
      fitAddon = null;
      replayTerminalEl.innerHTML = '';
    }

    terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 10000,
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.15,
      theme: {
        background: '#020917',
        foreground: '#d6e4ff',
        cursor: '#00d4aa',
      },
      convertEol: true,
      scrollOnUserInput: true,
    });

    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(replayTerminalEl);
    fitReplayTerminal();
  }

  function fitReplayTerminal() {
    if (!fitAddon || !terminal || !replayTerminalEl) {
      return;
    }

    const width = replayTerminalEl.clientWidth;
    const height = replayTerminalEl.clientHeight;
    if (width < 24 || height < 24) {
      return;
    }

    try {
      fitAddon.fit();
    } catch {
      // Container may still be settling
    }
  }

  function renderTimelineMarkers() {
    timelineMarkersEl.innerHTML = '';
    const duration = getTotalDuration();
    if (!duration) {
      return;
    }

    keyEntries.forEach((entry) => {
      const pct = Math.min(100, Math.max(0, (entry.t / duration) * 100));
      const marker = document.createElement('span');
      marker.className = 'timeline-marker';
      marker.style.left = `${pct}%`;
      const preview = String(entry.keys || '').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
      marker.title = `${formatClock(entry.t)} · ${preview}`;
      timelineMarkersEl.appendChild(marker);
    });
  }

  function updateTimelineUi(elapsedSec) {
    const duration = getTotalDuration();
    const clamped = Math.min(duration, Math.max(0, elapsedSec));
    const sliderMax = 1000;
    const value = duration > 0 ? Math.round((clamped / duration) * sliderMax) : 0;

    if (!scrubbing) {
      timelineScrubEl.value = String(value);
    }

    timelineCurrentEl.textContent = formatClock(clamped);
    timelineTotalEl.textContent = formatClock(duration);
    highlightCurrentKeystroke(clamped);
  }

  function rebuildTerminalUntil(targetSec) {
    if (!terminal) {
      return;
    }

    terminal.reset();
    fitReplayTerminal();

    let index = 0;
    while (index < castEvents.length && castEvents[index][0] <= targetSec) {
      const [, type, data] = castEvents[index];
      if (type === 'o') {
        terminal.write(data);
      }

      index += 1;
    }

    replayIndex = index;
  }

  function seekTo(targetSec, { resume = false } = {}) {
    const duration = getTotalDuration();
    const clamped = Math.min(duration, Math.max(0, targetSec));
    const speed = Number.parseFloat(replaySpeedEl.value || '1') || 1;

    stopReplay();
    rebuildTerminalUntil(clamped);
    updateTimelineUi(clamped);

    replayPausedAt = (clamped / speed) * 1000;
    replayPaused = !resume;

    if (resume && clamped < duration) {
      replayStartedAt = Date.now() - replayPausedAt;
      replayPausedAt = 0;
      replayPaused = false;
      startReplay();
    }
  }

  function stopReplay() {
    replayPaused = true;
    if (replayTimer) {
      clearInterval(replayTimer);
      replayTimer = null;
    }
  }

  function resetReplay() {
    stopReplay();
    replayIndex = 0;
    replayPausedAt = 0;
    rebuildTerminalUntil(0);
    updateTimelineUi(0);
  }

  function getReplayElapsedSec() {
    const speed = Number.parseFloat(replaySpeedEl.value || '1') || 1;
    const wallMs = replayPausedAt || (Date.now() - replayStartedAt);
    return (wallMs / 1000) * speed;
  }

  function pumpReplay() {
    if (!terminal || replayPaused) {
      return;
    }

    const elapsed = getReplayElapsedSec();
    updateTimelineUi(elapsed);

    while (replayIndex < castEvents.length && castEvents[replayIndex][0] <= elapsed) {
      const [, type, data] = castEvents[replayIndex];
      if (type === 'o') {
        terminal.write(data);
      }

      replayIndex += 1;
    }

    if (replayIndex >= castEvents.length) {
      stopReplay();
      updateTimelineUi(getTotalDuration());
    }
  }

  function startReplay() {
    if (!castEvents.length) {
      return;
    }

    const speed = Number.parseFloat(replaySpeedEl.value || '1') || 1;

    if (replayPaused && replayPausedAt > 0) {
      replayStartedAt = Date.now() - replayPausedAt;
      replayPausedAt = 0;
    } else if (replayIndex === 0 && !replayPausedAt) {
      replayStartedAt = Date.now();
    } else {
      replayStartedAt = Date.now() - (getReplayElapsedSec() / speed) * 1000;
    }

    replayPaused = false;

    if (replayTimer) {
      clearInterval(replayTimer);
    }

    replayTimer = setInterval(pumpReplay, 40);
  }

  function pauseReplay() {
    if (!replayPaused) {
      replayPausedAt = Date.now() - replayStartedAt;
      updateTimelineUi(getReplayElapsedSec());
    }

    replayPaused = true;
    if (replayTimer) {
      clearInterval(replayTimer);
      replayTimer = null;
    }
  }

  function highlightActiveSession(sessionId) {
    sessionListEl.querySelectorAll('.session-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.sessionId === sessionId);
    });
  }

  async function selectSession(sessionId) {
    activeSessionId = sessionId;
    highlightActiveSession(sessionId);
    stopReplay();

    const meta = await api(`/api/ssh-recordings/${encodeURIComponent(sessionId)}`);
    const castRaw = await fetch(`/api/ssh-recordings/${encodeURIComponent(sessionId)}/cast`, {
      credentials: 'same-origin',
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Unable to load cast (${response.status})`);
      }

      return response.text();
    });

    const keysPayload = await api(`/api/ssh-recordings/${encodeURIComponent(sessionId)}/keys`);

    const lines = castRaw.split('\n').map((line) => line.trim()).filter(Boolean);
    castHeader = JSON.parse(lines[0]);
    castEvents = lines.slice(1).map((line) => JSON.parse(line));
    keyEntries = keysPayload.entries || [];
    groupedKeystrokes = groupKeystrokes(keyEntries);
    keystrokeSearchEl.value = '';
    keystrokeSearchQuery = '';
    renderKeystrokeList();

    sessionDurationSec = meta.durationSec || 0;
    replayIndex = 0;
    replayPausedAt = 0;

    const sessionTitle = meta.label || `${meta.username}@${meta.host}:${meta.port}` || meta.id;
    detailTitleEl.textContent = sessionTitle;
    detailTitleEl.title = [
      sessionTitle,
      formatDateTime(meta.startedAt),
      formatDuration(meta.durationSec),
    ].join(' · ');

    reportEmptyEl.classList.add('hidden');
    reportDetailEl.classList.remove('hidden');

    ensureTerminal();
    rebuildTerminalUntil(0);
    renderTimelineMarkers();
    updateTimelineUi(0);

    requestAnimationFrame(() => {
      fitReplayTerminal();
      setTimeout(fitReplayTerminal, 80);
      setTimeout(fitReplayTerminal, 250);
    });
  }

  async function handleLogout() {
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.href = '/login.html';
    }
  }

  timelineScrubEl.addEventListener('input', () => {
    scrubbing = true;
    const duration = getTotalDuration();
    const value = Number.parseInt(timelineScrubEl.value, 10) || 0;
    const targetSec = duration > 0 ? (value / 1000) * duration : 0;
    seekTo(targetSec, { resume: false });
  });

  timelineScrubEl.addEventListener('change', () => {
    scrubbing = false;
  });

  loadButton.addEventListener('click', () => {
    loadReport().catch((error) => {
      sessionListEl.innerHTML = `<p class="reports-hint">${error.message}</p>`;
    });
  });

  userSelect.addEventListener('change', () => {
    applyFilterAndRender();
  });

  playButton.addEventListener('click', startReplay);
  pauseButton.addEventListener('click', pauseReplay);
  resetButton.addEventListener('click', resetReplay);

  sidebarToggleBtn.addEventListener('click', toggleSidebar);
  sidebarBackdropEl.addEventListener('click', closeSidebar);

  window.addEventListener('resize', () => {
    if (!isNarrowLayout()) {
      replayTerminalEl.style.height = '';
      keystrokePanelEl.style.height = '';
    } else {
      keystrokePanelEl.style.width = '';
    }

    if (!reportDetailEl.classList.contains('hidden')) {
      fitReplayTerminal();
    }

    if (!isNarrowLayout()) {
      closeSidebar();
    }
  });

  // Resizer dragging logic
  resizerEl.addEventListener('mousedown', (e) => {
    isDragging = true;
    document.body.style.cursor = isNarrowLayout() ? 'row-resize' : 'col-resize';
    resizerEl.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const containerRect = document.querySelector('.replay-content').getBoundingClientRect();
    
    if (isNarrowLayout()) {
      const newHeight = containerRect.bottom - e.clientY;
      const maxHeight = containerRect.height * 0.8;
      const minHeight = 80;
      if (newHeight >= minHeight && newHeight <= maxHeight) {
        keystrokePanelEl.style.height = `${newHeight}px`;
        const terminalHeight = containerRect.height - newHeight - 14;
        replayTerminalEl.style.height = `${terminalHeight}px`;
        fitReplayTerminal();
      }
    } else {
      const newWidth = containerRect.right - e.clientX;
      const maxWidth = containerRect.width * 0.6;
      const minWidth = 150;
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        keystrokePanelEl.style.width = `${newWidth}px`;
        fitReplayTerminal();
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      resizerEl.classList.remove('dragging');
      fitReplayTerminal();
    }
  });

  // Keystroke search logic
  keystrokeSearchEl.addEventListener('input', (e) => {
    keystrokeSearchQuery = e.target.value;
    renderKeystrokeList();
  });

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (!reportDetailEl.classList.contains('hidden')) {
        fitReplayTerminal();
      }
    });
    resizeObserver.observe(replayTerminalEl);
  }

  window.handleLogout = handleLogout;
  async function ensureAccess() {
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    if (!response.ok) {
      window.location.href = '/login.html';
      return;
    }

    const profile = await response.json();
    if (!profile.permissions?.reports) {
      window.location.href = '/';
    }
    currentUser = profile;
  }

  initYearOptions();
  ensureAccess()
    .then(() => loadReport())
    .catch((error) => {
    sessionListEl.innerHTML = `<p class="reports-hint">${error.message}</p>`;
  });
})();
