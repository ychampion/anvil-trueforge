(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log'), inp = $('inp'), ac = $('ac'), chips = $('chips');
  const sendBtn = $('send'), cancelBtn = $('cancel');
  let assistant = null;      // current streaming text element
  let timeline = null;       // current run's model timeline element
  let busy = false;
  const mentions = { files: [], symbols: [] };
  const toolCards = new Map();
  const reviewCards = new Map();

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function add(node) {
    const empty = log.querySelector('.empty');
    if (empty) empty.remove();
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(node);
    if (stick) log.scrollTop = log.scrollHeight;
    return node;
  }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function setBusy(b) {
    busy = b; sendBtn.disabled = b; cancelBtn.disabled = !b;
  }
  function md(text) {
    // minimal: code fences + inline code, everything escaped
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const parts = text.split(/```/);
    return parts.map((p, i) => {
      if (i % 2 === 1) { const nl = p.indexOf('\n'); return '<pre>' + esc(nl >= 0 ? p.slice(nl + 1) : p) + '</pre>'; }
      return esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
    }).join('');
  }

  function onMsg(m) {
    switch (m.type) {
      case 'header':
        if (m.connected !== undefined) $('conn').className = 'dot ' + (m.connected ? 'ok' : 'bad');
        if (m.connected !== undefined) $('conn').title = m.connected ? 'TrueForge connected' : 'TrueForge not reachable';
        if (m.model) $('model').textContent = 'model: ' + m.model;
        break;
      case 'runStart': {
        assistant = null; toolCards.clear();
        const u = add(el('div', 'user'));
        u.textContent = m.request;
        timeline = add(el('div', 'timeline'));
        setBusy(true);
        break;
      }
      case 'context': {
        const p = m.pack || {};
        const card = add(el('details', 'card ctx'));
        card.open = true;
        const s = el('summary');
        s.textContent = `Context chosen · ${p.items ? p.items.length : 0} items · ${p.usedTokens ?? '?'} / ${p.budgetTokens ?? '?'} tokens`;
        card.appendChild(s);
        for (const it of p.items || []) {
          const r = el('div', 'ctxrow');
          r.appendChild(el('span', 'path', `${it.path}:${it.startLine}-${it.endLine}`));
          r.appendChild(el('span', 'tag', it.source));
          r.appendChild(el('span', 'tok', `${it.tokens} tok`));
          r.appendChild(el('div', 'why', it.reason));
          card.appendChild(r);
        }
        if (p.excluded && p.excluded.length) {
          const ex = el('details', 'excl');
          ex.appendChild(el('summary', '', `Excluded (${p.excluded.length})`));
          for (const x of p.excluded.slice(0, 40)) ex.appendChild(el('div', 'why', `${x.path} · ${x.tokens} tok · ${x.reason}`));
          card.appendChild(ex);
        }
        break;
      }
      case 'text':
        if (!assistant) { assistant = add(el('div', 'assistant')); assistant._raw = ''; }
        assistant._raw += m.delta;
        assistant.innerHTML = md(assistant._raw) + '<span class="caret"></span>';
        if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) scroll();
        break;
      case 'resetText':
        if (assistant) { assistant.classList.add('stale'); assistant.innerHTML = md(assistant._raw); }
        assistant = null;
        break;
      case 'subText':
        break;
      case 'toolCall': {
        finishText();
        const c = add(el('div', 'card tool'));
        c.appendChild(el('span', 'tname', m.name));
        c.appendChild(el('span', 'targs', m.summary || ''));
        const st = c.appendChild(el('span', 'st', 'running'));
        const res = c.appendChild(el('div', 'tres'));
        toolCards.set(m.id, { c, st, res });
        break;
      }
      case 'approval': {
        const t = toolCards.get(m.id);
        if (t) t.st.textContent = 'awaiting review';
        break;
      }
      case 'approvalResult': {
        const t = toolCards.get(m.id);
        if (t) {
          t.st.textContent = m.status === 'allow' ? 'approved' : 'denied';
          t.st.className = 'st ' + (m.status === 'allow' ? 'ok' : 'bad');
          if (m.reason) t.res.textContent = m.reason;
        }
        break;
      }
      case 'toolResult': {
        const t = toolCards.get(m.id);
        if (t) {
          if (t.st.textContent === 'running') { t.st.textContent = 'done'; t.st.className = 'st ok'; }
          t.res.textContent = m.summary || '';
        }
        break;
      }
      case 'review': {
        let c = reviewCards.get(m.id);
        if (!c) {
          finishText();
          c = add(el('div', 'card review'));
          reviewCards.set(m.id, c);
        }
        const label = m.status === 'pending' ? `${m.accepted} of ${m.hunks} hunks accepted, ${m.rejected} rejected · reviewing`
          : m.status === 'applied' ? `${m.accepted} of ${m.hunks} hunks accepted · applied`
          : m.status === 'rejected' ? `all ${m.hunks} hunks rejected · not written`
          : m.status;
        c.innerHTML = '';
        c.appendChild(el('span', 'tname', 'review'));
        c.appendChild(el('span', 'targs', m.relPath));
        c.appendChild(el('span', 'st ' + (m.status === 'applied' ? 'ok' : m.status === 'pending' ? '' : 'bad'), label));
        break;
      }
      case 'timeline': {
        if (!timeline) timeline = add(el('div', 'timeline'));
        const r = el('div', 'tl ' + m.kind);
        r.innerHTML = md(m.text);
        timeline.appendChild(r);
        break;
      }
      case 'session': {
        const a = $('sess');
        a.textContent = 'session ' + m.id.slice(0, 10) + '…';
        a.dataset.url = m.url;
        $('model').textContent = 'model: ' + m.model;
        break;
      }
      case 'usage': break;
      case 'status': break;
      case 'event': {
        const r = add(el('div', 'ev ' + (m.kind || '')));
        r.appendChild(el('span', 'evk', m.kind || 'event'));
        r.appendChild(el('span', '', m.title));
        if (m.detail) r.appendChild(el('div', 'why', m.detail));
        break;
      }
      case 'runEnd':
        finishText();
        setBusy(false);
        if (m.status === 'error') add(el('div', 'err', m.error || 'failed'));
        else if (m.status === 'cancelled') add(el('div', 'ev', 'Cancelled. ' + (m.restored ? m.restored : 'No files were changed.')));
        else if (m.summary) add(el('div', 'ev', m.summary));
        break;
      case 'mentionResults': showAc(m); break;
    }
  }
  function finishText() {
    if (assistant) { assistant.innerHTML = md(assistant._raw); assistant = null; }
  }

  // ---- @-mentions ----
  let acItems = [], acSel = 0, acTimer = null;
  function currentMention() {
    const pos = inp.selectionStart;
    const before = inp.value.slice(0, pos);
    const m = before.match(/(^|\s)@([\w./\-]*)$/);
    return m ? { q: m[2], start: pos - m[2].length - 1, end: pos } : null;
  }
  function showAc(m) {
    const cur = currentMention();
    if (!cur || cur.q !== m.q) return;
    const symFirst = /^[A-Z_]/.test(m.q) || (m.q && !/[./]/.test(m.q) && /^[a-z_]+$/.test(m.q) && false);
    const files = (m.files || []).map((f) => ({ kind: 'file', label: f, value: f }));
    const syms = (m.symbols || []).map((s) => ({ kind: 'symbol', label: `${s.name}  ${s.path}:${s.line}`, value: s.name }));
    acItems = (symFirst ? syms.concat(files) : files.concat(syms)).slice(0, 12);
    acSel = 0;
    renderAc();
  }
  function renderAc() {
    ac.innerHTML = '';
    if (!acItems.length) { ac.hidden = true; return; }
    acItems.forEach((it, i) => {
      const r = el('div', 'acrow' + (i === acSel ? ' sel' : ''));
      r.appendChild(el('span', 'tag', it.kind));
      r.appendChild(el('span', '', it.label));
      r.onmousedown = (e) => { e.preventDefault(); pick(i); };
      ac.appendChild(r);
    });
    ac.hidden = false;
  }
  function pick(i) {
    const it = acItems[i]; const cur = currentMention();
    if (!it || !cur) return;
    inp.value = inp.value.slice(0, cur.start) + '@' + it.value + ' ' + inp.value.slice(cur.end);
    const list = it.kind === 'file' ? mentions.files : mentions.symbols;
    if (!list.includes(it.value)) list.push(it.value);
    renderChips();
    ac.hidden = true; acItems = [];
    inp.focus();
  }
  function renderChips() {
    chips.innerHTML = '';
    for (const k of ['files', 'symbols']) {
      for (const v of mentions[k]) {
        const c = el('span', 'chip ' + k, (k === 'files' ? '' : '# ') + v);
        const x = el('span', 'x', '×');
        x.onclick = () => { mentions[k] = mentions[k].filter((y) => y !== v); renderChips(); };
        c.appendChild(x);
        chips.appendChild(c);
      }
    }
  }
  inp.addEventListener('input', () => {
    const cur = currentMention();
    if (!cur) { ac.hidden = true; return; }
    clearTimeout(acTimer);
    acTimer = setTimeout(() => vscode.postMessage({ type: 'mentionQuery', q: cur.q }), 60);
  });
  inp.addEventListener('keydown', (e) => {
    if (!ac.hidden && acItems.length) {
      if (e.key === 'ArrowDown') { acSel = (acSel + 1) % acItems.length; renderAc(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { acSel = (acSel - 1 + acItems.length) % acItems.length; renderAc(); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { pick(acSel); e.preventDefault(); return; }
      if (e.key === 'Escape') { ac.hidden = true; e.preventDefault(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && busy) { vscode.postMessage({ type: 'cancel' }); }
  });
  function send() {
    const text = inp.value.trim();
    if (!text || busy) return;
    // also pick up typed mentions that were not chosen from the list
    for (const m of text.matchAll(/(^|\s)@([\w./\-]+)/g)) {
      const v = m[2];
      if (mentions.files.includes(v) || mentions.symbols.includes(v)) continue;
      if (/[./]/.test(v)) mentions.files.push(v); else mentions.symbols.push(v);
    }
    vscode.postMessage({ type: 'send', text, mentions });
    inp.value = '';
    mentions.files = []; mentions.symbols = []; renderChips();
  }
  sendBtn.onclick = send;
  cancelBtn.onclick = () => vscode.postMessage({ type: 'cancel' });
  $('undoRun').onclick = () => vscode.postMessage({ type: 'undoRun' });
  $('undoLast').onclick = () => vscode.postMessage({ type: 'undoLast' });
  $('sess').onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'openSession' }); };
  window.addEventListener('message', (e) => onMsg(e.data));
  vscode.postMessage({ type: 'ready' });
})();
