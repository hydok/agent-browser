/// <reference lib="dom" />

// Functions that run inside the web page. They are sent as source text
// (fn.toString()), so they must be self-contained: no imports, no outer variables.

// Main content of the page as Markdown (or plain text), leaving out
// navigation, sidebars, footers, forms and hidden elements.
export function extractMain(format: string): string {
  const root = (() => {
    const c = (document.querySelector('article') ?? document.querySelector('main, [role=main]')) as HTMLElement | null;
    if (c && c.innerText.trim().length > 200) return c;
    let best: HTMLElement | null = null;
    let bestScore = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('div, section, article'))) {
      let score = 0;
      for (const p of Array.from(el.querySelectorAll<HTMLElement>(':scope > p'))) score += p.innerText.length;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore > 200 && best ? best : document.body;
  })();
  if (format === 'text') return root.innerText;

  const SKIP =
    'script,style,noscript,template,nav,aside,footer,iframe,svg,canvas,button,select,input,textarea,' +
    '[aria-hidden=true],[role=navigation],[role=complementary],[role=contentinfo]';
  const inline = (n: Node): string => Array.from(n.childNodes).map(walk).join('').replace(/\s+/g, ' ').trim();
  const walk = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
    if (!(n instanceof HTMLElement) || n.matches(SKIP)) return '';
    if (n.checkVisibility && !n.checkVisibility()) return '';
    const tag = n.tagName.toLowerCase();
    const kids = () => Array.from(n.childNodes).map(walk).join('');
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inline(n)}\n\n`;
    switch (tag) {
      case 'p':
      case 'div':
      case 'section':
      case 'article':
      case 'header':
      case 'main':
        return `\n\n${kids()}\n\n`;
      case 'br':
        return '\n';
      case 'ul':
      case 'ol':
        return `\n${kids()}\n`;
      case 'li':
        return `\n- ${inline(n)}`;
      case 'a': {
        const t = inline(n);
        const href = (n as HTMLAnchorElement).href;
        return t && /^https?:/.test(href) ? `[${t}](${href})` : t;
      }
      case 'strong':
      case 'b': {
        const t = inline(n);
        return t ? `**${t}**` : '';
      }
      case 'pre':
        return `\n\n\`\`\`\n${n.innerText}\n\`\`\`\n\n`;
      case 'table':
        return (
          '\n\n' +
          Array.from((n as HTMLTableElement).rows)
            .map((r, i) => {
              const cells = Array.from(r.cells).map((c) => c.innerText.replace(/\s+/g, ' ').trim());
              const row = `| ${cells.join(' | ')} |`;
              return i === 0 ? `${row}\n|${cells.map(() => ' --- |').join('')}` : row;
            })
            .join('\n') +
          '\n\n'
        );
      default:
        return kids();
    }
  };
  return walk(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The focused element, following focus into same-origin iframes. (document.hasFocus()
// is not used: background agent tabs never have OS focus.)
export function deepActiveElement(): Element | null {
  let e: Element | null = document.activeElement;
  while (e instanceof HTMLIFrameElement && e.contentDocument?.activeElement) e = e.contentDocument.activeElement;
  return e;
}

// Draws the agent's cursor and a short action label over the page. The overlay
// ignores the mouse, and aria-hidden keeps it out of snapshots and extraction.
// It sits under <html>, not <body>, so text= selectors don't match the label.
export function showAgentCursor(x: number | null, y: number | null, label: string, click: boolean) {
  const ID = '__agent_browser_cursor__';
  const w = window as unknown as { __abCursorTimer?: number };
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;transition:opacity .3s';
    host.attachShadow({ mode: 'open' }).innerHTML = `<style>
      .c { position: fixed; left: 0; top: 0; transition: transform .18s ease-out; }
      .c svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
      .l { position: absolute; left: 18px; top: 18px; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis;
           font: 12px -apple-system, BlinkMacSystemFont, sans-serif; color: #fff; background: #2f6fdb; padding: 3px 9px; border-radius: 10px; }
      .r { position: absolute; left: -12px; top: -12px; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #2f6fdb; opacity: 0; }
      .r.on { animation: ping .5s ease-out; }
      @keyframes ping { from { opacity: 1; transform: scale(.4); } to { opacity: 0; transform: scale(1.8); } }
    </style><div class="c"><div class="r"></div><svg width="18" height="22" viewBox="0 0 18 22"><path d="M1.5 1.5l14 10.5-6.6 1.1-3.4 6.4z" fill="#2f6fdb" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><div class="l"></div></div>`;
    document.documentElement.appendChild(host);
  }
  const root = host.shadowRoot!;
  const cursor = root.querySelector('.c') as HTMLElement;
  if (x !== null && y !== null) cursor.style.transform = `translate(${x}px, ${y}px)`;
  (root.querySelector('.l') as HTMLElement).textContent = label;
  if (click) {
    const ring = root.querySelector('.r') as HTMLElement;
    ring.classList.remove('on');
    void ring.offsetWidth; // restart the animation
    ring.classList.add('on');
  }
  host.style.opacity = '1';
  clearTimeout(w.__abCursorTimer);
  w.__abCursorTimer = window.setTimeout(() => (host!.style.opacity = '0'), 4000);
}
