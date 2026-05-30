(function bootstrap() {
  const yearSelect = document.getElementById('filter-year');
  const monthSelect = document.getElementById('filter-month');
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

  let terminal = null;
  let fitAddon = null;
  let castEvents = [];
  let castHeader = null;
  let keyEntries = [];
  let sessionDurationSec = 0;
  let replayTimer = null;
  let replayIndex = 0;
  let replayStartedAt = 0;
  let replayPausedAt = 0;
  let replayPaused = true;
  let scrubbing = false;
  let activeSessionId = null;
  let resizeObserver = null;

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

  function getTotalDuration() {
    if (castEvents.length > 0) {
      return castEvents[castEvents.length - 1][0];
    }

    return sessionDurationSec || 0;
  }

  function renderSessionList(report) {
    sessionListEl.innerHTML = '';

    if (!report.days.length) {
      sessionListEl.innerHTML = '<p class="reports-hint">ไม่มี session ในช่วงที่เลือก</p>';
      return;
    }

    report.days.forEach((dayGroup) => {
      const group = document.createElement('div');
      group.className = 'day-group';

      const title = document.createElement('div');
      title.className = 'day-group-title';
      title.textContent = `Day ${dayGroup.day}`;
      group.appendChild(title);

      dayGroup.sessions.forEach((session) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'session-item';
        button.dataset.sessionId = session.id;
        button.innerHTML = `
          <div class="session-item-title">${session.label}</div>
          <div class="session-item-meta">${formatDateTime(session.startedAt)} · ${formatDuration(session.durationSec)}</div>
        `;

        button.addEventListener('click', () => {
          selectSession(session.id);
          if (isNarrowLayout()) {
            closeSidebar();
          }
        });

        group.appendChild(button);
      });

      sessionListEl.appendChild(group);
    });
  }

  async function loadReport() {
    const year = yearSelect.value;
    const month = monthSelect.value;
    const query = new URLSearchParams({ year });
    if (month) {
      query.set('month', month);
    }

    const report = await api(`/api/ssh-recordings/report?${query.toString()}`);
    reportCountEl.textContent = `${report.total} session(s)`;
    renderSessionList(report);
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

  playButton.addEventListener('click', startReplay);
  pauseButton.addEventListener('click', pauseReplay);
  resetButton.addEventListener('click', resetReplay);

  sidebarToggleBtn.addEventListener('click', toggleSidebar);
  sidebarBackdropEl.addEventListener('click', closeSidebar);

  window.addEventListener('resize', () => {
    if (!reportDetailEl.classList.contains('hidden')) {
      fitReplayTerminal();
    }

    if (!isNarrowLayout()) {
      closeSidebar();
    }
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
  initYearOptions();
  loadReport().catch((error) => {
    sessionListEl.innerHTML = `<p class="reports-hint">${error.message}</p>`;
  });
})();
