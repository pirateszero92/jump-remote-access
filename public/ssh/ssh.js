(function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const host = params.get('host') || '';
  const port = params.get('port') || '22';
  const username = params.get('username') || '';
  const password = params.get('password') || '';
  const idleTimeoutMs = clampInteger(params.get('idleTimeoutMs'), 15 * 60 * 1000, 60 * 1000, 12 * 60 * 60 * 1000);

  const terminalEl = document.getElementById('terminal');

  const terminal = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
    fontSize: 14,
    theme: {
      background: '#020917',
      foreground: '#d6e4ff',
      cursor: '#00d4aa',
      selectionBackground: '#2f3b52',
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  const socketScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socketParams = new URLSearchParams({ idleTimeoutMs: String(idleTimeoutMs) });

  if (token) {
    socketParams.set('token', token);
  } else {
    socketParams.set('host', host);
    socketParams.set('port', port);
    socketParams.set('username', username);
    socketParams.set('password', password);
  }

  const socketUrl = `${socketScheme}://${window.location.host}/ws/ssh?${socketParams.toString()}`;
  let socket = null;
  let heartbeatTimer = null;
  let lastResizeSignature = '';

  terminal.loadAddon(fitAddon);
  terminal.open(terminalEl);

  function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (Number.isNaN(parsed)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
  }

  function setStatus(message, isError) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        {
          type: 'jump-ssh-status',
          state: message,
          isError: Boolean(isError),
        },
        window.location.origin,
      );
    }
  }

  function fitTerminal() {
    fitAddon.fit();
    sendResize();
  }

  function sendResize(force = false) {
    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    const cols = Math.max(2, Number(terminal.cols || 0));
    const rows = Math.max(2, Number(terminal.rows || 0));
    if (!cols || !rows) {
      return;
    }

    const signature = `${cols}x${rows}`;
    if (!force && signature === lastResizeSignature) {
      return;
    }

    lastResizeSignature = signature;
    socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
  }

  function cleanup() {
    stopHeartbeat();
    resizeObserver.disconnect();
  }

  if (!token && (!host || !username)) {
    setStatus('missing session token or host/username', true);
    terminal.writeln('\r\nERROR: session token or host/username are required');
    return;
  }

  const resizeObserver = new ResizeObserver(() => {
    fitTerminal();
  });

  resizeObserver.observe(terminalEl);

  socket = new WebSocket(socketUrl);

  socket.addEventListener('open', () => {
    setStatus('connected', false);
    startHeartbeat();
    fitTerminal();
    sendResize(true);
  });

  socket.addEventListener('message', (event) => {
    let payload = null;

    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === 'data') {
      terminal.write(payload.data || '');
      return;
    }

    if (payload.type === 'error') {
      setStatus('error', true);
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          {
            type: 'jump-ssh-status',
            state: 'error',
            message: payload.message || 'unknown error',
          },
          window.location.origin,
        );
      }

      terminal.writeln(`\r\nERROR: ${payload.message || 'unknown error'}`);
      return;
    }

    if (payload.type === 'status') {
      if (payload.state === 'ready') {
        setStatus('connected', false);
        fitTerminal();
        sendResize(true);
        return;
      }

      if (payload.state === 'idle-timeout') {
        setStatus('idle timeout', true);
        terminal.writeln('\r\nSession closed: idle timeout reached.');
        return;
      }

      if (payload.state === 'closed') {
        setStatus('session closed', true);
        terminal.writeln('\r\nSession closed.');
      }
    }
  });

  socket.addEventListener('close', () => {
    cleanup();
    setStatus('disconnected', true);
    terminal.writeln('\r\nDisconnected from server.');
  });

  socket.addEventListener('error', () => {
    setStatus('websocket error', true);
    terminal.writeln('\r\nWebSocket error.');
  });

  terminal.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  });

  terminal.onResize(({ cols, rows }) => {
    sendResize(true);
  });

  window.addEventListener('resize', fitTerminal);

  setTimeout(() => {
    fitTerminal();
  }, 150);

  // GUI SFTP Explorer Logic
  const tabTerminal = document.getElementById('tab-terminal');
  const tabSftp = document.getElementById('tab-sftp');
  const terminalView = document.getElementById('terminal-view');
  const sftpView = document.getElementById('sftp-view');
  const sftpActions = document.getElementById('sftp-actions');
  const sftpGrid = document.getElementById('sftp-grid');
  const sftpPathText = document.getElementById('sftp-path-text');
  const sftpBreadcrumb = document.getElementById('sftp-breadcrumb');
  const sftpRefreshBtn = document.getElementById('sftp-refresh-btn');
  const sftpUploadBtn = document.getElementById('sftp-upload-btn');
  const sftpDownloadActionBtn = document.getElementById('sftp-download-action-btn');
  const sftpFileInput = document.getElementById('sftp-file-input');
  
  const ctxMenu = document.getElementById('sftp-context-menu');
  const ctxDownload = document.getElementById('ctx-download');
  const ctxRename = document.getElementById('ctx-rename');
  const ctxDelete = document.getElementById('ctx-delete');
  let currentContextTarget = null;
  let currentContextIsDir = false;
  let selectedItemName = null;
  let selectedItemIsDir = false;

  document.addEventListener('click', () => {
    if (ctxMenu) ctxMenu.style.display = 'none';
  });

  sftpView.addEventListener('click', () => {
    Array.from(sftpGrid.querySelectorAll('.sftp-item')).forEach(node => node.classList.remove('selected'));
    selectedItemName = null;
    selectedItemIsDir = false;
  });
  
  let currentRemotePath = '/';
  let sftpLoaded = false;

  function getSftpQueryString() {
    const sftpParams = new URLSearchParams();
    if (token) {
      sftpParams.set('token', token);
    } else {
      sftpParams.set('host', host);
      sftpParams.set('port', port);
      sftpParams.set('username', username);
      sftpParams.set('password', password);
    }
    return sftpParams.toString();
  }
  
  function renderSftpGrid(entries) {
    sftpGrid.innerHTML = '';
    
    // Add ".." if not at root
    if (currentRemotePath !== '/' && currentRemotePath !== '') {
      const parentEl = document.createElement('div');
      parentEl.className = 'sftp-item';
      parentEl.innerHTML = `
        <div class="sftp-icon folder"><i class="fa-solid fa-folder"></i></div>
        <div class="sftp-name">..</div>
      `;
      parentEl.addEventListener('dblclick', () => {
        const parts = currentRemotePath.split('/').filter(Boolean);
        parts.pop();
        loadSftpDirectory('/' + parts.join('/'));
      });
      sftpGrid.appendChild(parentEl);
    }
    
    for (const item of entries) {
      const el = document.createElement('div');
      el.className = 'sftp-item';
      
      let iconClass = 'file';
      let iconHtml = '<i class="fa-regular fa-file"></i>';
      if (item.isDir) {
        iconClass = 'folder';
        iconHtml = '<i class="fa-solid fa-folder"></i>';
      } else if (item.isSymlink) {
        iconClass = 'symlink';
        iconHtml = '<i class="fa-solid fa-link"></i>';
      } else {
        if (item.name.endsWith('.pdf')) iconHtml = '<i class="fa-regular fa-file-pdf"></i>';
        else if (item.name.endsWith('.zip') || item.name.endsWith('.tar.gz')) iconHtml = '<i class="fa-regular fa-file-zipper"></i>';
        else if (item.name.match(/\.(jpg|jpeg|png|gif|svg)$/i)) iconHtml = '<i class="fa-regular fa-image"></i>';
      }
      
      el.innerHTML = `
        <div class="sftp-icon ${iconClass}">${iconHtml}</div>
        <div class="sftp-name" title="${item.name}">${item.name}</div>
      `;
      
      el.addEventListener('click', (e) => {
        Array.from(sftpGrid.querySelectorAll('.sftp-item')).forEach(node => node.classList.remove('selected'));
        el.classList.add('selected');
        selectedItemName = item.name;
        selectedItemIsDir = item.isDir;
        e.stopPropagation();
      });

      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (item.isDir) {
          const nextPath = currentRemotePath.endsWith('/') ? currentRemotePath + item.name : currentRemotePath + '/' + item.name;
          loadSftpDirectory(nextPath);
        } else {
          const filePath = currentRemotePath.endsWith('/') ? currentRemotePath + item.name : currentRemotePath + '/' + item.name;
          const qs = getSftpQueryString();
          const downloadUrl = `/api/ssh/sftp/download?${qs}&remotePath=${encodeURIComponent(filePath)}&isDir=false`;
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.target = '_blank';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
      });

      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        currentContextTarget = item.name;
        currentContextIsDir = item.isDir;
        
        if (ctxMenu) {
          ctxMenu.style.display = 'flex';
          
          let left = e.pageX;
          let top = e.pageY;
          
          // Adjust if menu goes off screen
          if (left + 160 > window.innerWidth) left -= 160;
          if (top + 120 > window.innerHeight) top -= 120;
          
          ctxMenu.style.left = left + 'px';
          ctxMenu.style.top = top + 'px';
        }
      });
      
      sftpGrid.appendChild(el);
    }
  }

  async function loadSftpDirectory(path) {
    try {
      sftpGrid.innerHTML = '<div class="sftp-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading...</div>';
      const qs = getSftpQueryString();
      const res = await fetch(`/api/ssh/sftp/list?${qs}&path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      
      const data = await res.json();
      currentRemotePath = data.path || path;
      
      const parts = currentRemotePath.split('/').filter(Boolean);
      let html = '<i class="fa-solid fa-folder"></i> <span data-path="/">Root</span> ';
      let runningPath = '';
      for (const p of parts) {
        runningPath += '/' + p;
        html += `> <span data-path="${runningPath}">${p}</span> `;
      }
      sftpBreadcrumb.innerHTML = html;
      
      Array.from(sftpBreadcrumb.querySelectorAll('span')).forEach(span => {
        span.addEventListener('click', () => {
          loadSftpDirectory(span.getAttribute('data-path'));
        });
      });
      
      renderSftpGrid(data.entries);
    } catch (err) {
      sftpGrid.innerHTML = `<div class="sftp-loading" style="color:#f43f5e;"><i class="fa-solid fa-circle-exclamation"></i> Error: ${err.message}</div>`;
    }
  }

  if (tabTerminal && tabSftp) {
    tabTerminal.addEventListener('click', () => {
      tabTerminal.classList.add('active');
      tabSftp.classList.remove('active');
      terminalView.classList.add('active-view');
      sftpView.classList.remove('active-view');
      sftpActions.style.display = 'none';
      fitTerminal();
    });

    tabSftp.addEventListener('click', () => {
      tabSftp.classList.add('active');
      tabTerminal.classList.remove('active');
      sftpView.classList.add('active-view');
      terminalView.classList.remove('active-view');
      sftpActions.style.display = 'flex';
      if (!sftpLoaded) {
        sftpLoaded = true;
        loadSftpDirectory(currentRemotePath);
      }
    });
  }
  
  if (sftpRefreshBtn) {
    sftpRefreshBtn.addEventListener('click', () => {
      loadSftpDirectory(currentRemotePath);
    });
  }

  if (sftpUploadBtn && sftpFileInput) {
    sftpUploadBtn.addEventListener('click', () => {
      sftpFileInput.click();
    });

    sftpFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const remotePath = currentRemotePath.endsWith('/') ? currentRemotePath + file.name : currentRemotePath + '/' + file.name;
      
      const confirmPath = prompt('Upload to this path?', remotePath);
      if (!confirmPath) {
        sftpFileInput.value = '';
        return;
      }

      const originalText = sftpUploadBtn.innerHTML;
      sftpUploadBtn.disabled = true;
      sftpUploadBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> UPLOADING...';

      try {
        const qs = getSftpQueryString();
        const uploadUrl = `/api/ssh/sftp/upload?${qs}`;
        
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'X-Jump-Remote-Path': confirmPath
          },
          body: file
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${response.status}`);
        }

        loadSftpDirectory(currentRemotePath);
      } catch (err) {
        alert('Upload failed: ' + err.message);
      } finally {
        sftpUploadBtn.disabled = false;
        sftpUploadBtn.innerHTML = originalText;
        sftpFileInput.value = '';
      }
    });
  }

  if (ctxDownload) {
    ctxDownload.addEventListener('click', () => {
      if (!currentContextTarget) return;
      const filePath = currentRemotePath.endsWith('/') ? currentRemotePath + currentContextTarget : currentRemotePath + '/' + currentContextTarget;
      const qs = getSftpQueryString();
      const downloadUrl = `/api/ssh/sftp/download?${qs}&remotePath=${encodeURIComponent(filePath)}&isDir=${currentContextIsDir}`;
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  if (sftpDownloadActionBtn) {
    sftpDownloadActionBtn.addEventListener('click', () => {
      let downloadPath = currentRemotePath;
      let isDir = true;
      
      if (selectedItemName) {
        downloadPath = currentRemotePath.endsWith('/') ? currentRemotePath + selectedItemName : currentRemotePath + '/' + selectedItemName;
        isDir = selectedItemIsDir;
      }
      
      const qs = getSftpQueryString();
      const downloadUrl = `/api/ssh/sftp/download?${qs}&remotePath=${encodeURIComponent(downloadPath)}&isDir=${isDir}`;
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  if (ctxRename) {
    ctxRename.addEventListener('click', async () => {
      if (!currentContextTarget) return;
      const oldPath = currentRemotePath.endsWith('/') ? currentRemotePath + currentContextTarget : currentRemotePath + '/' + currentContextTarget;
      const newName = prompt('Enter new name:', currentContextTarget);
      if (!newName || newName === currentContextTarget) return;
      const newPath = currentRemotePath.endsWith('/') ? currentRemotePath + newName : currentRemotePath + '/' + newName;
      
      try {
        const qs = getSftpQueryString();
        const res = await fetch(`/api/ssh/sftp/rename?${qs}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldPath, newPath })
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        loadSftpDirectory(currentRemotePath);
      } catch (err) {
        alert('Rename failed: ' + err.message);
      }
    });
  }

  if (ctxDelete) {
    ctxDelete.addEventListener('click', async () => {
      if (!currentContextTarget) return;
      const targetPath = currentRemotePath.endsWith('/') ? currentRemotePath + currentContextTarget : currentRemotePath + '/' + currentContextTarget;
      
      if (!confirm(`Are you sure you want to delete ${currentContextTarget}?`)) return;
      
      try {
        const qs = getSftpQueryString();
        const res = await fetch(`/api/ssh/sftp/delete?${qs}&path=${encodeURIComponent(targetPath)}&isDir=${currentContextIsDir}`, {
          method: 'DELETE'
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        loadSftpDirectory(currentRemotePath);
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    });
  }
})();
