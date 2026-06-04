const THEMES = Object.freeze({
  dark: {
    id: 'dark',
    label: '🌙 Dark',
    description: 'ธีมมืด (ค่าเริ่มต้น)',
  },
  light: {
    id: 'light',
    label: '☀️ Light',
    description: 'ธีมสว่าง',
  },
  system: {
    id: 'system',
    label: '🖥️ System',
    description: 'ตามการตั้งค่า OS',
  },
});

function listThemes() {
  return Object.values(THEMES);
}

function normalizeThemeId(themeId) {
  const id = String(themeId || 'dark').trim().toLowerCase();
  return THEMES[id] ? id : 'dark';
}

module.exports = {
  THEMES,
  listThemes,
  normalizeThemeId,
};
