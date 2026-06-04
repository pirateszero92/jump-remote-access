(function bootstrapTheme() {
  const STORAGE_KEY = 'jump:theme';
  const VALID_THEMES = ['dark', 'light', 'system'];
  let systemMediaQuery = null;
  let systemListener = null;

  function setHtmlTheme(id) {
    // dark = use :root vars (no data-theme needed)
    if (id === 'dark' || !id) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', id);
    }
  }

  function removeSystemListener() {
    if (systemMediaQuery && systemListener) {
      systemMediaQuery.removeEventListener('change', systemListener);
      systemListener = null;
    }
  }

  function applyTheme(themeId) {
    const id = VALID_THEMES.includes(themeId) ? themeId : 'dark';
    removeSystemListener();

    if (id === 'system') {
      // Apply immediately based on current OS setting
      setHtmlTheme('system');
      // Also watch for runtime changes (e.g. user toggles OS dark mode)
      systemMediaQuery = window.matchMedia('(prefers-color-scheme: light)');
      systemListener = () => {
        // CSS @media already handles switching — just keep data-theme='system'
        setHtmlTheme('system');
      };
      systemMediaQuery.addEventListener('change', systemListener);
    } else {
      setHtmlTheme(id);
    }

    localStorage.setItem(STORAGE_KEY, id);
  }

  async function loadThemeFromProfile() {
    try {
      const response = await fetch('/api/me', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }

      const profile = await response.json();
      if (profile.theme) {
        applyTheme(profile.theme);
      }
    } catch {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        applyTheme(cached);
      }
    }
  }

  async function saveTheme(themeId) {
    applyTheme(themeId);

    try {
      await fetch('/api/me/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ theme: themeId }),
      });
    } catch {
      // Theme still applied locally
    }
  }

  // Apply cached theme immediately (before network) to avoid flash
  const cached = localStorage.getItem(STORAGE_KEY);
  if (cached) {
    applyTheme(cached);
  } else {
    applyTheme('dark');
  }

  window.jumpTheme = {
    apply: applyTheme,
    save: saveTheme,
    load: loadThemeFromProfile,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadThemeFromProfile);
  } else {
    loadThemeFromProfile();
  }
})();

