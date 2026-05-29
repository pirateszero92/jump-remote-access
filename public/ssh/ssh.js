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
})();
