(function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  const sessionToken = params.get('token') || '';
  const displayHost = document.getElementById('display');
  const statusText = document.getElementById('status');

  function setStatus(message, isError) {
    statusText.textContent = message;
    statusText.classList.toggle('err', Boolean(isError));
    notifyParent(message, isError);
  }

  function notifyParent(state, isError, message) {
    if (!window.parent || window.parent === window) {
      return;
    }

    window.parent.postMessage(
      {
        type: 'jump-rdp-status',
        state,
        isError: Boolean(isError),
        message: message || state,
      },
      window.location.origin,
    );
  }

  function postError(message) {
    setStatus(message, true);
    notifyParent('error', true, message);
  }

  if (!sessionToken) {
    postError('missing session token');
    return;
  }

  if (typeof Guacamole === 'undefined') {
    postError('guacamole client not loaded');
    return;
  }

  let client = null;
  let mouse = null;
  let keyboard = null;
  let resizeTimer = null;
  let reportedReady = false;

  const displaySurface = document.createElement('div');
  displaySurface.className = 'rdp-display-surface';
  displayHost.appendChild(displaySurface);

  function getDisplaySize() {
    const rect = displayHost.getBoundingClientRect();
    const width = Math.max(640, Math.floor(rect.width) || displayHost.clientWidth || window.innerWidth);
    const height = Math.max(480, Math.floor(rect.height) || displayHost.clientHeight || window.innerHeight);
    return { width, height };
  }

  function fitDisplayToContainer() {
    if (!client) {
      return;
    }

    const display = client.getDisplay();
    const remoteWidth = display.getWidth();
    const remoteHeight = display.getHeight();
    if (!remoteWidth || !remoteHeight) {
      return;
    }

    const containerWidth = displayHost.clientWidth || window.innerWidth;
    const containerHeight = displayHost.clientHeight || window.innerHeight;
    if (!containerWidth || !containerHeight) {
      return;
    }

    const scale = Math.min(
      containerWidth / remoteWidth,
      containerHeight / remoteHeight,
    );

    display.scale(scale > 0 ? scale : 1);

    const bounds = display.getElement();
    const scaledWidth = remoteWidth * (scale > 0 ? scale : 1);
    const scaledHeight = remoteHeight * (scale > 0 ? scale : 1);
    bounds.style.marginLeft = `${Math.max(0, Math.floor((containerWidth - scaledWidth) / 2))}px`;
    bounds.style.marginTop = `${Math.max(0, Math.floor((containerHeight - scaledHeight) / 2))}px`;
  }

  function sendDisplaySize() {
    if (!client) {
      return;
    }

    const { width, height } = getDisplaySize();
    client.sendSize(width, height);
    requestAnimationFrame(fitDisplayToContainer);
  }

  function scheduleResize() {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }

    resizeTimer = setTimeout(sendDisplaySize, 150);
  }

  function markReady() {
    if (reportedReady) {
      return;
    }

    reportedReady = true;
    setStatus('connected', false);
    notifyParent('connected', false);
    sendDisplaySize();
  }

  function bindDisplayResize(display) {
    display.onresize = function onDisplayResize() {
      fitDisplayToContainer();
      scheduleResize();
    };
  }

  if (typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(() => {
      scheduleResize();
    });
    resizeObserver.observe(displayHost);
  }

  window.addEventListener('resize', scheduleResize);
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) {
      return;
    }

    if (event.data?.type === 'jump-rdp-resize') {
      scheduleResize();
    }
  });

  async function connect() {
    const { width, height } = getDisplaySize();
    const response = await fetch(`/api/rdp/connect/${encodeURIComponent(sessionToken)}?width=${width}&height=${height}`, {
      credentials: 'same-origin',
    });

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const payload = await response.json();
        message = payload.error || message;
      } catch {
        // Ignore parse errors
      }

      throw new Error(message);
    }

    const payload = await response.json();
    const socketScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const tunnelBase = `${socketScheme}://${window.location.host}${payload.wsPath}`;
    const connectQuery = new URLSearchParams({
      token: payload.guacToken,
      width: String(payload.width || width),
      height: String(payload.height || height),
      dpi: '96',
    });

    const tunnel = new Guacamole.WebSocketTunnel(tunnelBase);

    tunnel.onerror = function onTunnelError(status) {
      postError(status?.message || 'WebSocket error');
    };

    tunnel.onstatechange = function onTunnelState(state) {
      if (state === Guacamole.Tunnel.State.CLOSED) {
        setStatus('disconnected', true);
        notifyParent('disconnected', true);
      }
    };

    client = new Guacamole.Client(tunnel);
    const display = client.getDisplay();
    bindDisplayResize(display);
    displaySurface.appendChild(display.getElement());

    client.onstatechange = function onClientState(state) {
      if (
        state === Guacamole.Client.State.CONNECTED
        || state === Guacamole.Client.State.WAITING
      ) {
        markReady();
      } else if (state === Guacamole.Client.State.DISCONNECTED) {
        setStatus('disconnected', true);
        notifyParent('disconnected', true);
      }
    };

    client.onerror = function onClientError(status) {
      postError(status?.message || 'RDP connection error');
    };

    client.onsync = function onSync() {
      fitDisplayToContainer();
      markReady();
    };

    mouse = new Guacamole.Mouse(display.getElement());
    mouse.onmousedown =
      mouse.onmouseup =
      mouse.onmousemove =
        function sendMouseState(state) {
          client.sendMouseState(state, true);
        };

    keyboard = new Guacamole.Keyboard(document);
    keyboard.onkeydown = function onKeyDown(keysym) {
      client.sendKeyEvent(1, keysym);
    };
    keyboard.onkeyup = function onKeyUp(keysym) {
      client.sendKeyEvent(0, keysym);
    };

    client.connect(connectQuery.toString());

    // Layout inside iframe may settle after first paint
    requestAnimationFrame(() => {
      sendDisplaySize();
      setTimeout(sendDisplaySize, 300);
    });
  }

  connect().catch((error) => {
    postError(error.message || 'Unable to start RDP session');
  });
})();
