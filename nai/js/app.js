/*
 * NAI Prompt Generator — UI / 생성 파이프라인
 *
 * USER SEND → 맥락 확인 → Query Planner → 로컬 CSV 검색 → 최종 요청 조립
 *           → API / 프록시 / 로컬 호출 (스트리밍) → 로컬 검증 → 저장(lastFinalPrompt)
 *
 * 보안: API 키·프록시 토큰은 console, 오류 메시지, 디버그 표시 어디에도 출력하지 않는다.
 */
(function () {
  'use strict';
  var C = window.NAICore;

  var S = {
    store: null,
    settings: C.mergeDefaults(null),
    chats: new Map(),
    currentId: null,
    engine: null,
    refMeta: null,
    gen: null,            // { chatId, assistantId, controller, phase }
    plannerCache: new Map(),
    attachments: [],      // 입력창에 첨부된 이미지 (전송 전)
    edit: null,           // 보낸 메시지 수정 중: { id, text, images }
    draft: null,
    dirty: false,
    tab: 'prompt'
  };

  // ───────────────────────── 유틸 ─────────────────────────
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x != null && x !== false) n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }
  function icon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('class', 'i');
    s.setAttribute('aria-hidden', 'true');
    var u = document.createElementNS(ns, 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  }
  function appendAll(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i] != null && arguments[i] !== false) parent.append(arguments[i]);
    return parent;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fmtNum(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function fmtBytes(b) {
    if (!b) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB']; var i = Math.min(3, Math.floor(Math.log(b) / Math.log(1024)));
    return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function fmtDate(t) { try { return new Date(t).toLocaleString('ko-KR'); } catch (_) { return String(t); } }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} }
  function getPath(o, p) { return p.split('.').reduce(function (a, k) { return a == null ? a : a[k]; }, o); }
  function setPath(o, p, v) { var ks = p.split('.'); var last = ks.pop(); var t = ks.reduce(function (a, k) { return a[k] = a[k] || {}; }, o); t[last] = v; }
  function safe(text) { return C.redact(text, C.secretsOf(S.settings).concat(S.draft ? C.secretsOf(S.draft) : [])); }

  function download(name, text, type) {
    var a = el('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'text/plain;charset=utf-8' })), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function copyText(text, btn) {
    function ok() {
      if (!btn) return;
      var old = btn.innerHTML;
      btn.classList.add('done');
      btn.replaceChildren(icon('check'), '복사됨');
      setTimeout(function () { btn.classList.remove('done'); btn.innerHTML = old; }, 1400);
    }
    function fallback() {
      var ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (_) { alert('복사하지 못했습니다. 직접 선택해 복사하세요.'); }
      ta.remove();
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }

  function banner(text) { $('banner').textContent = text || ''; }

  // ───────────────────────── 저장 ─────────────────────────
  function saveChat(chat) {
    return S.store.put('chats', JSON.parse(JSON.stringify(chat))).catch(function () {
      banner('대화를 저장하지 못했습니다. 브라우저 저장 공간을 확인하세요.');
    });
  }
  function saveSettings() { return S.store.put('kv', S.settings, 'settings'); }

  // ───────────────────────── 대화방 ─────────────────────────
  function currentChat() { return S.currentId ? S.chats.get(S.currentId) : null; }

  function sortedChats() {
    return Array.from(S.chats.values()).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  function selectChat(id) {
    saveDraftNow();
    S.currentId = id && S.chats.has(id) ? id : null;
    S.edit = null;
    lsSet('nai:current', S.currentId || '');
    $('app').classList.remove('sb-open');
    renderChatList();
    renderThread(true);
    loadDraft();
    $('input').focus();
  }

  function newChat() { selectChat(null); }

  function deleteChat(id) {
    var c = S.chats.get(id);
    if (!c) return;
    if (S.gen && S.gen.chatId === id) { alert('생성 중인 대화는 삭제할 수 없습니다. 먼저 중지하세요.'); return; }
    if (!confirm('"' + c.title + '" 대화를 삭제할까요? 되돌릴 수 없습니다.')) return;
    S.chats.delete(id);
    S.store.del('chats', id);
    lsSet('nai:draft:' + id, '');
    if (S.currentId === id) selectChat(null); else renderChatList();
  }

  function renameChat(id, row) {
    var c = S.chats.get(id);
    if (!c) return;
    var inp = el('input', { 'aria-label': '대화방 이름' });
    inp.value = c.title;
    row.replaceChildren(inp);
    inp.focus(); inp.select();
    var done = false;
    function finish(save) {
      if (done) return; done = true;
      var v = inp.value.trim();
      if (save && v && v !== c.title) { c.title = v.slice(0, 80); saveChat(c); }
      renderChatList(); renderTitle();
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', function () { finish(true); });
  }

  function renderChatList() {
    var list = $('chat-list');
    var chats = sortedChats();
    if (!chats.length) { list.replaceChildren(el('div', { class: 'sb-empty', text: '아직 대화가 없습니다.' })); return; }
    list.replaceChildren.apply(list, chats.map(function (c) {
      var row = el('div', { class: 'chat-item' + (c.id === S.currentId ? ' active' : '') });
      var gen = S.gen && S.gen.chatId === c.id;
      appendAll(row,
        el('button', { class: 'open', type: 'button', title: c.title, 'aria-current': c.id === S.currentId ? 'page' : null, onclick: function () { selectChat(c.id); }, ondblclick: function () { renameChat(c.id, row); } }, c.title),
        gen ? el('span', { class: 'gen-dot', title: '생성 중' }) : null,
        el('button', { class: 'mini', type: 'button', title: '이름 변경', 'aria-label': '이름 변경', onclick: function () { renameChat(c.id, row); } }, icon('edit')),
        el('button', { class: 'mini', type: 'button', title: '삭제', 'aria-label': '삭제', onclick: function () { deleteChat(c.id); } }, icon('trash'))
      );
      return row;
    }));
  }

  function renderTitle() {
    var c = currentChat();
    $('chat-title').textContent = c ? c.title : '';
    document.title = c ? c.title + ' · NAI Prompt Generator' : 'NAI Prompt Generator';
  }

  // ───────────────────────── 메시지 렌더 ─────────────────────────
  var PHASE_TEXT = { start: '준비 중...', plan: '참조 태그 검색 중...', index: '참조 인덱스 준비 중...', search: '참조 태그 검색 중...', generate: '프롬프트 생성 중...', validate: '검증 중...' };

  function renderResultBody(text, streaming) {
    var pre = el('div', { class: 'result-body' });
    if (streaming) {
      pre.append(text, el('span', { class: 'cursor' }));
      return pre;
    }
    var re = /```[^\n]*\n([\s\S]*?)```/g;
    var last = 0, m, any = false;
    while ((m = re.exec(text))) {
      any = true;
      var before = text.slice(last, m.index);
      if (before.trim()) pre.append(before.replace(/^\n+|\n+$/g, ''));
      var code = m[1].replace(/\n$/, '');
      var btn = el('button', { class: 'act', type: 'button', title: '이 블록 복사' }, icon('copy'), '복사');
      btn.addEventListener('click', function (c, b) { return function () { copyText(c, b); }; }(code, btn));
      pre.append(el('div', { class: 'seg-code' }, btn, el('pre', null, code)));
      last = re.lastIndex;
    }
    if (!any) { pre.textContent = text; return pre; }
    var rest = text.slice(last);
    if (rest.trim()) pre.append(rest.replace(/^\n+|\n+$/g, ''));
    return pre;
  }

  // ───────────────────────── 보낸 메시지 수정 ─────────────────────────
  function startEdit(chat, m) {
    if (S.gen) return;
    S.edit = { id: m.id, text: m.content || '', images: (m.images || []).slice() };
    renderThread();
    var ta = $('thread').querySelector('.edit-box textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  function cancelEdit() {
    S.edit = null;
    renderThread();
  }

  function saveEdit(chat, m) {
    if (S.gen || !S.edit) return;
    var text = S.edit.text.trim();
    var images = S.edit.images;
    if (!text && !images.length) { alert('내용이 비어 있습니다. 글이나 이미지가 하나는 있어야 합니다.'); return; }
    var i = chat.messages.indexOf(m);
    if (i < 0) { S.edit = null; renderThread(); return; }
    // ChatGPT 방식: 수정한 메시지 아래 대화는 지우고 거기서부터 다시 생성
    var now = Date.now();
    var userMsg = { id: uid(), role: 'user', content: text, createdAt: now, editedFrom: m.id };
    if (images.length) userMsg.images = images;
    var asst = { id: uid(), role: 'assistant', content: '', status: 'streaming', replyTo: userMsg.id, createdAt: now };
    chat.messages = chat.messages.slice(0, i).concat([userMsg, asst]);
    recomputeLastFinal(chat);
    chat.updatedAt = now;
    S.edit = null;
    renderChatList();
    renderThread(true);
    generate(chat, userMsg, asst);
  }

  function renderEditBox(chat, m) {
    var ed = S.edit;
    var ta = el('textarea', { class: 'ta', rows: '3', 'aria-label': '메시지 수정' });
    ta.value = ed.text;
    function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 360) + 'px'; }
    ta.addEventListener('input', function () { ed.text = ta.value; grow(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); saveEdit(chat, m); }
    });
    requestAnimationFrame(grow);
    var imgs = el('div', { class: 'msg-imgs' }, ed.images.map(function (im) {
      return el('div', { class: 'att', title: im.name || '이미지' }, el('img', { src: im.dataUrl, alt: im.name || '첨부 이미지' }),
        el('button', { class: 'att-x', type: 'button', title: '이미지 빼기', 'aria-label': '이미지 빼기', onclick: function () {
          ed.images = ed.images.filter(function (x) { return x !== im; }); renderThread();
        } }, icon('x')));
    }));
    var hasLater = chat.messages.length - chat.messages.indexOf(m) - 1 > 1; // 자기 답변 외에 뒤 대화가 있는지
    return el('div', { class: 'msg user', 'data-mid': m.id }, el('div', { class: 'edit-box' },
      ed.images.length ? imgs : null,
      ta,
      el('div', { class: 'edit-foot' },
        el('span', { class: 'hint', text: hasLater ? '저장하면 이 메시지 아래 대화는 삭제되고 다시 생성합니다. (Ctrl+Enter 저장 · Esc 취소)' : '저장하면 수정한 내용으로 다시 생성합니다. (Ctrl+Enter 저장 · Esc 취소)' }),
        el('button', { class: 'btn', type: 'button', onclick: cancelEdit }, '취소'),
        el('button', { class: 'btn primary', type: 'button', disabled: !!S.gen, onclick: function () { saveEdit(chat, m); } }, '저장'))));
  }

  function isLastAssistant(chat, m) {
    for (var i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].role === 'assistant') return chat.messages[i].id === m.id;
    return false;
  }

  function issueList(issues, showInfo) {
    var shown = issues.filter(function (x) { return showInfo || x.level !== 'info'; });
    if (!shown.length) return null;
    var LV = { error: '오류', warn: '경고', info: '정보', ok: '정상' };
    return el('div', { class: 'issues' }, shown.map(function (x) {
      return el('div', { class: 'issue' }, el('span', { class: 'lv lv-' + x.level, text: LV[x.level] || x.level }), el('span', { text: x.message }));
    }));
  }

  function debugText(d) {
    if (!d) return '';
    var L = [];
    if (d.model) L.push('model: ' + d.model);
    if (d.endpointKind) L.push('endpoint: ' + d.endpointKind + (d.hostKind ? ' (' + d.hostKind + ')' : '') + ' · auth: ' + (d.credentialLabel || '-'));
    if (d.images) L.push('첨부 이미지: ' + d.images + (d.sentImages != null ? ' · 이번 요청에 전송 ' + d.sentImages + '장' : ''));
    if (d.planner) L.push('planner: ' + d.planner + (d.plannerNote ? ' · ' + d.plannerNote : ''));
    if (d.keywords) L.push('검색 키워드 (' + d.keywords.length + '): ' + d.keywords.join(', '));
    if (d.candidateCount != null) L.push('CSV 후보: ' + d.candidateCount + '개' + (d.searchMs != null ? ' · 검색 ' + d.searchMs + 'ms' : ''));
    if (d.context) L.push('맥락: ' + d.context);
    if (d.requestBodyKeys) L.push('body: ' + d.requestBodyKeys.join(', '));
    if (d.timings) L.push('시간: 헤더 ' + d.timings.headers + 'ms · 첫 토큰 ' + (d.timings.firstToken || '-') + 'ms · 완료 ' + d.timings.end + 'ms' + (d.totalMs ? ' · 전체 ' + d.totalMs + 'ms' : ''));
    if (d.finishReason) L.push('finish_reason: ' + d.finishReason);
    if (d.malformed) L.push('손상된 스트림 청크 무시: ' + d.malformed);
    if (d.usage) L.push('usage: ' + JSON.stringify(d.usage));
    if (d.notes && d.notes.length) L.push('notes: ' + d.notes.join(' / '));
    if (d.candidates && d.candidates.length) L.push('후보 태그: ' + d.candidates.join(', '));
    return safe(L.join('\n'));
  }

  function renderMessage(chat, m) {
    if (m.role === 'user') {
      if (S.edit && S.edit.id === m.id) return renderEditBox(chat, m);
      var imgs = m.images || [];
      var editBtn = el('button', { class: 'act', type: 'button', title: S.gen ? '생성 중에는 수정할 수 없습니다' : '메시지 수정', disabled: !!S.gen, onclick: function () { startEdit(chat, m); } }, icon('edit'), '수정');
      return el('div', { class: 'msg user', 'data-mid': m.id }, el('div', { class: 'bubble' + (imgs.length ? ' has-img' : '') },
        imgs.length ? el('div', { class: 'msg-imgs' }, imgs.map(function (im) {
          return el('button', { class: 'thumb', type: 'button', title: (im.name || '이미지') + ' · ' + im.width + '×' + im.height, onclick: function () { openLightbox(im.dataUrl); } },
            el('img', { src: im.dataUrl, alt: im.name || '첨부 이미지', loading: 'lazy' }));
        })) : null,
        m.content ? el('div', { class: 'bubble-text', text: m.content }) : null),
        el('div', { class: 'user-actions' }, editBtn));
    }

    var wrap = el('div', { class: 'msg assistant', 'data-mid': m.id });
    var last = isLastAssistant(chat, m);
    var busy = !!S.gen;

    if (m.status === 'streaming') {
      var phase = S.gen && S.gen.assistantId === m.id ? S.gen.phase : 'start';
      wrap.append(el('div', { class: 'status-line' }, el('span', { class: 'spinner' }), el('span', { class: 'phase', text: PHASE_TEXT[phase] || PHASE_TEXT.start })));
      if (m.content) wrap.append(el('div', { class: 'result' }, renderResultBody(m.content, true)));
      return wrap;
    }

    var hasContent = !!(m.content && m.content.trim());
    if (hasContent) {
      var copyBtn = el('button', { class: 'act', type: 'button', title: '전체 복사' }, icon('copy'), '복사');
      copyBtn.addEventListener('click', function () { copyText(m.content, copyBtn); });
      var regenBtn = last ? el('button', { class: 'act', type: 'button', title: '재생성', disabled: busy, onclick: function () { regenerate(chat.id, m.id); } }, icon('redo'), '재생성') : null;
      var badges = [];
      if (m.status === 'cancelled') badges.push(el('span', { class: 'badge warn', text: '취소된 응답' }));
      if (m.status === 'error') badges.push(el('span', { class: 'badge err', text: '중단됨' }));
      var label = el('span', { class: 'label', text: (m.debug && m.debug.modelName) || '' });
      wrap.append(el('div', { class: 'result' },
        el('div', { class: 'result-head' }, label, badges, copyBtn, regenBtn),
        renderResultBody(m.content, false)));

      var meta = el('div', { class: 'meta-row' });
      meta.append(el('span', { text: '≈' + fmtNum(C.estimateTokens(m.content)) + ' 토큰 (추정치)' }));
      if (m.debug && m.debug.candidateCount != null) meta.append(el('span', { text: '참조 후보 ' + m.debug.candidateCount + '개' }));
      var issues = m.issues || [];
      var infoCount = issues.filter(function (x) { return x.level === 'info'; }).length;
      var box = null;
      if (issues.length) {
        var warnCount = issues.length - infoCount;
        var showInfo = false;
        var holder = el('div');
        var toggle = el('button', { class: 'link', type: 'button', text: '검증 ' + (warnCount ? '경고 ' + warnCount : '') + (warnCount && infoCount ? ' · ' : '') + (infoCount ? '정보 ' + infoCount : '') });
        toggle.addEventListener('click', function () { showInfo = !showInfo; holder.replaceChildren(issueList(issues, showInfo) || ''); });
        meta.append(toggle);
        box = holder;
        var initial = issueList(issues, false);
        if (initial) holder.append(initial);
      }
      wrap.append(meta);
      if (box) wrap.append(box);
    }

    if (m.status === 'error' && m.error) {
      var row = el('div', { class: 'row' });
      if (last) row.append(el('button', { class: 'act', type: 'button', disabled: busy, onclick: function () { regenerate(chat.id, m.id); } }, icon('redo'), '다시 시도'));
      if (/CONFIG_ERROR|AUTH_FAILED|CORS_BLOCKED|MIXED_CONTENT|ENDPOINT_NOT_FOUND|MODEL_NOT_FOUND|NETWORK_ERROR|VISION_UNSUPPORTED/.test(m.error.code)) {
        row.append(el('button', { class: 'act', type: 'button', onclick: function () { openSettings('api'); } }, icon('gear'), '설정 열기'));
      }
      wrap.append(el('div', { class: 'err-card', role: 'alert' },
        el('div', { class: 'code', text: m.error.code + (m.error.status ? ' · HTTP ' + m.error.status : '') }),
        el('div', { class: 'text', text: m.error.message }),
        m.error.detail ? el('div', { class: 'detail', text: m.error.detail }) : null,
        row));
    } else if (m.status === 'cancelled' && !hasContent) {
      wrap.append(el('div', { class: 'meta-row' }, el('span', { text: '생성을 중지했습니다.' }),
        last ? el('button', { class: 'link', type: 'button', disabled: busy, onclick: function () { regenerate(chat.id, m.id); }, text: '재생성' }) : null));
    }

    if (S.settings.debug && m.debug) wrap.append(el('div', { class: 'debug', text: debugText(m.debug) }));
    return wrap;
  }

  function renderEmpty() {
    var s = S.settings;
    var apiOk = !!(s.api.modelId && (s.proxy.enabled ? s.proxy.url : s.api.url));
    var ref = S.engine && S.engine.state;
    var refOk = ref && ref.status === 'ready';
    var spCustom = s.systemPrompt !== C.DEFAULT_SYSTEM_PROMPT;
    function row(ok, text, tab) {
      return el('div', { class: 'setup-row ' + (ok ? 'ok' : 'todo') }, el('span', { class: 'dot' }), el('span', { text: text }),
        el('button', { class: 'act', type: 'button', onclick: function () { openSettings(tab); } }, ok ? '변경' : '설정'));
    }
    var examples = ['책상 위에 엎드려 팔을 접고 머리를 숙인 자세', '석양이 지는 해변에 누워 있는 은발 소녀', '교실 창가에서 책을 읽는 두 소녀, 비 오는 날'];
    return el('div', { class: 'empty' }, el('div', { class: 'empty-inner' },
      el('h1', { text: 'NAI Prompt Generator' }),
      el('p', { text: '원하는 장면이나 수정 사항을 자연어로 적으면 NAI 프롬프트로 만들어 드립니다. 이어서 “표정은 그대로, 복장만 바꿔줘”처럼 고칠 수 있습니다.' }),
      el('div', { class: 'setup-list' },
        row(apiOk, apiOk ? 'API: ' + (s.api.name || s.api.modelId) + (s.proxy.enabled ? ' · 프록시' : '') : 'API 연결이 필요합니다', 'api'),
        row(refOk, refOk ? '참조 CSV: ' + (S.refMeta && S.refMeta.fileName || '') + ' · ' + fmtNum(ref.stats.rows) + '행' : (ref && ref.status === 'loading' ? '참조 CSV 인덱스 준비 중...' : '참조 CSV(content.csv)를 업로드하세요 (선택)'), 'reference'),
        row(true, spCustom ? 'System Prompt: 사용자 지시사항 (' + fmtNum(s.systemPrompt.length) + '자)' : 'System Prompt: 기본 지시사항 사용 중', 'prompt')),
      el('div', { class: 'examples' }, examples.map(function (t) {
        return el('button', { class: 'chip', type: 'button', text: t, onclick: function () { var i = $('input'); i.value = t; autoGrow(); i.focus(); } });
      }))));
  }

  function nearBottom() { var m = $('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 140; }
  function scrollBottom() { var m = $('messages'); m.scrollTop = m.scrollHeight; }

  function renderThread(forceScroll) {
    var stick = forceScroll || nearBottom();
    var thread = $('thread');
    var chat = currentChat();
    renderTitle();
    if (!chat || !chat.messages.length) { thread.replaceChildren(renderEmpty()); updateComposer(); return; }
    thread.replaceChildren.apply(thread, chat.messages.map(function (m) { return renderMessage(chat, m); }));
    updateComposer();
    if (stick) scrollBottom();
  }

  // 스트리밍 중에는 해당 메시지의 본문만 갱신 (rAF 단위)
  var streamPaint = null;
  function paintStream(chat, m) {
    if (streamPaint) return;
    streamPaint = requestAnimationFrame(function () {
      streamPaint = null;
      if (chat.id !== S.currentId || m.status !== 'streaming') return;
      var node = $('thread').querySelector('[data-mid="' + m.id + '"]');
      if (!node) return;
      var stick = nearBottom();
      var res = node.querySelector('.result');
      var body = renderResultBody(m.content, true);
      if (res) res.replaceChildren(body); else node.append(el('div', { class: 'result' }, body));
      var ph = node.querySelector('.phase');
      if (ph && S.gen) ph.textContent = PHASE_TEXT[S.gen.phase] || '';
      if (stick) scrollBottom();
    });
  }

  function setPhase(chat, m, phase) {
    if (!S.gen) return;
    S.gen.phase = phase;
    if (chat.id !== S.currentId) return;
    var node = $('thread').querySelector('[data-mid="' + m.id + '"] .phase');
    if (node) node.textContent = PHASE_TEXT[phase] || '';
  }

  // ───────────────────────── 입력창 ─────────────────────────
  function autoGrow() {
    var t = $('input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 240) + 'px';
  }
  function draftKey() { return 'nai:draft:' + (S.currentId || 'new'); }
  var draftTimer = null;
  function saveDraftSoon() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraftNow, 300); }
  function saveDraftNow() { clearTimeout(draftTimer); lsSet(draftKey(), $('input').value); }
  function loadDraft() { $('input').value = lsGet(draftKey()) || ''; autoGrow(); }

  function updateComposer() {
    var btn = $('btn-send');
    var hint = $('composer-hint');
    if (S.gen) {
      btn.classList.add('stop');
      btn.disabled = false;
      btn.replaceChildren(icon('stop'));
      btn.title = '생성 중지'; btn.setAttribute('aria-label', '생성 중지');
      hint.textContent = S.gen.chatId === S.currentId ? '생성 중 · ■ 버튼으로 중지' : '다른 대화에서 생성 중입니다 · ■ 버튼으로 중지';
    } else {
      btn.classList.remove('stop');
      btn.disabled = !$('input').value.trim() && !S.attachments.length;
      btn.replaceChildren(icon('up'));
      btn.title = '전송 (Enter)'; btn.setAttribute('aria-label', '전송');
      hint.textContent = S.attachments.some(function (a) { return a.pending; }) ? '이미지 준비 중…' : 'Enter 전송 · Shift+Enter 줄바꿈 · 이미지 첨부 가능';
    }
  }

  function onSubmit(e) {
    if (e) e.preventDefault();
    if (S.gen) { S.gen.controller.abort(); return; }
    var text = $('input').value.trim();
    if (S.attachments.some(function (a) { return a.pending; })) return;
    var images = S.attachments.filter(function (a) { return a.dataUrl; }).map(function (a) {
      return { id: a.id, name: a.name, mime: a.mime, width: a.width, height: a.height, bytes: a.bytes, dataUrl: a.dataUrl };
    });
    if (!text && !images.length) return;
    $('input').value = '';
    S.attachments = [];
    renderAttachments();
    autoGrow();
    lsSet(draftKey(), '');
    send(text, images);
  }

  // ───────────────────────── 이미지 첨부 ─────────────────────────
  function loadImage(file) {
    if (window.createImageBitmap) return createImageBitmap(file).catch(function () { return loadImageEl(file); });
    return loadImageEl(file);
  }
  function loadImageEl(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve(img); setTimeout(function () { URL.revokeObjectURL(url); }, 0); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('이미지를 읽지 못했습니다.')); };
      img.src = url;
    });
  }

  // 보내기 전에 긴 변을 줄이고 JPEG로 변환 (원본은 저장하지 않음)
  function processImage(file) {
    var vs = S.settings.vision || {};
    var maxSide = Math.min(4096, Math.max(256, Number(vs.maxSide) || 1536));
    var quality = Math.min(1, Math.max(0.5, Number(vs.quality) || 0.9));
    return loadImage(file).then(function (img) {
      var w = img.width, h = img.height;
      if (!w || !h) throw new Error('이미지 크기를 알 수 없습니다.');
      var sc = Math.min(1, maxSide / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      var g = canvas.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, cw, ch);
      g.drawImage(img, 0, 0, cw, ch);
      if (img.close) img.close();
      var dataUrl = canvas.toDataURL('image/jpeg', quality);
      return { name: file.name || 'image', mime: 'image/jpeg', width: cw, height: ch, origWidth: w, origHeight: h, bytes: Math.round((dataUrl.length - 23) * 3 / 4), dataUrl: dataUrl };
    });
  }

  function addImageFiles(files) {
    var list = Array.prototype.slice.call(files || []).filter(function (f) { return f && /^image\//.test(f.type); });
    if (!list.length) return false;
    var max = Math.max(1, Number((S.settings.vision || {}).maxImages) || 4);
    var room = max - S.attachments.length;
    if (room <= 0) { alert('이미지는 메시지당 최대 ' + max + '장까지 첨부할 수 있습니다.'); return true; }
    if (list.length > room) alert('메시지당 최대 ' + max + '장까지라 ' + room + '장만 첨부합니다.');
    list.slice(0, room).forEach(function (f) {
      var a = { id: uid(), name: f.name || 'image', pending: true };
      S.attachments.push(a);
      processImage(f).then(function (r) {
        Object.assign(a, r); a.pending = false;
      }, function (e) {
        S.attachments = S.attachments.filter(function (x) { return x !== a; });
        alert('이미지를 첨부하지 못했습니다: ' + (e && e.message || e));
      }).then(function () { renderAttachments(); updateComposer(); });
    });
    renderAttachments();
    updateComposer();
    return true;
  }

  function renderAttachments() {
    var tray = $('attach-tray');
    tray.hidden = !S.attachments.length;
    tray.replaceChildren.apply(tray, S.attachments.map(function (a) {
      var rm = el('button', { class: 'att-x', type: 'button', title: '첨부 제거', 'aria-label': (a.name || '이미지') + ' 첨부 제거', onclick: function () {
        S.attachments = S.attachments.filter(function (x) { return x !== a; }); renderAttachments(); updateComposer(); $('input').focus();
      } }, icon('x'));
      return el('div', { class: 'att' + (a.pending ? ' pending' : ''), title: a.pending ? '처리 중…' : a.name + ' · ' + a.width + '×' + a.height + ' · ' + fmtBytes(a.bytes) },
        a.pending ? el('span', { class: 'spinner' }) : el('img', { src: a.dataUrl, alt: a.name }), rm);
    }));
  }

  function openLightbox(src) {
    var d = $('lightbox');
    d.querySelector('img').src = src;
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }

  // ───────────────────────── 생성 파이프라인 ─────────────────────────
  function send(text, images) {
    images = images || [];
    var chat = currentChat();
    var now = Date.now();
    if (!chat) {
      chat = { id: uid(), title: C.makeTitle(text, images.length), createdAt: now, updatedAt: now, messages: [], lastFinalPrompt: '', lastFinalPromptMsgId: null };
      S.chats.set(chat.id, chat);
      S.currentId = chat.id;
      lsSet('nai:current', chat.id);
      lsSet('nai:draft:new', '');
    }
    var userMsg = { id: uid(), role: 'user', content: text, createdAt: now };
    if (images.length) userMsg.images = images;
    chat.messages.push(userMsg);
    chat.updatedAt = now;
    var asst = { id: uid(), role: 'assistant', content: '', status: 'streaming', replyTo: userMsg.id, createdAt: now };
    chat.messages.push(asst);
    renderChatList();
    renderThread(true);
    return generate(chat, userMsg, asst);
  }

  function regenerate(chatId, assistantId) {
    if (S.gen) return;
    var chat = S.chats.get(chatId);
    if (!chat) return;
    var i = chat.messages.findIndex(function (m) { return m.id === assistantId; });
    if (i < 0) return;
    var old = chat.messages[i];
    var userMsg = null;
    for (var j = i - 1; j >= 0; j--) if (chat.messages[j].role === 'user') { userMsg = chat.messages[j]; break; }
    if (!userMsg) return;
    var asst = { id: uid(), role: 'assistant', content: '', status: 'streaming', replyTo: userMsg.id, createdAt: Date.now(), regenOf: old.id };
    chat.messages.splice(i, 1, asst);
    if (chat.lastFinalPromptMsgId === old.id) { chat.lastFinalPrompt = ''; chat.lastFinalPromptMsgId = null; recomputeLastFinal(chat); }
    chat.updatedAt = Date.now();
    renderChatList();
    renderThread(true);
    generate(chat, userMsg, asst, old.debug && old.debug.keywordsRaw);
  }

  function recomputeLastFinal(chat) {
    for (var i = chat.messages.length - 1; i >= 0; i--) {
      var m = chat.messages[i];
      if (m.role === 'assistant' && m.status === 'done' && m.content && m.content.trim()) {
        chat.lastFinalPrompt = m.content; chat.lastFinalPromptMsgId = m.id; return;
      }
    }
    chat.lastFinalPrompt = ''; chat.lastFinalPromptMsgId = null;
  }

  var FATAL_FOR_MAIN = { CONFIG_ERROR: 1, AUTH_FAILED: 1, CORS_BLOCKED: 1, NETWORK_ERROR: 1, MIXED_CONTENT: 1, ENDPOINT_NOT_FOUND: 1, MODEL_NOT_FOUND: 1, VISION_UNSUPPORTED: 1 };

  function planKeywords(input, ctx, signal, dbg, images) {
    var pl = S.settings.planner;
    if (!pl.enabled) { dbg.planner = '꺼짐'; return Promise.resolve([]); }
    var model = String(pl.modelId || '').trim() || S.settings.api.modelId;
    var vision = S.settings.vision || {};
    var imgs = vision.plannerImages ? (images || []) : [];
    var key = C.hashString(model + '\u0001' + input + '\u0001' + (ctx.previousPrompt || '') + '\u0001' + imgs.map(function (i) { return i.id; }).join(','));
    if (S.plannerCache.has(key)) { dbg.planner = '캐시 사용'; return Promise.resolve(S.plannerCache.get(key)); }
    var t0 = Date.now();
    function call(withImages) {
      return C.callChat({
        settings: S.settings, messages: C.buildPlannerMessages(input, ctx, withImages, vision), stream: false,
        maxTokens: Number(pl.maxTokens) || 600, modelId: model, signal: signal, pageProtocol: location.protocol
      });
    }
    return call(imgs).catch(function (e) {
      // Planner 모델만 비전 미지원이면 텍스트만으로 다시 시도
      if (e.code === 'VISION_UNSUPPORTED' && imgs.length && model !== S.settings.api.modelId) { dbg.plannerNote = 'Planner 모델 비전 미지원 → 텍스트만 사용'; return call([]); }
      throw e;
    }).then(function (r) {
      var parsed = C.parsePlannerOutput(r.text);
      dbg.planner = (parsed.ok ? 'JSON ' : (r.text.trim() ? 'JSON 아님(복구) ' : '빈 응답 ')) + parsed.keywords.length + '개 · ' + (Date.now() - t0) + 'ms';
      if (parsed.keywords.length) {
        S.plannerCache.set(key, parsed.keywords);
        if (S.plannerCache.size > 200) S.plannerCache.delete(S.plannerCache.keys().next().value);
      }
      return parsed.keywords;
    }, function (e) {
      if (e.code === 'CANCELLED') throw e;
      if (FATAL_FOR_MAIN[e.code] && model === S.settings.api.modelId) throw e;
      dbg.planner = '실패 (' + e.code + ') — 입력 표현만으로 검색';
      return [];
    });
  }

  function generate(chat, userMsg, asst, cachedKeywords) {
    var controller = new AbortController();
    S.gen = { chatId: chat.id, assistantId: asst.id, controller: controller, phase: 'start' };
    updateComposer();
    renderChatList();
    var settings = S.settings;
    var t0 = Date.now();
    var dbg = { model: settings.api.modelId, modelName: settings.api.name || settings.api.modelId };
    asst.debug = dbg;

    var idx = chat.messages.indexOf(userMsg);
    var history = chat.messages.slice(0, idx);
    var input = userMsg.content;
    var images = userMsg.images || [];
    if (images.length) dbg.images = images.length + '장 · ' + fmtBytes(images.reduce(function (a, i) { return a + (i.bytes || 0); }, 0)) + ' · ' + images.map(function (i) { return i.width + '×' + i.height; }).join(', ');
    var pre = C.assembleContext({ history: history, input: input, context: settings.context });

    var job = Promise.resolve().then(function () {
      var target = C.resolveTarget(settings, {});
      if (target.error) throw target.error;
      if (!String(settings.api.modelId || '').trim()) throw C.mkErr('CONFIG_ERROR', '모델 ID가 비어 있습니다. 설정 > API / 프록시에서 입력하세요.');

      // Stage A — Query Planner
      setPhase(chat, asst, 'plan');
      if (cachedKeywords && cachedKeywords.length) { dbg.planner = '이전 턴 키워드 재사용'; return cachedKeywords; }
      var refReady = S.engine.state.status === 'ready' || S.engine.state.status === 'loading';
      if (!refReady) { dbg.planner = '참조 CSV 없음 — 건너뜀'; return []; }
      return planKeywords(input, { previousPrompt: pre.previousPrompt, recentRequests: pre.recentRequests }, controller.signal, dbg, images);
    }).then(function (planned) {
      if (controller.signal.aborted) throw C.mkErr('CANCELLED');
      dbg.keywordsRaw = planned;
      var terms = settings.retrieval.includeInputTerms ? C.extractInputTerms(input) : [];
      var keywords = C.cleanKeywords(terms.concat(planned), 60);
      dbg.keywords = keywords;
      // Stage B — 로컬 CSV 검색
      if (S.engine.state.status === 'loading') setPhase(chat, asst, 'index');
      return S.engine.whenSettled().then(function () {
        if (S.engine.state.status !== 'ready' || !keywords.length) return [];
        setPhase(chat, asst, 'search');
        var ts = Date.now();
        return S.engine.searchMany(keywords, {
          perKeyword: Math.max(1, Number(settings.retrieval.perKeyword) || 10),
          maxTotal: Math.max(10, Number(settings.retrieval.maxTotal) || 150)
        }).then(function (r) { dbg.searchMs = Date.now() - ts; return r || []; }, function () { dbg.notes = ['CSV 검색 실패 — 후보 없이 생성']; return []; });
      });
    }).then(function (cands) {
      if (controller.signal.aborted) throw C.mkErr('CANCELLED');
      dbg.candidateCount = cands.length;
      dbg.candidates = cands.map(function (c) { return c.tag; });
      // Stage C — 최종 생성
      var ctx = C.assembleContext({
        systemPrompt: settings.systemPrompt,
        referenceBlock: C.formatReferenceBlock(cands),
        history: history, input: input, images: images, vision: settings.vision, context: settings.context
      });
      dbg.sentImages = ctx.imageCount;
      dbg.context = '대화 ' + ctx.includedTurns + '턴 포함' + (ctx.droppedTurns ? ' · ' + ctx.droppedTurns + '턴 생략' : '') + (ctx.previousPrompt ? ' · 직전 완성 프롬프트 포함' : '');
      setPhase(chat, asst, 'generate');
      return C.callChat({
        settings: settings, messages: ctx.messages, signal: controller.signal, pageProtocol: location.protocol,
        onDelta: function (_, full) { asst.content = full; paintStream(chat, asst); }
      });
    }).then(function (r) {
      asst.content = r.text;
      copyResultDebug(dbg, r);
      var finish = function (issues) {
        asst.issues = issues;
        var fatal = issues.some(function (x) { return x.level === 'error'; });
        if (!r.text.trim()) {
          asst.status = 'error';
          asst.error = { code: 'EMPTY_RESPONSE', message: C.ERROR_TEXT.EMPTY_RESPONSE, detail: r.finishReason === 'length' ? 'finish_reason=length — 출력 토큰 한도에 걸렸습니다. reasoning 모델이면 최대 출력 토큰을 늘리세요.' : (r.reasoning ? '모델이 reasoning만 반환했습니다.' : '') };
        } else {
          asst.status = 'done';
          if (!fatal) { chat.lastFinalPrompt = asst.content; chat.lastFinalPromptMsgId = asst.id; }
        }
      };
      if (!settings.validation.enabled) return finish(r.text.trim() ? [] : [{ level: 'error', code: 'EMPTY_RESPONSE', message: '빈 응답입니다.' }]);
      setPhase(chat, asst, 'validate');
      var ex = C.extractTagsFromOutput(r.text);
      var lk = S.engine.state.status === 'ready' && ex.tags.length ? S.engine.lookup(ex.tags.slice(0, 400)).catch(function () { return null; }) : Promise.resolve(null);
      return lk.then(function (lookupResults) {
        finish(C.validateOutput(r.text, { lookupResults: lookupResults, tokenLimit: Number(settings.validation.tokenLimit) || 0 }));
      });
    }).catch(function (e) {
      if (e && e.result) copyResultDebug(dbg, e.result);
      var partial = e && e.partial || asst.content || '';
      if (e && e.code === 'CANCELLED') {
        asst.status = 'cancelled';
        asst.content = settings.generation.keepPartialOnCancel ? partial : '';
      } else {
        asst.status = 'error';
        asst.content = partial;
        var code = e && e.code || 'NETWORK_ERROR';
        asst.error = {
          code: code,
          status: e && e.status || null,
          message: e && e.message || C.ERROR_TEXT[code] || '알 수 없는 오류',
          detail: safe(e && e.detail || '')
        };
      }
    }).then(function () {
      dbg.totalMs = Date.now() - t0;
      chat.updatedAt = Date.now();
      S.gen = null;
      saveChat(chat);
      renderChatList();
      if (chat.id === S.currentId) renderThread(); else updateComposer();
    });
    return job;
  }

  function copyResultDebug(dbg, r) {
    dbg.endpointKind = r.endpointKind;
    dbg.hostKind = r.hostKind;
    dbg.credentialLabel = r.credentialLabel;
    dbg.timings = r.timings;
    dbg.finishReason = r.finishReason;
    dbg.malformed = r.malformed;
    dbg.usage = r.usage;
    dbg.requestBodyKeys = r.requestBodyKeys;
    if (r.notes && r.notes.length) dbg.notes = (dbg.notes || []).concat(r.notes);
  }

  // ───────────────────────── 참조 CSV ─────────────────────────
  var CAT_LABELS = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' };

  function refStatusText() {
    var st = S.engine.state;
    if (st.status === 'loading') return '참조 CSV: 인덱스 준비 중…';
    if (st.status === 'ready') return '참조 CSV: ' + (S.refMeta && S.refMeta.fileName || '') + ' · ' + fmtNum(st.stats.rows) + '행';
    if (st.status === 'error') return '참조 CSV: 오류 — 설정에서 확인';
    return '참조 CSV: 없음';
  }

  function renderRefStatus() {
    $('ref-status').textContent = refStatusText();
    if (!$('settings').open) { if (!currentChat() || !currentChat().messages.length) renderThread(); return; }
    var st = S.engine.state, meta = S.refMeta;
    var dl = $('ref-meta');
    var rows = [];
    function add(k, v) { rows.push(el('dt', { text: k }), el('dd', { text: v })); }
    if (!meta) add('상태', '참조 파일 없음');
    else {
      add('파일명', meta.fileName || '-');
      add('파일 크기', fmtBytes(meta.size));
      add('상태', st.status === 'ready' ? '검색 준비 완료' + (st.mode === 'main' ? ' (메인 스레드)' : '') : st.status === 'loading' ? '인덱스 생성 중…' : st.status === 'error' ? '오류: ' + (st.error && st.error.message || '') : '대기');
      if (st.stats) {
        add('행 수', fmtNum(st.stats.rows) + '행');
        add('alias 수', fmtNum(st.stats.aliases));
        var cats = st.stats.categories || {};
        add('카테고리', Object.keys(cats).map(function (c) { return (CAT_LABELS[c] || 'cat ' + c) + ' ' + fmtNum(cats[c]); }).join(' · '));
        if (st.stats.skipped) add('건너뛴 행', fmtNum(st.stats.skipped));
        if (st.stats.replacementChars) add('인코딩 경고', 'UTF-8로 읽을 수 없는 문자 ' + fmtNum(st.stats.replacementChars) + '개 이상');
        add('인덱스 시간', fmtNum(st.stats.buildMs) + 'ms');
      }
      add('마지막 로드', meta.loadedAt ? fmtDate(meta.loadedAt) : '-');
    }
    dl.replaceChildren.apply(dl, rows);
    $('ref-progress').hidden = st.status !== 'loading';
    $('ref-remove').disabled = !meta;
    $('ref-rebuild').disabled = !meta || st.status === 'loading';
  }

  function onRefProgress(stage, p) {
    var w = stage === 'parse' ? p * 45 : stage === 'index' ? 45 + p * 45 : stage === 'sort' ? 92 : 100;
    var bar = $('ref-progress').firstElementChild;
    if (bar) bar.style.width = Math.round(w) + '%';
    $('ref-status').textContent = '참조 CSV: 인덱스 준비 중… ' + Math.round(w) + '%';
  }

  function loadReferenceBlob(blob, meta) {
    S.refMeta = meta;
    var p = S.engine.load(blob);
    renderRefStatus();
    return p.then(function (stats) {
      meta.rows = stats.rows;
      renderRefStatus();
      return stats;
    }, function (e) {
      renderRefStatus();
      throw e;
    });
  }

  function uploadReference(file) {
    if (!file) return;
    if (S.engine.state.status === 'loading') { alert('인덱스를 만드는 중입니다. 끝난 뒤 다시 시도하세요.'); return; }
    var prev = S.refMeta;
    var meta = { fileName: file.name, size: file.size, loadedAt: Date.now() };
    loadReferenceBlob(file, meta).then(function () {
      return S.store.put('reference', { meta: meta, blob: file }, 'main').catch(function () {
        return file.text().then(function (t) { return S.store.put('reference', { meta: meta, text: t }, 'main'); });
      }).catch(function () { banner('참조 CSV를 브라우저에 저장하지 못했습니다. 새로고침하면 다시 업로드해야 합니다.'); });
    }, function (e) {
      alert('REFERENCE_FILE_PARSE_ERROR\n' + C.ERROR_TEXT.REFERENCE_FILE_PARSE_ERROR + '\n' + (e.message || ''));
      // 이전 파일 복원
      S.store.get('reference', 'main').then(function (rec) {
        if (rec && prev) loadReferenceBlob(rec.blob || new Blob([rec.text || '']), prev).catch(function () {});
        else { S.refMeta = null; S.engine.unload().then(renderRefStatus); }
      });
    });
  }

  function rebuildReference() {
    S.store.get('reference', 'main').then(function (rec) {
      if (!rec) return;
      rec.meta.loadedAt = Date.now();
      return loadReferenceBlob(rec.blob || new Blob([rec.text || '']), rec.meta).then(function () { return S.store.put('reference', rec, 'main'); });
    }).catch(function (e) { alert('인덱스를 다시 만들지 못했습니다: ' + (e && e.message || e)); });
  }

  function removeReference() {
    if (!S.refMeta) return;
    if (!confirm('참조 CSV를 제거할까요? 이후 생성은 태그 후보 없이 진행됩니다.')) return;
    S.refMeta = null;
    S.store.del('reference', 'main');
    S.engine.unload().then(renderRefStatus);
  }

  function runSearchTest() {
    var q = $('ref-test-q').value.trim();
    var out = $('ref-test-out');
    if (!q) return;
    if (S.engine.state.status !== 'ready') { out.replaceChildren(el('p', { class: 'hint', text: '참조 CSV가 준비되지 않았습니다.' })); return; }
    var t0 = performance.now();
    var multi = q.indexOf(',') !== -1;
    var p = multi ? S.engine.searchMany(q.split(','), { perKeyword: 8, maxTotal: 60 }) : S.engine.search(q, { limit: 20 });
    p.then(function (rows) {
      var ms = Math.round(performance.now() - t0);
      var VIA = { exact: '정확', alias: 'alias', prefix: '접두', 'alias-prefix': 'alias 접두', token: '단어', substring: '부분', fuzzy: '유사' };
      out.replaceChildren(
        el('p', { class: 'hint', text: (rows || []).length + '개 · ' + ms + 'ms' }),
        el('table', { class: 'res' },
          el('thead', null, el('tr', null, ['태그', 'cat', 'count', '매칭', 'alias', '점수'].map(function (h) { return el('th', { text: h }); }))),
          el('tbody', null, (rows || []).map(function (r) {
            return el('tr', null,
              el('td', { class: 'mono', text: r.tag }), el('td', { text: r.category + ' ' + r.categoryLabel }),
              el('td', { text: fmtNum(r.count) }), el('td', { text: VIA[r.via] || r.via }),
              el('td', { class: 'mono', text: r.alias || '' }), el('td', { text: String(r.score) }));
          }))));
    });
  }

  // ───────────────────────── 설정 모달 ─────────────────────────
  function bindFields() { return Array.prototype.slice.call(document.querySelectorAll('#settings [data-bind]')); }

  function fillForm(s) {
    bindFields().forEach(function (f) {
      var v = getPath(s, f.dataset.bind);
      if (f.type === 'checkbox') f.checked = !!v;
      else f.value = v == null ? '' : String(v);
    });
    document.querySelectorAll('#settings [data-reveal]').forEach(function (b) { var t = $(b.dataset.reveal); if (t) t.type = 'password'; });
  }

  function readForm() {
    var s = C.clone(S.draft || S.settings);
    bindFields().forEach(function (f) {
      var p = f.dataset.bind, v;
      if (f.type === 'checkbox') v = f.checked;
      else if (f.type === 'number') { v = f.value === '' ? getPath(C.DEFAULT_SETTINGS, p) : Number(f.value); }
      else v = f.value;
      setPath(s, p, v);
    });
    s.api.url = String(s.api.url || '').trim();
    s.api.modelId = String(s.api.modelId || '').trim();
    s.proxy.url = String(s.proxy.url || '').trim();
    return s;
  }

  function setDirty(v) { S.dirty = v; $('set-dirty').textContent = v ? '저장되지 않은 변경 사항' : ''; }

  function selectTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.set-tab').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'); });
    document.querySelectorAll('.set-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.panel === tab); });
  }

  function openSettings(tab) {
    S.draft = C.clone(S.settings);
    fillForm(S.draft);
    setDirty(false);
    selectTab(tab || S.tab || 'prompt');
    updateSpCount();
    updateApiPreview();
    renderRefStatus();
    $('sp-lint').replaceChildren();
    var d = $('settings');
    if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  }

  function closeSettings(force) {
    if (!force && S.dirty && !confirm('저장하지 않은 변경 사항을 버릴까요?')) return;
    var d = $('settings');
    if (d.close) d.close(); else d.removeAttribute('open');
    S.draft = null;
    setDirty(false);
    renderThread();
  }

  function saveSettingsFromForm() {
    var s = readForm();
    var g = s.generation;
    g.maxTokens = Math.max(1, Math.floor(g.maxTokens) || 2048);
    g.timeoutSec = Math.min(1800, Math.max(5, Math.floor(g.timeoutSec) || 120));
    g.thinkingBudget = Math.max(0, Math.floor(g.thinkingBudget) || 0);
    if (g.temperature !== '' && !isFinite(Number(g.temperature))) { alert('Temperature는 숫자이거나 비워 두어야 합니다.'); return; }
    if (g.extraBody && g.extraBody.trim()) { var eb = C.parseExtraBody(g.extraBody); if (eb.error) { alert('추가 body JSON 오류: ' + eb.error); selectTab('advanced'); return; } }
    s.retrieval.perKeyword = Math.min(50, Math.max(1, Math.floor(s.retrieval.perKeyword) || 10));
    s.retrieval.maxTotal = Math.min(500, Math.max(10, Math.floor(s.retrieval.maxTotal) || 150));
    s.planner.maxTokens = Math.max(64, Math.floor(s.planner.maxTokens) || 600);
    s.vision.maxSide = Math.min(4096, Math.max(256, Math.floor(s.vision.maxSide) || 1536));
    s.vision.maxImages = Math.min(10, Math.max(1, Math.floor(s.vision.maxImages) || 4));
    s.context.maxTurns = Math.max(1, Math.floor(s.context.maxTurns) || 12);
    s.context.charBudget = Math.max(1000, Math.floor(s.context.charBudget) || 24000);
    S.settings = s;
    saveSettings().then(function () { closeSettings(true); }, function () { alert('설정을 저장하지 못했습니다.'); });
  }

  function updateSpCount() {
    var v = $('sp-text').value;
    $('sp-count').textContent = fmtNum(Array.from(v).length) + '자 · ' + fmtNum(v.split('\n').length) + '줄' + (v === C.DEFAULT_SYSTEM_PROMPT ? ' · 기본값' : '');
  }

  function updateApiPreview() {
    var s = readForm();
    var resolved = C.resolveApiUrl(s.api.url, s.api.mode);
    var kind = C.hostKind(resolved);
    var KIND = { loopback: '로컬(이 컴퓨터) — API 키 없이 사용 가능', private: '로컬망 — API 키 없이 사용 가능', remote: '원격 서버', invalid: 'URL 형식 오류' };
    var pv = $('url-preview');
    pv.textContent = s.api.url ? (resolved !== s.api.url ? '실제 호출 주소: ' + resolved + ' · ' : '') + (KIND[kind] || '') : '';

    var t = C.resolveTarget(s, { stream: s.generation.stream });
    var KINDS = { proxy: '프록시 경유', local: '로컬 엔드포인트 직접', direct: '원격 API 직접' };
    var box = $('cred-summary');
    var lines = [];
    function line(k, v) { lines.push(el('div', null, el('b', { text: k + ': ' }), v)); }
    line('호출 대상', (t.url || '(없음)') + (t.endpointKind ? ' — ' + KINDS[t.endpointKind] : ''));
    line('인증', t.error ? '⚠ ' + t.error.message : (t.credentialLabel || '없음'));
    line('body.model', s.api.modelId || '(비어 있음)');
    if (s.proxy.enabled) line('원본 API URL', t.apiUrl ? t.apiUrl + ' (X-Lumos-Upstream-Url 헤더로 전달, 설정 보존)' : '(비어 있음)');
    if (s.proxy.enabled && s.api.apiKey && !s.proxy.forwardApiKey) line('원본 API 키', '전송하지 않음');
    box.replaceChildren.apply(box, lines);
  }

  // ───────────────────────── 진단 ─────────────────────────
  var diagBusy = false;
  function diagStart(title) {
    selectTab('advanced');
    var out = $('diag-out');
    out.replaceChildren(el('div', { class: 'diag-title', text: title }));
    ['btn-conn-test', 'btn-reco', 'btn-diag'].forEach(function (id) { $(id).disabled = true; });
    diagBusy = true;
    var spin = el('div', { class: 'status-line' }, el('span', { class: 'spinner' }), el('span', { text: '진행 중…' }));
    out.append(spin);
    return {
      step: function (state, text, note) {
        var SYM = { ok: '✓', fail: '✕', error: '✕', warn: '!', info: '○' };
        out.insertBefore(el('div', { class: 'diag-step ' + state }, el('span', { class: 'sym', text: SYM[state] || '·' }),
          el('div', null, el('div', { text: safe(text) }), note ? el('div', { class: 'note', text: safe(note) }) : null)), spin);
      },
      node: function (n) { out.insertBefore(n, spin); },
      end: function () {
        spin.remove(); diagBusy = false;
        ['btn-conn-test', 'btn-reco', 'btn-diag'].forEach(function (id) { $(id).disabled = false; });
      }
    };
  }

  function ping(s, opts) {
    return C.callChat(Object.assign({
      settings: s, messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      stream: false, maxTokens: 32, timeoutMs: 30000, pageProtocol: location.protocol
    }, opts || {}));
  }

  function errLine(e) { return (e.code || 'ERROR') + (e.status ? ' (HTTP ' + e.status + ')' : '') + ' — ' + e.message.replace(/\n/g, ' ') + (e.detail ? ' · ' + e.detail : ''); }

  function connectionTest() {
    if (diagBusy) return;
    var s = readForm();
    s.generation.streamFallback = false;
    var d = diagStart('연결 테스트');
    var target = C.resolveTarget(s, {});
    if (target.error) { d.step('fail', 'URL / 설정 검사 실패', target.error.message); d.end(); return; }
    var KINDS = { proxy: '프록시', local: '로컬 엔드포인트', direct: '원격 API 직접' };
    d.step('ok', 'URL 형식 확인: ' + target.url, KINDS[target.endpointKind] + ' · 인증: ' + (target.credentialLabel || '없음'));
    if (location.protocol === 'https:' && /^http:/i.test(target.url) && target.hostKind !== 'loopback') {
      d.step('fail', '혼합 콘텐츠: HTTPS 페이지에서 HTTP 주소는 차단됩니다', 'HTTPS 엔드포인트 또는 프록시를 쓰거나, 앱을 http://로 여세요.');
      d.end(); return;
    }
    ping(s).then(function (r) {
      d.step('ok', '서버 연결 성공 (HTTP ' + (r.status || 200) + ', ' + r.timings.end + 'ms)', 'CORS 통과');
      d.step(r.text.trim() ? 'ok' : 'warn', r.text.trim() ? '모델 확인: ' + s.api.modelId + ' 응답 수신' : '모델 응답 본문이 비어 있음', r.text.trim() ? null : (r.finishReason === 'length' ? 'reasoning 모델이 짧은 토큰 한도 안에 답을 내지 못했을 수 있습니다.' : null));
      if (target.credential === 'none') d.step('info', target.endpointKind === 'proxy' ? '프록시 토큰 없이 호출 — 프록시가 인증 없이 허용함' : 'API Key 없음 — ' + (target.endpointKind === 'local' ? '로컬 엔드포인트로 정상 처리' : '키 없이 허용되는 서버'));
      else d.step('ok', (target.credential === 'proxy-token' ? '프록시 토큰' : 'API 키') + ' 인증 통과');
      // 스트리밍
      return C.callChat({ settings: s, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], stream: true, maxTokens: 32, timeoutMs: 30000, pageProtocol: location.protocol })
        .then(function (r2) {
          if (r2.streamed) d.step('ok', '스트리밍 지원 (SSE' + (r2.malformed ? ', 손상 청크 ' + r2.malformed + '개 무시' : '') + ')');
          else d.step('warn', '서버가 스트리밍 대신 일반 JSON 응답을 반환했습니다', '출력은 정상 표시되지만 실시간으로 보이지 않습니다.');
        }, function (e) {
          d.step('fail', '스트리밍 요청 실패', errLine(e) + ' — 고급 설정에서 스트리밍을 끄거나 "스트리밍 실패 시 재시도"를 켜세요.');
        })
        .then(function () { return checkModelList(s, target, d); });
    }, function (e) {
      if (e.code === 'CORS_BLOCKED') {
        d.step('fail', '브라우저 직접 호출이 CORS로 차단됨', '서버는 응답하지만 브라우저가 결과를 막았습니다. 인증 오류가 아닙니다.\n→ 프록시 사용 권장 (또는 로컬 서버의 CORS 허용 설정을 켜세요. LM Studio: Enable CORS, Ollama: OLLAMA_ORIGINS)');
      } else if (e.code === 'NETWORK_ERROR' || e.code === 'MIXED_CONTENT' || e.code === 'TIMEOUT') {
        d.step('fail', '서버 연결 실패: ' + e.code, e.message);
      } else {
        d.step('ok', '서버 연결 성공 (HTTP ' + e.status + ')', 'CORS 통과');
        if (e.code === 'AUTH_FAILED') d.step('fail', '인증 실패 (' + e.status + ')', (target.credential === 'proxy-token' ? '프록시 토큰' : target.credential === 'api-key' ? 'API 키' : '인증 정보 없음 — 이 서버는 인증이 필요합니다') + (e.detail ? ' · ' + e.detail : ''));
        else if (e.code === 'MODEL_NOT_FOUND') d.step('fail', '모델 접근 실패: ' + s.api.modelId, e.detail);
        else if (e.code === 'ENDPOINT_NOT_FOUND') d.step('fail', '엔드포인트 없음 (404)', 'API URL 경로를 확인하세요. ' + (e.detail || ''));
        else if (e.code === 'RATE_LIMITED') d.step('warn', '요청 한도 초과 (429)', '연결과 인증은 된 것으로 보입니다.');
        else d.step('fail', errLine(e));
      }
    }).then(function () { d.end(); });
  }

  function checkModelList(s, target, d) {
    if (target.endpointKind === 'proxy') return Promise.resolve();
    var url = C.modelsUrlFrom(target.url);
    if (!url) return Promise.resolve();
    var h = {};
    if (target.headers.Authorization) h.Authorization = target.headers.Authorization;
    var ctrl = new AbortController();
    var tm = setTimeout(function () { ctrl.abort(); }, 10000);
    return fetch(url, { headers: h, signal: ctrl.signal }).then(function (res) {
      if (!res.ok) return;
      return res.json().then(function (j) {
        var ids = (j && (j.data || j.models) || []).map(function (m) { return m.id || m.name; }).filter(Boolean);
        if (!ids.length) return;
        if (ids.indexOf(s.api.modelId) !== -1) d.step('ok', '모델 목록(/models)에서 ' + s.api.modelId + ' 확인');
        else d.step('info', '모델 목록에 정확히 같은 ID가 없습니다', '사용 가능 예: ' + ids.slice(0, 8).join(', ') + (ids.length > 8 ? ' …' : ''));
      });
    }).catch(function () {}).then(function () { clearTimeout(tm); });
  }

  function recommendedCheck() {
    if (diagBusy) return;
    var s = readForm();
    var d = diagStart('권장 설정 점검');
    C.checkRecommended(s, { pageProtocol: location.protocol, referenceLoaded: S.engine.state.status === 'ready' }).forEach(function (x) {
      d.step(x.level === 'error' ? 'fail' : x.level, x.message);
    });
    C.lintSystemPrompt(s.systemPrompt).forEach(function (x) { d.step(x.level, '지시사항: ' + x.message); });
    d.end();
  }

  function modelDiagnosis() {
    if (diagBusy) return;
    var s = readForm();
    var t = C.resolveTarget(s, {});
    if (t.error) { var d0 = diagStart('모델 진단'); d0.step('fail', t.error.message); d0.end(); return; }
    if (!confirm('실제 API를 8~9회 짧게 호출해 호환성을 확인합니다. 계속할까요?')) return;
    var d = diagStart('모델 진단');
    var base = C.clone(s);
    var g = base.generation;
    g.useMaxTokens = false; g.reasoningEffort = ''; g.thinkingLevel = ''; g.thinkingBudget = 0; g.streamFallback = false;
    g.hasFirstSystemPrompt = true; g.systemAsUser = false;
    var rec = {};
    var sysMsgs = [{ role: 'system', content: 'You are a test assistant. Reply with the single word OK.' }, { role: 'user', content: 'ping' }];
    function tryCall(label, opts) {
      return C.callChat(Object.assign({ settings: base, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], stream: false, timeoutMs: 30000, pageProtocol: location.protocol }, opts))
        .then(function (r) { return { ok: true, r: r }; }, function (e) { return { ok: false, e: e }; });
    }
    var tokenParams = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'];
    var auto = C.autoTokenParam(s.api.modelId);
    var tokenOk = {};

    tryCall('base', {}).then(function (b) {
      if (!b.ok) { d.step('fail', '기본 요청 실패 — 진단 중단', errLine(b.e)); return; }
      d.step('ok', '기본 요청 성공');
      return tryCall('system', { messages: sysMsgs }).then(function (x) {
        if (x.ok) d.step('ok', 'system role 허용');
        else if (x.e.code === 'BAD_REQUEST') { d.step('fail', 'system role 거부 (' + x.e.status + ')', x.e.detail); rec.systemAsUser = true; }
        else d.step('warn', 'system role 확인 불가', errLine(x.e));
      }).then(function () {
        return tryCall('stream', { stream: true }).then(function (x) {
          if (x.ok && x.r.streamed) { d.step('ok', 'streaming 지원'); rec.stream = true; }
          else if (x.ok) { d.step('warn', 'stream 요청에 일반 JSON 응답'); }
          else { d.step('fail', 'streaming 실패', errLine(x.e)); rec.stream = false; }
        });
      }).then(function () {
        return tokenParams.reduce(function (p, param) {
          return p.then(function () {
            var ov = {}; ov[param] = 64;
            return tryCall(param, { overrides: ov }).then(function (x) {
              tokenOk[param] = x.ok;
              d.step(x.ok ? 'ok' : 'fail', param + (x.ok ? ' 허용' : ' 거부'), x.ok ? null : errLine(x.e));
            });
          });
        }, Promise.resolve());
      }).then(function () {
        if (tokenOk[auto]) rec.tokenParam = 'auto';
        else { var first = tokenParams.filter(function (p) { return tokenOk[p]; })[0]; rec.tokenParam = first || 'none'; }
        return tryCall('reasoning', { overrides: { reasoning_effort: 'low' } }).then(function (x) {
          d.step(x.ok ? 'ok' : 'info', 'reasoning_effort 필드 ' + (x.ok ? '허용' : '거부 — Reasoning Effort를 비워 두세요'), x.ok ? null : errLine(x.e));
          rec.reasoningSupported = x.ok;
        });
      }).then(function () {
        // 이미지 입력: 빨간 단색 이미지를 보내 색을 맞히는지 확인
        var cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
        var cg = cv.getContext('2d'); cg.fillStyle = '#e01010'; cg.fillRect(0, 0, 64, 64);
        var content = C.buildUserContent('What is the main color of this image? Answer with one English word.', [{ dataUrl: cv.toDataURL('image/png') }], s.vision);
        return tryCall('vision', { messages: [{ role: 'user', content: content }], maxTokens: undefined }).then(function (x) {
          if (x.ok && /red/i.test(x.r.text)) d.step('ok', '이미지 입력(비전) 지원 — 색상 인식 확인');
          else if (x.ok) d.step('warn', '이미지 입력은 받지만 내용을 인식하지 못한 것 같습니다', '응답: ' + (x.r.text || '(비어 있음)').slice(0, 80) + ' — 서버가 이미지를 무시했을 수 있습니다.');
          else d.step('info', '이미지 입력 미지원 — 이미지 분석에는 비전 모델이 필요합니다', errLine(x.e));
        });
      }).then(function () {
        if (t.endpointKind === 'proxy' || !String(s.api.apiKey || '').trim()) {
          d.step('info', '빈 API key 허용 여부: ' + (t.endpointKind === 'proxy' ? '프록시 사용 중이라 건너뜀' : '이미 키 없이 동작 중'));
          return;
        }
        var nk = C.clone(base); nk.api.apiKey = ''; nk.api.allowNoKey = true;
        return C.callChat({ settings: nk, messages: [{ role: 'user', content: 'ping' }], stream: false, timeoutMs: 20000, pageProtocol: location.protocol })
          .then(function () { d.step('info', '빈 API key 허용 — 이 서버는 키 없이도 응답합니다'); }, function (e) {
            d.step('ok', '빈 API key 거부 — 키가 필요한 서버입니다', e.code === 'AUTH_FAILED' ? null : errLine(e));
          });
      }).then(function () {
        var patch = {};
        if (rec.systemAsUser && !s.generation.systemAsUser) patch.systemAsUser = true;
        if (rec.stream === false && s.generation.stream) patch.stream = false;
        if (rec.tokenParam && rec.tokenParam !== s.generation.tokenParam && !(rec.tokenParam === 'auto' && tokenOk[s.generation.tokenParam])) patch.tokenParam = rec.tokenParam;
        if (rec.reasoningSupported === false && s.generation.reasoningEffort) patch.reasoningEffort = '';
        var keys = Object.keys(patch);
        if (!keys.length) { d.step('ok', '현재 고급 설정이 진단 결과와 맞습니다.'); return; }
        var desc = keys.map(function (k) { return k + ' → ' + JSON.stringify(patch[k]); }).join(', ');
        var btn = el('button', { class: 'btn', type: 'button', text: '권장값 적용 (저장 전까지 반영 안 됨)' });
        btn.addEventListener('click', function () {
          keys.forEach(function (k) {
            var f = document.querySelector('#settings [data-bind="generation.' + k + '"]');
            if (!f) return;
            if (f.type === 'checkbox') f.checked = !!patch[k]; else f.value = patch[k];
          });
          setDirty(true); updateApiPreview();
          btn.disabled = true; btn.textContent = '적용됨 — [저장]을 눌러 확정하세요';
        });
        d.step('info', '권장 변경: ' + desc);
        d.node(el('div', { class: 'row' }, btn));
      });
    }).then(function () { d.end(); }, function (e) { d.step('fail', '진단 오류', errLine(e)); d.end(); });
  }

  // ───────────────────────── 설정 이벤트 ─────────────────────────
  function bindSettings() {
    var dlg = $('settings');
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); closeSettings(false); });
    $('set-close').addEventListener('click', function () { closeSettings(false); });
    $('set-cancel').addEventListener('click', function () { closeSettings(false); });
    $('set-save').addEventListener('click', saveSettingsFromForm);
    document.querySelectorAll('.set-tab').forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });
    $('settings-form').addEventListener('input', function (e) {
      if (!e.target.dataset || !e.target.dataset.bind) return;
      setDirty(true);
      if (e.target.id === 'sp-text') updateSpCount(); else updateApiPreview();
    });
    $('settings-form').addEventListener('change', function (e) { if (e.target.dataset && e.target.dataset.bind) { setDirty(true); updateApiPreview(); } });
    $('settings-form').addEventListener('submit', function (e) { e.preventDefault(); });
    document.querySelectorAll('#settings [data-reveal]').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = $(b.dataset.reveal);
        t.type = t.type === 'password' ? 'text' : 'password';
        b.setAttribute('aria-pressed', t.type === 'text' ? 'true' : 'false');
      });
    });

    // System Prompt
    $('sp-reset').addEventListener('click', function () {
      if (!confirm('System Prompt를 기본값으로 되돌릴까요? (저장 전까지는 적용되지 않습니다)')) return;
      $('sp-text').value = C.DEFAULT_SYSTEM_PROMPT; setDirty(true); updateSpCount();
    });
    $('sp-import').addEventListener('click', function () { $('sp-file').click(); });
    $('sp-file').addEventListener('change', function () {
      var f = this.files[0]; this.value = '';
      if (!f) return;
      f.text().then(function (t) {
        if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
        $('sp-text').value = t; setDirty(true); updateSpCount();
      });
    });
    $('sp-export-txt').addEventListener('click', function () { download('system-prompt.txt', $('sp-text').value); });
    $('sp-export-md').addEventListener('click', function () { download('system-prompt.md', $('sp-text').value, 'text/markdown;charset=utf-8'); });
    $('sp-lint-btn').addEventListener('click', function () {
      var res = C.lintSystemPrompt($('sp-text').value);
      var LV = { warn: '경고', info: '정보', error: '오류' };
      $('sp-lint').replaceChildren.apply($('sp-lint'), res.length ? res.map(function (x) {
        return el('div', { class: 'diag-step ' + x.level }, el('span', { class: 'sym', text: x.level === 'warn' ? '!' : '○' }), el('div', null, el('b', { text: (LV[x.level] || '') + ' ' }), x.message));
      }) : [el('div', { class: 'diag-step ok' }, el('span', { class: 'sym', text: '✓' }), el('div', { text: '점검 결과 경고가 없습니다.' }))]);
    });

    // 참조 CSV
    $('ref-upload').addEventListener('click', function () { $('ref-file').click(); });
    $('ref-file').addEventListener('change', function () { var f = this.files[0]; this.value = ''; uploadReference(f); });
    $('ref-remove').addEventListener('click', removeReference);
    $('ref-rebuild').addEventListener('click', rebuildReference);
    var drop = $('ref-drop');
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) uploadReference(f); });
    $('ref-test-btn').addEventListener('click', runSearchTest);
    $('ref-test-q').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runSearchTest(); } });

    // 진단
    $('btn-conn-test').addEventListener('click', connectionTest);
    $('btn-reco').addEventListener('click', recommendedCheck);
    $('btn-diag').addEventListener('click', modelDiagnosis);

    // 내보내기 / 가져오기
    $('exp-btn').addEventListener('click', function () {
      var inc = $('exp-secrets').checked;
      if (inc && !confirm('API 키와 프록시 토큰이 파일에 평문으로 포함됩니다. 계속할까요?')) return;
      download('nai-prompt-generator-settings.json', JSON.stringify(C.exportSettings(readForm(), inc), null, 2), 'application/json');
    });
    $('imp-btn').addEventListener('click', function () { $('imp-file').click(); });
    $('imp-file').addEventListener('change', function () {
      var f = this.files[0]; this.value = '';
      if (!f) return;
      f.text().then(function (t) {
        var j = JSON.parse(t);
        var cur = readForm();
        var merged = C.mergeDefaults(j);
        if (!merged.api.apiKey) merged.api.apiKey = cur.api.apiKey;
        if (!merged.proxy.token) merged.proxy.token = cur.proxy.token;
        delete merged.exportedAt; delete merged.secretsIncluded;
        S.draft = merged;
        fillForm(merged); setDirty(true); updateSpCount(); updateApiPreview();
        alert('설정을 불러왔습니다. [저장]을 눌러야 적용됩니다.');
      }).catch(function (e) { alert('설정 파일을 읽지 못했습니다: ' + e.message); });
    });
  }

  // ───────────────────────── 메인 이벤트 ─────────────────────────
  function isMobile() { return window.matchMedia('(max-width: 820px)').matches; }

  function bindMain() {
    $('composer').addEventListener('submit', onSubmit);
    var input = $('input');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (!S.gen) onSubmit();
      } else if (e.key === 'ArrowUp' && !input.value) {
        var c = currentChat();
        if (!c) return;
        for (var i = c.messages.length - 1; i >= 0; i--) if (c.messages[i].role === 'user') { e.preventDefault(); input.value = c.messages[i].content; autoGrow(); updateComposer(); break; }
      }
    });
    input.addEventListener('input', function () { autoGrow(); updateComposer(); saveDraftSoon(); });
    input.addEventListener('paste', function (e) {
      var files = e.clipboardData && e.clipboardData.files;
      if (files && files.length && addImageFiles(files)) {
        if (!(e.clipboardData.getData('text/plain') || '').trim()) e.preventDefault();
      }
    });
    $('btn-attach').addEventListener('click', function () { $('img-file').click(); });
    $('img-file').addEventListener('change', function () { addImageFiles(this.files); this.value = ''; input.focus(); });
    var main = document.querySelector('.main');
    var dragDepth = 0;
    function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1; }
    main.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('composer').classList.add('drop'); });
    main.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    main.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('composer').classList.remove('drop'); });
    main.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; $('composer').classList.remove('drop');
      if (!addImageFiles(e.dataTransfer.files)) alert('이미지 파일만 첨부할 수 있습니다.');
    });
    var lb = $('lightbox');
    lb.addEventListener('click', function () { lb.close(); });
    window.addEventListener('beforeunload', saveDraftNow);

    $('btn-new-chat').addEventListener('click', newChat);
    $('btn-settings-side').addEventListener('click', function () { $('app').classList.remove('sb-open'); openSettings(); });
    $('btn-collapse').addEventListener('click', function () { $('app').classList.add('sb-collapsed'); lsSet('nai:sb', 'collapsed'); });
    $('btn-sidebar-open').addEventListener('click', function () {
      if (isMobile()) $('app').classList.toggle('sb-open');
      else { $('app').classList.remove('sb-collapsed'); lsSet('nai:sb', ''); }
    });
    $('scrim').addEventListener('click', function () { $('app').classList.remove('sb-open'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('app').classList.contains('sb-open')) $('app').classList.remove('sb-open');
    });
  }

  // ───────────────────────── 시작 ─────────────────────────
  function init() {
    if (lsGet('nai:sb') === 'collapsed') $('app').classList.add('sb-collapsed');
    S.engine = window.NAIReference.createEngine();
    S.engine.onProgress(onRefProgress);
    bindMain();
    bindSettings();
    renderThread();
    $('ref-status').textContent = refStatusText();

    window.NAIStorage.open().then(function (store) {
      S.store = store;
      if (!store.available) banner('이 브라우저에서 IndexedDB를 사용할 수 없어 대화·설정·참조 파일이 새로고침하면 사라집니다.');
      return Promise.all([
        store.get('kv', 'settings').catch(function () { return null; }),
        store.all('chats').catch(function () { return []; })
      ]);
    }).then(function (res) {
      S.settings = C.mergeDefaults(res[0]);
      (res[1] || []).forEach(function (c) {
        if (!c || !c.id || !Array.isArray(c.messages)) return;
        var touched = false;
        c.messages.forEach(function (m) {
          if (m.status === 'streaming') {
            touched = true;
            if (m.content) m.status = 'cancelled';
            else { m.status = 'error'; m.error = { code: 'CANCELLED', message: '페이지를 닫거나 새로고침해 생성이 중단되었습니다.' }; }
          }
        });
        S.chats.set(c.id, c);
        if (touched) saveChat(c);
      });
      var cur = lsGet('nai:current');
      S.currentId = cur && S.chats.has(cur) ? cur : null;
      renderChatList();
      renderThread(true);
      loadDraft();
      updateComposer();
      return S.store.get('reference', 'main').catch(function () { return null; });
    }).then(function (rec) {
      if (!rec || !(rec.blob || rec.text)) { renderRefStatus(); return; }
      return loadReferenceBlob(rec.blob || new Blob([rec.text]), rec.meta).catch(function () {
        banner('저장된 참조 CSV를 불러오지 못했습니다. 설정 > 참조 데이터에서 다시 업로드하세요.');
      });
    }).catch(function (e) {
      banner('초기화 중 오류: ' + safe(e && e.message || e));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
