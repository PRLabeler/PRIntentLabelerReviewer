export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — PRIntentLabeler</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
      background: #0d1117;
      color: #e6edf3;
    }
    body { margin: 0; padding: 32px 16px; }
    main { max-width: 760px; margin: 0 auto; }
    .card {
      border: 1px solid #30363d;
      border-radius: 10px;
      padding: 24px;
      background: #161b22;
      margin-bottom: 18px;
    }
    h1 { font-size: 1.6rem; margin: 0 0 8px; }
    h2 { font-size: 1.1rem; margin-top: 0; }
    p { color: #b1bac4; }
    label { display: block; font-weight: 600; margin: 18px 0 6px; }
    input, select, textarea {
      box-sizing: border-box;
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #484f58;
      border-radius: 6px;
      background: #0d1117;
      color: #e6edf3;
      font: inherit;
    }
    textarea {
      min-height: 260px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9rem;
      line-height: 1.45;
    }
    small { display: block; color: #8c959f; margin-top: 5px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 24px; }
    button, .button {
      border: 1px solid rgba(240, 246, 252, 0.1);
      border-radius: 6px;
      padding: 9px 16px;
      background: #238636;
      color: #fff;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
    }
    button.secondary, .button.secondary { background: #21262d; }
    button.danger { background: #da3633; }
    .notice {
      border-left: 4px solid #2f81f7;
      background: rgba(47, 129, 247, 0.12);
      padding: 12px 14px;
      margin: 16px 0;
    }
    .notice.error {
      border-color: #f85149;
      background: rgba(248, 81, 73, 0.12);
    }
    .notice.success {
      border-color: #3fb950;
      background: rgba(63, 185, 80, 0.12);
    }
    .muted { color: #8c959f; }
    code { background: #0d1117; padding: 2px 5px; border-radius: 4px; }
    ul.installations { list-style: none; padding: 0; }
    ul.installations li { margin: 10px 0; }
    .repository-selector { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .repository-selector label { margin: 0; }
    .repository-selector select { flex: 1; min-width: 180px; width: auto; }
    .mapping-table { overflow-x: auto; margin-top: 18px; }
    .mapping-table table { border-collapse: collapse; width: 100%; text-align: left; }
    .mapping-table th, .mapping-table td { padding: 12px 8px; border-bottom: 1px solid #30363d; vertical-align: top; }
    .mapping-table th:first-child { width: 48%; }
    .mapping-table label { margin: 0; overflow-wrap: anywhere; }
    .mapping-table select { min-width: 170px; }
    .expert-configuration-links { margin-top: 18px; font-size: 0.9rem; }
    .expert-configuration-links .actions { margin-top: 12px; }
    .expert-configuration-links .button {
      transition: background-color 160ms ease, border-color 160ms ease, box-shadow 160ms ease, transform 80ms ease;
    }
    .expert-configuration-links .button:hover {
      background: #17365a;
      border-color: #2f81f7;
      box-shadow: 0 0 0 2px rgba(47, 129, 247, 0.12);
    }
    .expert-configuration-links .button:focus-visible {
      outline: 2px solid #58a6ff;
      outline-offset: 3px;
    }
    .expert-configuration-links .button:active {
      background: #102844;
      border-color: #58a6ff;
      box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.35);
      transform: translateY(1px);
    }
    @media (prefers-reduced-motion: reduce) {
      .expert-configuration-links .button { transition: none; }
      .expert-configuration-links .button:active { transform: none; }
    }
    summary { cursor: pointer; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

export function renderErrorPage(message: string, status = 400): string {
  return renderPage(
    `Erreur ${status}`,
    `<section class="card">
      <h1>Configuration indisponible</h1>
      <div class="notice error">${escapeHtml(message)}</div>
      <a class="button secondary" href="/settings">Retour aux configurations</a>
    </section>`,
  );
}
