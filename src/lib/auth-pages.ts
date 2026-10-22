import { SERVICE_NAME } from './project.ts';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

// Standalone loopback pages: no site assets or network requests are needed.
function page(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${title} · ${SERVICE_NAME}</title>
  <style>
    :root {
      --void: #08080a; --surface: #0f0f13; --ink: #f5f5f4;
      --ink-2: rgba(245,245,244,.68); --ink-3: rgba(245,245,244,.5);
      --line: rgba(255,255,255,.12); --accent: #f2c14e; --accent-ink: #1a1300;
      --font-ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--void); color: var(--ink); font: 15px/1.6 var(--font-ui); }
    header { padding: 24px 32px; }
    .brand { color: var(--ink); text-decoration: none; font-size: 18px; font-weight: 600; letter-spacing: -.04em; }
    main { min-height: calc(100svh - 80px); display: grid; align-items: center; padding: 48px 24px 112px; }
    .content { width: 100%; max-width: 480px; margin: 0 auto; }
    .label { margin: 0 0 16px; color: var(--ink-3); font-size: 11px; font-weight: 500; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0 0 16px; font-size: clamp(32px, 6vw, 44px); line-height: 1.1; font-weight: 600; letter-spacing: -.04em; }
    p { margin: 0; color: var(--ink-2); }
    .prompt { margin-top: 32px; padding: 24px; background: var(--surface); border-radius: 16px; box-shadow: 0 0 0 1px var(--line); }
    h2 { margin: 0 0 12px; font-size: 13px; font-weight: 600; }
    blockquote { margin: 0 0 24px; color: var(--ink); }
    button { padding: 12px 20px; border: 0; border-radius: 9999px; background: var(--accent); color: var(--accent-ink); font: 500 13px var(--font-ui); cursor: pointer; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
    button:hover { filter: brightness(1.08); }
    .hint { margin-top: 16px; font-size: 12px; color: var(--ink-3); }
    .error-code { margin: 24px 0; overflow-wrap: anywhere; font: 12px/1.6 var(--font-mono); }
    @media (max-width: 480px) { header { padding: 24px; } .prompt { padding: 20px; } }
  </style>
</head>
<body>
  <header><a class="brand" href="https://makefx.app">${SERVICE_NAME}</a></header>
  <main><div class="content">${content}</div></main>
</body>
</html>`;
}

export function getSuccessPage(): string {
  return page('Return to your agent', `
    <p class="label">makefx CLI · Authorized</p>
    <h1>Back to your ideas.</h1>
    <p>Return to your terminal to finish signing in. You can close this tab.</p>
    <section class="prompt" aria-labelledby="prompt-title">
      <h2 id="prompt-title">Try this with your agent</h2>
      <blockquote id="prompt">Use makefx to create an image of a tiny observatory above the clouds at blue hour. Choose a suitable model and show me the cost before creating it. Wait for my confirmation.</blockquote>
      <button type="button" id="copy" hidden>Copy prompt</button>
      <p class="hint" id="copy-status" role="status">Paste this into your agent to make your first asset.</p>
    </section>
    <script>
      const button = document.getElementById('copy');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        button.hidden = false;
        button.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(document.getElementById('prompt').textContent);
            document.getElementById('copy-status').textContent = 'Copied. Paste it into your agent.';
          } catch {
            document.getElementById('copy-status').textContent = 'Select the prompt above and copy it to your agent.';
          }
        });
      }
    </script>`);
}

export function getErrorPage(error: string, description?: string): string {
  return page('Sign-in interrupted', `
    <p class="label">makefx CLI · Authorization</p>
    <h1>Sign-in interrupted.</h1>
    <p>${escapeHtml(description || 'Authorization was denied or failed.')}</p>
    <p class="error-code">Error: ${escapeHtml(error)}</p>
    <p>Return to your terminal and try signing in again.</p>`);
}
