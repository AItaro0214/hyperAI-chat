/* Monotone line icons — 24px grid, currentColor stroke, no fills. */
export const ICON = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.5 16.5L21 21',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 9h17M3.5 15h17M12 3c-2.4 2.4-2.4 15.6 0 18M12 3c2.4 2.4 2.4 15.6 0 18',
  image: 'M4 5.5h16v13H4zM4 15l4.5-4.5L13 15M14.5 13l2-2L20 14.5M15.5 9.5h.01',
  spark: 'M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  clip: 'M20 11.5l-8.3 8.3a4.6 4.6 0 0 1-6.5-6.5l8.3-8.3a3 3 0 0 1 4.3 4.3l-8.3 8.3a1.5 1.5 0 0 1-2.1-2.1l7.6-7.6',
  'mic-off': 'M9.4 5.2A2.6 2.6 0 0 1 14.6 6.6v3.2M14.6 13.2a2.6 2.6 0 0 1-5.2-1.4V9M6 11a6 6 0 0 0 9 5.2M18 11a6 6 0 0 1-.6 2.6M12 17v3M9 20h6M4 4l16 16',
  mic: 'M12 4a2.6 2.6 0 0 1 2.6 2.6v4.8a2.6 2.6 0 0 1-5.2 0V6.6A2.6 2.6 0 0 1 12 4zM6 11a6 6 0 0 0 12 0M12 17v3M9 20h6',
  send: 'M12 20V5M6 11l6-6 6 6',
  stop: 'M8 8h8v8H8z',
  copy: 'M9.5 9.5h9v9h-9zM5.5 14.5V6a1.5 1.5 0 0 1 1.5-1.5h8.5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  volume: 'M11 5.5L6.8 9.2H4.2a.8.8 0 0 0-.8.8v4a.8.8 0 0 0 .8.8h2.6L11 18.5zM15 9.6a3.4 3.4 0 0 1 0 4.8M17.6 7a7 7 0 0 1 0 10',
  redo: 'M19.5 11a7.5 7.5 0 1 0-2 6M19.5 5.5V11H14',
  trash: 'M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2L17.5 7M10 10.5v6M14 10.5v6',
  chevron: 'M8 10l4 4 4-4',
  link: 'M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.2 1.2M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.2-1.2',
  warning: 'M12 4.5l8 14H4zM12 10v4M12 16.5h.01',
  sliders: 'M5 8h9M17.5 8H19M5 16h2M10.5 16H19M15.5 5.8v4.4M8.5 13.8v4.4',
  file: 'M6 3.5h7l5 5v12H6zM13 3.5V9h5',
  video: 'M3.5 6.5h11v11h-11zM14.5 10.5l6-3.5v10l-6-3.5',
  play: 'M8 5.5l11 6.5-11 6.5z',
  external: 'M14 4.5h5.5V10M19 5l-8 8M18 14v4.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14',
  code: 'M9 8l-4.5 4L9 16M15 8l4.5 4L15 16',
  table: 'M4 6h16v12H4zM4 10h16M10 10v8M15 10v8',
  slides: 'M4 5h16v10H4zM12 15v4M9 19h6',
  doc: 'M6 3.5h7l5 5v12H6zM13 3.5V9h5M9 13h6M9 16.5h6',
};

export function icon(name, size = 20) {
  return (
    '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true"><path d="' +
    (ICON[name] || '') +
    '"/></svg>'
  );
}

/** Replaces every <i data-icon="name"> placeholder with its inline SVG. */
export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    const size = Number(node.dataset.size || 20);
    node.innerHTML = icon(node.dataset.icon, size);
  }
}
