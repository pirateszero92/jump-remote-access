function parseRdpIdentity({ user, domain, authMode }) {
  const username = String(user || '').trim();
  const domainName = String(domain || '').trim();
  const mode = String(authMode || 'local').toLowerCase();

  if (!username) {
    throw new Error('Username is required for RDP');
  }

  if (username.includes('\\')) {
    const [parsedDomain, parsedUser] = username.split('\\', 2);
    return {
      username: parsedUser,
      domain: parsedDomain || domainName,
    };
  }

  if (username.includes('@')) {
    return { username, domain: domainName };
  }

  if (mode === 'domain' && domainName) {
    return { username, domain: domainName };
  }

  return { username, domain: '' };
}

function buildRdpConnectionToken(session, guacdHost, guacdPort) {
  const { username, domain } = parseRdpIdentity(session);
  const settings = {
    hostname: session.host,
    port: String(session.port || 3389),
    username,
    password: String(session.password || ''),
    security: session.security || 'any',
    'ignore-cert': true,
    'enable-wallpaper': false,
    'enable-font-smoothing': true,
    'resize-method': 'display-update',
    width: String(session.width || 1280),
    height: String(session.height || 800),
    dpi: String(session.dpi || 96),
  };

  if (domain) {
    settings.domain = domain;
  }

  const connection = {
    type: 'rdp',
    settings,
  };

  if (guacdHost) {
    connection.guacdHost = guacdHost;
  }

  if (guacdPort) {
    connection.guacdPort = guacdPort;
  }

  return { connection };
}

module.exports = {
  buildRdpConnectionToken,
  parseRdpIdentity,
};
