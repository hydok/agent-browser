const $ = (id) => document.getElementById(id);
let state = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function render() {
  const space = state.spaces.find((s) => s.id === state.currentSpaceId);
  const tab = space.tabs.find((t) => t.id === space.activeTabId);
  const userMayAct = space.control === 'user';

  const spaces = $('spaces');
  spaces.replaceChildren();
  for (const s of state.spaces) {
    const chip = el('div', `space ${s.owner}${s.id === space.id ? ' current' : ''}${s.control === 'user' ? ' paused' : ''}`);
    if (s.owner === 'agent') chip.append(el('span', 'dot'));
    chip.append(el('span', '', s.name));
    if (s.owner === 'agent') {
      const x = el('button', 'x', '×');
      x.title = 'Space 닫기';
      x.onclick = (e) => { e.stopPropagation(); window.ab.cmd('closeSpace', s.id); };
      chip.append(x);
    }
    chip.onclick = () => window.ab.cmd('space', s.id);
    spaces.append(chip);
  }

  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const t of space.tabs) {
    const item = el('div', `tab${t.id === space.activeTabId ? ' active' : ''}`);
    item.title = t.url;
    item.append(el('span', 'lbl', t.label), el('span', 't', t.loading ? '로딩 중…' : t.title || t.url || '새 탭'));
    if (userMayAct) {
      const x = el('button', 'x', '×');
      x.onclick = (e) => { e.stopPropagation(); window.ab.cmd('closeTab', t.id); };
      item.append(x);
    }
    item.onclick = () => window.ab.cmd('tab', t.id);
    tabs.append(item);
  }

  $('newTab').disabled = !userMayAct;
  $('back').disabled = !userMayAct || !tab?.canGoBack;
  $('forward').disabled = !userMayAct || !tab?.canGoForward;
  $('reload').disabled = !userMayAct || !tab;
  const url = $('url');
  url.disabled = !userMayAct;
  if (document.activeElement !== url) url.value = tab?.url === 'about:blank' ? '' : tab?.url ?? '';
  $('star').textContent = tab?.bookmarked ? '★' : '☆';
  $('star').disabled = !tab || !/^(https?|file):/.test(tab.url);

  const control = $('control');
  control.className = space.owner === 'agent' ? space.control : '';
  if (space.owner === 'agent') {
    $('controlText').textContent = space.control === 'agent'
      ? `에이전트 작업 중${space.lastAction ? ` · ${space.lastAction}` : ''}`
      : `내가 제어 중${space.handoffReason ? ` · ${space.handoffReason}` : ''}`;
    $('controlBtn').textContent = space.control === 'agent' ? '제어권 가져오기' : '에이전트에게 돌려주기';
  }
}

window.ab.onState((s) => { state = s; render(); });
$('controlBtn').onclick = () => {
  const space = state.spaces.find((s) => s.id === state.currentSpaceId);
  window.ab.cmd(space.control === 'agent' ? 'takeControl' : 'returnControl');
};
$('newTab').onclick = () => window.ab.cmd('newTab');
$('back').onclick = () => window.ab.cmd('back');
$('forward').onclick = () => window.ab.cmd('forward');
$('reload').onclick = () => window.ab.cmd('reload');
$('star').onclick = () => window.ab.cmd('toggleBookmark');
$('bookmarks').onclick = () => window.ab.cmd('bookmarksMenu');
$('history').onclick = () => window.ab.cmd('historyMenu');
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { window.ab.cmd('navigate', e.target.value); e.target.blur(); }
});
$('url').addEventListener('focus', (e) => e.target.select());
