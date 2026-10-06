/*
 * NAI Prompt Generator — 코어 로직 (DOM 비의존)
 *
 * - 설정 기본값 / 병합
 * - 엔드포인트·인증 헤더 결정 (직접 / 프록시 / 로컬 no-key)
 * - 요청 body 조립, 메시지 역할 정규화
 * - OpenAI-compatible 호출 + SSE 스트리밍 + 취소/타임아웃
 * - 오류 분류
 * - 대화 맥락 조립, Query Planner, 참조 후보 블록
 * - 출력 검증, 토큰 추정, 지시사항 점검, 권장 설정 점검
 *
 * 브라우저에서는 window.NAICore, Node 테스트에서는 module.exports.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NAICore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── 기본값 ─────────────────────────
  var DEFAULT_SYSTEM_PROMPT = [
    '당신은 NovelAI(NAI) 이미지 생성용 프롬프트 작성기입니다.',
    '',
    '[역할]',
    '- 사용자의 자연어 요청(주로 한국어)을 NAI에 바로 넣을 수 있는 영어 Danbooru 태그 기반 프롬프트로 변환합니다.',
    '',
    '[참조 태그]',
    '- [REFERENCE TAG CANDIDATES] 블록이 제공되면 그 안의 정식 태그 표기를 우선 사용합니다.',
    '- 후보는 참고 자료일 뿐이며, 요청과 무관한 태그는 사용하지 않습니다.',
    '- 후보에 없는 개념은 Danbooru 표기 관례에 맞는 태그나 짧은 영어 구문으로 보충합니다.',
    '',
    '[작성 규칙]',
    '- 태그는 쉼표로 구분하고 소문자로 씁니다. 태그 안의 밑줄(_)은 공백으로 바꿉니다.',
    '- 순서: 인원/성별 → 캐릭터·작품 → 외형(머리, 눈, 체형) → 복장 → 표정 → 자세·동작 → 구도·시점 → 배경·장소 → 조명·분위기.',
    '- 같은 의미의 태그를 중복하지 않습니다.',
    '- 등장인물이 2명 이상이면 공통 장면은 Base Prompt에, 인물별 묘사는 Character Prompt로 나누어 씁니다.',
    '',
    '[이미지 분석]',
    '- 이미지가 첨부되면 보이는 요소(인원, 캐릭터 외형, 복장, 표정, 자세·동작, 구도·시점, 배경, 조명, 화풍)를 태그로 옮깁니다.',
    '- 이미지에서 확인할 수 없는 요소는 지어내지 않습니다. 인물이 2명 이상이면 아래 다인 형식을 따릅니다.',
    '',
    '[수정 요청]',
    '- 직전에 완성한 프롬프트가 있고 사용자가 일부 수정을 요청하면, 요청한 부분만 바꾸고 나머지 태그와 순서는 그대로 유지합니다.',
    '',
    '[출력 형식]',
    '- 설명, 인사, 해설 없이 프롬프트만 출력합니다.',
    '- 인물 1명:',
    '[NAI 프롬프트]',
    '<태그 목록>',
    '- 인물 2명 이상:',
    '[Base Prompt]',
    '<공통 태그>',
    '[Character Prompt 1]',
    '<인물 1 태그>',
    '[Character Prompt 2]',
    '<인물 2 태그>'
  ].join('\n');

  var DEFAULT_SETTINGS = {
    version: 1,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    api: {
      name: '',
      modelId: '',
      url: '',
      apiKey: '',
      format: 'openai',
      mode: 'auto',
      allowNoKey: false
    },
    proxy: {
      enabled: false,
      url: '',
      token: '',
      forwardApiKey: false
    },
    generation: {
      stream: true,
      streamFallback: true,
      keepPartialOnCancel: true,
      hasFirstSystemPrompt: true,
      requiresAlternateRole: false,
      mustStartWithUserInput: false,
      systemAsUser: false,
      useMaxTokens: true,
      maxTokens: 2048,
      tokenParam: 'auto',
      reasoningEffort: '',
      thinkingLevel: '',
      thinkingBudget: 0,
      temperature: '',
      extraBody: '',
      timeoutSec: 120
    },
    planner: {
      enabled: true,
      modelId: '',
      maxTokens: 600
    },
    retrieval: {
      perKeyword: 10,
      maxTotal: 150,
      includeInputTerms: true
    },
    vision: {
      maxSide: 1536,
      quality: 0.9,
      detail: '',
      plannerImages: true,
      resendHistoryImages: false,
      maxImages: 4
    },
    context: {
      maxTurns: 12,
      charBudget: 24000
    },
    validation: {
      enabled: true,
      tokenLimit: 700
    },
    debug: false,
    presets: [],
    activePresetId: '',
    promptPresets: [],
    activePromptPresetId: ''
  };

  // ───────────────────────── 모델 프리셋 ─────────────────────────
  // 모델마다 달라지는 묶음: API·프록시·생성(추론/호환)·Planner·비전
  var PRESET_KEYS = ['api', 'proxy', 'generation', 'planner', 'vision'];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function mergeDefaults(saved, defaults) {
    defaults = defaults || DEFAULT_SETTINGS;
    var out = clone(defaults);
    (function merge(dst, src) {
      if (!src || typeof src !== 'object') return;
      Object.keys(src).forEach(function (k) {
        var v = src[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') merge(dst[k], v);
        else if (v !== undefined) dst[k] = v;
      });
    })(out, saved);
    return out;
  }

  function presetFromSettings(settings, name, id) {
    var p = { id: id || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(name || '').trim() || '이름 없는 프리셋', updatedAt: Date.now() };
    PRESET_KEYS.forEach(function (k) { p[k] = clone(settings[k] || DEFAULT_SETTINGS[k]); });
    return p;
  }

  // 프리셋 섹션은 평평한 객체라 기본값 위에 얕게 덮어쓴다 (예전 프리셋에 없는 새 필드 보충)
  function presetSection(p, k) { return Object.assign(clone(DEFAULT_SETTINGS[k]), clone(p && p[k] || {})); }

  function applyPreset(settings, preset) {
    var out = clone(settings);
    PRESET_KEYS.forEach(function (k) { out[k] = presetSection(preset, k); });
    out.activePresetId = preset.id;
    return out;
  }

  function presetMatches(settings, preset) {
    if (!preset) return false;
    return PRESET_KEYS.every(function (k) {
      return JSON.stringify(presetSection(settings, k)) === JSON.stringify(presetSection(preset, k));
    });
  }

  // ───────────────────────── System Prompt 프리셋 ─────────────────────────
  // System Prompt는 항상 프리셋 중 하나다. settings.systemPrompt는 활성 프리셋 본문의 사본.
  function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function findPromptPreset(settings, id) {
    return (settings.promptPresets || []).filter(function (p) { return p.id === id; })[0] || null;
  }

  function makePromptPreset(name, text) {
    return { id: newId('sp'), name: String(name || '').trim() || '이름 없는 지시사항', text: String(text == null ? '' : text), updatedAt: Date.now() };
  }

  // 예전 설정(프리셋 없음)은 지금 System Prompt를 첫 프리셋으로 등록
  function ensurePromptPresets(settings) {
    if (!Array.isArray(settings.promptPresets) || !settings.promptPresets.length) {
      var sp = settings.systemPrompt == null ? DEFAULT_SYSTEM_PROMPT : settings.systemPrompt;
      settings.promptPresets = [makePromptPreset(sp === DEFAULT_SYSTEM_PROMPT ? '기본 지시사항' : '내 지시사항', sp)];
    }
    var active = findPromptPreset(settings, settings.activePromptPresetId) || settings.promptPresets[0];
    settings.activePromptPresetId = active.id;
    settings.systemPrompt = active.text;
    return settings;
  }

  function selectPromptPreset(settings, id) {
    var out = clone(settings);
    var p = findPromptPreset(out, id);
    if (!p) return out;
    out.activePromptPresetId = p.id;
    out.systemPrompt = p.text;
    return out;
  }

  /*
   * 대화방 ↔ 프롬프트 프리셋 관계
   *   unbound  : 아직 묶이지 않음 (새 대화, 기능 이전 대화) → 보내면 활성 프리셋으로 묶음
   *   ok       : 묶인 프리셋 = 활성 프리셋
   *   mismatch : 다른 프리셋이 선택됨 → 전송 차단
   *   deleted  : 묶인 프리셋이 삭제됨 → 새 대화로만 진행
   */
  function chatPromptStatus(settings, chat) {
    var active = findPromptPreset(settings, settings.activePromptPresetId);
    if (!chat || !chat.promptPresetId) return { state: 'unbound', active: active, bound: null };
    var bound = findPromptPreset(settings, chat.promptPresetId);
    if (!bound) return { state: 'deleted', active: active, bound: null, boundName: chat.promptPresetName || '' };
    return { state: active && bound.id === active.id ? 'ok' : 'mismatch', active: active, bound: bound };
  }

  function findPreset(settings, id) {
    return (settings.presets || []).filter(function (p) { return p.id === id; })[0] || null;
  }

  // 내보내기용: 민감정보 제외가 기본값
  function exportSettings(settings, includeSecrets) {
    var s = clone(settings);
    if (!includeSecrets) {
      s.api.apiKey = '';
      s.proxy.token = '';
      (s.presets || []).forEach(function (p) {
        if (p.api) p.api.apiKey = '';
        if (p.proxy) p.proxy.token = '';
      });
    }
    s.exportedAt = new Date().toISOString();
    s.secretsIncluded = !!includeSecrets;
    return s;
  }

  // ───────────────────────── URL / 호스트 ─────────────────────────
  function parseUrl(u) {
    try {
      var x = new URL(String(u || '').trim());
      if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
      return x;
    } catch (_) { return null; }
  }

  function hostKind(u) {
    var x = parseUrl(u);
    if (!x) return 'invalid';
    var h = x.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (h === 'localhost' || h.slice(-10) === '.localhost' || h === '::1' || /^127\./.test(h) || h === '0.0.0.0') return 'loopback';
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
        /^169\.254\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || /\.local$/.test(h) || /\.lan$/.test(h)) return 'private';
    return 'remote';
  }

  function isLocalKind(kind) { return kind === 'loopback' || kind === 'private'; }

  // API 방식 '자동 감지': base URL만 넣어도 /v1/chat/completions 로 보정
  function resolveApiUrl(url, mode) {
    var raw = String(url || '').trim();
    if (!raw) return '';
    if (mode === 'raw') return raw;
    var x = parseUrl(raw);
    if (!x) return raw;
    var path = x.pathname.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(path)) { /* 그대로 */ }
    else if (/\/(v\d+(beta\d*|alpha\d*)?|openai|api\/v\d+)$/i.test(path)) path += '/chat/completions';
    else if (path === '') path = '/v1/chat/completions';
    x.pathname = path;
    return x.toString();
  }

  function modelsUrlFrom(chatUrl) {
    var x = parseUrl(chatUrl);
    if (!x || !/\/chat\/completions\/?$/i.test(x.pathname)) return '';
    x.pathname = x.pathname.replace(/\/chat\/completions\/?$/i, '/models');
    x.search = '';
    return x.toString();
  }

  function stripBearer(v) { return String(v || '').trim().replace(/^Bearer\s+/i, '').trim(); }

  // ───────────────────────── 대상 / 인증 결정 (§24) ─────────────────────────
  function resolveTarget(settings, opts) {
    opts = opts || {};
    var api = settings.api || {};
    var proxy = settings.proxy || {};
    var apiUrl = resolveApiUrl(api.url, api.mode);
    var apiKey = stripBearer(api.apiKey);
    var headers = { 'Content-Type': 'application/json' };
    if (opts.stream) headers.Accept = 'text/event-stream';
    var t = {
      url: '', apiUrl: apiUrl, headers: headers,
      endpointKind: '', credential: 'none', credentialLabel: '', hostKind: '',
      error: null, warnings: []
    };

    if (proxy.enabled) {
      var purl = String(proxy.url || '').trim();
      t.endpointKind = 'proxy';
      t.url = purl;
      t.hostKind = hostKind(purl);
      if (!purl) { t.error = mkErr('CONFIG_ERROR', '프록시 사용이 켜져 있지만 프록시 URL이 비어 있습니다.'); return t; }
      if (t.hostKind === 'invalid') { t.error = mkErr('CONFIG_ERROR', '프록시 URL 형식이 올바르지 않습니다. http(s)://로 시작해야 합니다.'); return t; }
      var tok = stripBearer(proxy.token);
      if (tok) {
        headers.Authorization = 'Bearer ' + tok;
        headers['X-Lumos-Proxy-Token'] = tok;
        t.credential = 'proxy-token';
        t.credentialLabel = '프록시 토큰 → Authorization: Bearer, X-Lumos-Proxy-Token';
      } else {
        t.credentialLabel = '인증 헤더 없음 (프록시 토큰 비어 있음)';
        t.warnings.push('프록시 토큰이 비어 있어 인증 헤더 없이 프록시를 호출합니다.');
      }
      if (apiUrl) {
        headers['X-Lumos-Original-Url'] = apiUrl;
        headers['X-Lumos-Upstream-Url'] = apiUrl;
      }
      if (proxy.forwardApiKey && apiKey) {
        headers['X-Lumos-Upstream-Authorization'] = 'Bearer ' + apiKey;
        t.credentialLabel += ' + 원본 API 키(X-Lumos-Upstream-Authorization)';
      }
      return t;
    }

    t.url = apiUrl;
    t.hostKind = hostKind(apiUrl);
    t.endpointKind = isLocalKind(t.hostKind) ? 'local' : 'direct';
    if (!apiUrl) { t.error = mkErr('CONFIG_ERROR', 'API URL이 비어 있습니다. 설정 > API / 프록시에서 입력하세요.'); return t; }
    if (t.hostKind === 'invalid') { t.error = mkErr('CONFIG_ERROR', 'API URL 형식이 올바르지 않습니다. http(s)://로 시작해야 합니다.'); return t; }
    if (apiKey) {
      headers.Authorization = 'Bearer ' + apiKey;
      t.credential = 'api-key';
      t.credentialLabel = 'API 키 → Authorization: Bearer';
    } else if (isLocalKind(t.hostKind) || api.allowNoKey) {
      // 빈 'Bearer ' 를 보내지 않는다 — 헤더 자체 생략
      t.credentialLabel = isLocalKind(t.hostKind) ? '인증 헤더 없음 (로컬 엔드포인트)' : '인증 헤더 없음 (API 키 없음 허용)';
    } else {
      t.error = mkErr('CONFIG_ERROR', '원격 엔드포인트인데 API 키가 비어 있습니다. 키를 입력하거나, 키가 필요 없는 서버라면 "API 키 없음 허용"을 켜세요.');
    }
    return t;
  }

  // ───────────────────────── 요청 body ─────────────────────────
  function autoTokenParam(modelId) {
    var m = String(modelId || '').toLowerCase().replace(/^.*\//, '');
    if (/^(o\d|gpt-5|gpt-4\.1|codex)/.test(m)) return 'max_completion_tokens';
    return 'max_tokens';
  }

  function providerOf(modelId, url) {
    var s = (String(modelId || '') + ' ' + String(url || '')).toLowerCase();
    if (/gemini|generativelanguage/.test(s)) return 'gemini';
    if (/claude|anthropic/.test(s)) return 'anthropic';
    if (/(^|[\s\/])(o\d|gpt-|chatgpt)|openai\.com/.test(s)) return 'openai';
    return 'generic';
  }

  function buildBody(settings, messages, opts) {
    opts = opts || {};
    var g = settings.generation || {};
    var modelId = opts.modelId || (settings.api && settings.api.modelId) || '';
    var body = { model: modelId, messages: messages, stream: !!opts.stream };
    var notes = [];
    var maxTokens = opts.maxTokens != null ? opts.maxTokens : (g.useMaxTokens ? g.maxTokens : null);
    if (maxTokens != null && Number(maxTokens) > 0) {
      var param = g.tokenParam && g.tokenParam !== 'auto' ? g.tokenParam : autoTokenParam(modelId);
      if (param !== 'none') body[param] = Math.floor(Number(maxTokens));
    }
    if (g.temperature !== '' && g.temperature != null && isFinite(Number(g.temperature))) body.temperature = Number(g.temperature);
    if (g.reasoningEffort) body.reasoning_effort = g.reasoningEffort;

    var provider = providerOf(modelId, settings.api && settings.api.url);
    var budget = Number(g.thinkingBudget) || 0;
    if (g.thinkingLevel || budget > 0) {
      if (provider === 'gemini') {
        var tc = {};
        if (g.thinkingLevel) tc.thinking_level = g.thinkingLevel;
        if (budget > 0) tc.thinking_budget = Math.floor(budget);
        body.extra_body = { google: { thinking_config: tc } };
      } else if (provider === 'anthropic' && budget > 0) {
        body.thinking = { type: 'enabled', budget_tokens: Math.floor(budget) };
        if (g.thinkingLevel) notes.push('Thinking Level은 이 공급자에 정의된 필드가 없어 전송하지 않았습니다.');
      } else {
        notes.push('Thinking Level / Budget은 공급자 프로필을 알 수 없어 전송하지 않았습니다. 필요하면 추가 body JSON을 사용하세요.');
      }
    }
    if (g.extraBody && String(g.extraBody).trim()) {
      var extra = parseExtraBody(g.extraBody);
      if (extra.error) throw mkErr('CONFIG_ERROR', '추가 body JSON 오류: ' + extra.error);
      Object.keys(extra.value).forEach(function (k) { if (k !== 'messages' && k !== 'stream') body[k] = extra.value[k]; });
    }
    if (opts.overrides) Object.keys(opts.overrides).forEach(function (k) {
      if (opts.overrides[k] === undefined) delete body[k]; else body[k] = opts.overrides[k];
    });
    return { body: body, notes: notes };
  }

  function parseExtraBody(text) {
    try {
      var v = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'JSON 객체({ ... })여야 합니다.' };
      return { value: v };
    } catch (e) { return { error: e.message }; }
  }

  // §11 호환 옵션: system 위치 / 역할 교대 / user 시작
  function hasContent(c) { return typeof c === 'string' ? c !== '' : Array.isArray(c) && c.length > 0; }
  function toParts(c) { return Array.isArray(c) ? c.slice() : [{ type: 'text', text: String(c) }]; }
  function joinContent(a, b) {
    if (typeof a === 'string' && typeof b === 'string') return a + '\n\n' + b;
    return toParts(a).concat(toParts(b));
  }

  function normalizeMessages(msgs, g) {
    g = g || {};
    var list = msgs.filter(function (m) { return m && hasContent(m.content); })
      .map(function (m) { return { role: m.role, content: Array.isArray(m.content) ? m.content.slice() : m.content }; });
    var systems = list.filter(function (m) { return m.role === 'system'; });
    var rest = list.filter(function (m) { return m.role !== 'system'; });
    var out;
    if (g.systemAsUser) {
      out = systems.length ? [{ role: 'user', content: systems.map(function (m) { return m.content; }).join('\n\n') }].concat(rest) : rest;
    } else if (g.hasFirstSystemPrompt) {
      out = systems.length ? [{ role: 'system', content: systems.map(function (m) { return m.content; }).join('\n\n') }].concat(rest) : rest;
    } else {
      out = list;
    }
    if (g.mustStartWithUserInput) {
      var firstIdx = -1;
      for (var i = 0; i < out.length; i++) if (out[i].role !== 'system') { firstIdx = i; break; }
      if (firstIdx !== -1 && out[firstIdx].role !== 'user') out.splice(firstIdx, 0, { role: 'user', content: '(대화 시작)' });
    }
    if (g.requiresAlternateRole || g.systemAsUser) {
      var merged = [];
      out.forEach(function (m) {
        var last = merged[merged.length - 1];
        if (last && last.role === m.role && m.role !== 'system') last.content = joinContent(last.content, m.content);
        else merged.push({ role: m.role, content: m.content });
      });
      out = merged;
    }
    return out;
  }

  // ───────────────────────── 이미지 입력 (비전) ─────────────────────────
  // OpenAI-compatible content parts: [{type:'text'}, {type:'image_url', image_url:{url:'data:...'}}]
  function buildUserContent(text, images, vision) {
    var imgs = (images || []).filter(function (i) { return i && i.dataUrl; });
    if (!imgs.length) return text;
    var detail = vision && vision.detail;
    var parts = [{ type: 'text', text: text && String(text).trim() ? text : '(이미지 첨부)' }];
    imgs.forEach(function (i) {
      var iu = { url: i.dataUrl };
      if (detail) iu.detail = detail;
      parts.push({ type: 'image_url', image_url: iu });
    });
    return parts;
  }

  function imageNote(n) { return '[첨부 이미지 ' + n + '장 — 이번 요청에는 다시 보내지 않음]'; }

  function contentText(c) {
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.filter(function (p) { return p && p.type === 'text'; }).map(function (p) { return p.text; }).join('\n');
  }

  function countImages(messages) {
    var n = 0;
    (messages || []).forEach(function (m) {
      if (Array.isArray(m.content)) m.content.forEach(function (p) { if (p && p.type === 'image_url') n++; });
    });
    return n;
  }

  // ───────────────────────── 오류 ─────────────────────────
  var ERROR_TEXT = {
    NETWORK_ERROR: '서버에 연결할 수 없습니다. URL, 서버 실행 여부, 네트워크를 확인하세요.',
    CORS_BLOCKED: 'CORS로 브라우저 직접 호출이 차단되었습니다.\n프록시를 켜거나 로컬 서버의 CORS 허용 설정을 확인하세요.',
    MIXED_CONTENT: 'HTTPS 페이지에서 HTTP 원격 주소를 호출할 수 없습니다(혼합 콘텐츠 차단).\nHTTPS 엔드포인트나 프록시를 사용하거나, 앱을 로컬(http)로 여세요.',
    AUTH_FAILED: '인증에 실패했습니다. 전송한 인증 정보(API 키 또는 프록시 토큰)를 확인하세요.',
    ENDPOINT_NOT_FOUND: '엔드포인트를 찾을 수 없습니다(404). API URL 경로를 확인하세요.',
    MODEL_NOT_FOUND: '모델을 찾을 수 없거나 접근 권한이 없습니다. 모델 ID를 확인하세요.',
    RATE_LIMITED: '요청 한도를 초과했습니다(429). 잠시 후 다시 시도하세요.',
    PROVIDER_5XX: '공급자 서버 오류(5xx)입니다. 잠시 후 다시 시도하세요.',
    BAD_REQUEST: '요청이 거부되었습니다(4xx). 고급 설정의 호환 옵션을 확인하세요.',
    STREAM_PARSE_ERROR: '스트리밍 응답을 해석하지 못했습니다.',
    TIMEOUT: '응답 시간이 초과되었습니다.',
    REFERENCE_FILE_PARSE_ERROR: '참조 CSV 파일을 해석하지 못했습니다.',
    EMPTY_RESPONSE: '모델이 빈 응답을 반환했습니다.',
    CANCELLED: '사용자가 생성을 중지했습니다.',
    CONFIG_ERROR: '설정을 확인하세요.',
    VISION_UNSUPPORTED: '이 모델 또는 서버가 이미지 입력을 지원하지 않는 것 같습니다.\n비전 모델을 선택하거나 이미지를 빼고 보내세요.'
  };

  function mkErr(code, message, extra) {
    var e = new Error(message || ERROR_TEXT[code] || code);
    e.code = code;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  function extractErrorMessage(bodyText) {
    if (!bodyText) return '';
    try {
      var j = JSON.parse(bodyText);
      var e = j.error !== undefined ? j.error : j;
      if (typeof e === 'string') return e;
      if (e && typeof e.message === 'string') return e.message;
      if (j && typeof j.message === 'string') return j.message;
      if (j && typeof j.detail === 'string') return j.detail;
    } catch (_) {}
    var t = String(bodyText).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return t.slice(0, 300);
  }

  function classifyHttpError(status, bodyText, opts) {
    var msg = extractErrorMessage(bodyText);
    var lower = (msg + ' ' + String(bodyText || '').slice(0, 2000)).toLowerCase();
    if (opts && opts.hasImages && (status === 400 || status === 413 || status === 415 || status === 422 || status === 500) &&
        /image|vision|multimodal|multi-modal|image_url|mm_|clip|mmproj/.test(lower)) {
      return mkErr('VISION_UNSUPPORTED', ERROR_TEXT.VISION_UNSUPPORTED, { status: status, detail: msg });
    }
    var modelHint = /model/.test(lower) && /(not[ _]?found|does not exist|doesn't exist|unknown|invalid|no such|not available|unsupported|not supported|access)/.test(lower);
    var code;
    if (status === 401 || status === 403) code = 'AUTH_FAILED';
    else if (status === 404) code = modelHint ? 'MODEL_NOT_FOUND' : 'ENDPOINT_NOT_FOUND';
    else if (status === 429) code = 'RATE_LIMITED';
    else if (status >= 500) code = 'PROVIDER_5XX';
    else if (status === 400 || status === 422) code = modelHint ? 'MODEL_NOT_FOUND' : 'BAD_REQUEST';
    else code = 'BAD_REQUEST';
    return mkErr(code, ERROR_TEXT[code], { status: status, detail: msg });
  }

  // 비밀값 마스킹: 오류/디버그 문자열에서 키·토큰 제거
  function redact(text, secrets) {
    var s = String(text == null ? '' : text);
    (secrets || []).forEach(function (sec) {
      sec = stripBearer(sec);
      if (sec && sec.length >= 4) s = s.split(sec).join('••••');
    });
    return s.replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]{6,}/gi, '$1••••')
      .replace(/\b(sk|rk|pk|xai|gsk|AIza)[-_A-Za-z0-9]{10,}/g, '••••');
  }

  function secretsOf(settings) {
    var out = [];
    function add(x) { if (x && x.api && x.api.apiKey) out.push(x.api.apiKey); if (x && x.proxy && x.proxy.token) out.push(x.proxy.token); }
    if (settings) { add(settings); (settings.presets || []).forEach(add); }
    return out;
  }

  // fetch 자체가 실패(TypeError)했을 때 CORS / 네트워크 / 혼합콘텐츠 구분
  function diagnoseFetchFailure(url, fetchImpl, pageProtocol) {
    var kind = hostKind(url);
    var x = parseUrl(url);
    if (pageProtocol === 'https:' && x && x.protocol === 'http:' && kind !== 'loopback') {
      return Promise.resolve(mkErr('MIXED_CONTENT'));
    }
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    // no-cors 요청은 CORS 검사를 받지 않는다. 이게 성공하면 서버는 살아 있고, 원래 실패는 CORS 때문이다.
    return fetchImpl(url, { method: 'GET', mode: 'no-cors', signal: ctrl && ctrl.signal })
      .then(function () { return mkErr('CORS_BLOCKED'); })
      .catch(function () { return mkErr('NETWORK_ERROR'); })
      .then(function (e) { if (timer) clearTimeout(timer); return e; });
  }

  // ───────────────────────── SSE ─────────────────────────
  function createSSEParser(onData) {
    var buf = '';
    var dataLines = [];
    function dispatch() {
      if (!dataLines.length) return;
      var data = dataLines.join('\n');
      dataLines = [];
      onData(data);
    }
    function line(l) {
      if (l === '') { dispatch(); return; }
      if (l.charCodeAt(0) === 58) return; // ':' 주석/keep-alive
      var idx = l.indexOf(':');
      var field = idx === -1 ? l : l.slice(0, idx);
      var value = idx === -1 ? '' : l.slice(idx + 1);
      if (value.charCodeAt(0) === 32) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
    }
    return {
      push: function (chunk) {
        buf += chunk;
        var nl;
        while ((nl = buf.search(/\r\n|\r|\n/)) !== -1) {
          var l = buf.slice(0, nl);
          var step = buf.charAt(nl) === '\r' && buf.charAt(nl + 1) === '\n' ? 2 : 1;
          buf = buf.slice(nl + step);
          line(l);
        }
      },
      end: function () {
        if (buf) { line(buf); buf = ''; }
        dispatch();
      }
    };
  }

  function contentToText(c) {
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(function (p) { return typeof p === 'string' ? p : (p && (p.text || p.content)) || ''; }).join('');
    return '';
  }

  function parseCompletionJSON(obj) {
    if (obj && obj.error) {
      var em = typeof obj.error === 'string' ? obj.error : (obj.error.message || JSON.stringify(obj.error));
      throw mkErr('PROVIDER_5XX', '공급자가 오류를 반환했습니다.', { detail: em });
    }
    var ch = obj && obj.choices && obj.choices[0];
    var msg = ch && (ch.message || ch.delta) || {};
    return {
      text: contentToText(msg.content) || (ch && typeof ch.text === 'string' ? ch.text : ''),
      reasoning: contentToText(msg.reasoning_content || msg.reasoning),
      finishReason: ch && ch.finish_reason || '',
      usage: obj && obj.usage || null
    };
  }

  // ───────────────────────── 호출 ─────────────────────────
  /*
   * callChat({ settings, messages, stream, signal, onDelta, maxTokens, modelId, overrides,
   *            fetchImpl, pageProtocol, timeoutMs })
   * → { text, reasoning, finishReason, malformed, endpointKind, credentialLabel, timings, notes, usage, streamed }
   */
  function callChat(o) {
    var settings = o.settings;
    var g = settings.generation || {};
    var fetchImpl = o.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    var wantStream = o.stream != null ? !!o.stream : !!g.stream;
    var timeoutMs = o.timeoutMs || Math.max(5, Number(g.timeoutSec) || 120) * 1000;
    var secrets = secretsOf(settings);

    function attempt(stream) {
      var target = resolveTarget(settings, { stream: stream });
      if (target.error) return Promise.reject(target.error);
      var msgs = normalizeMessages(o.messages, g);
      var built = buildBody(settings, msgs, { stream: stream, maxTokens: o.maxTokens, modelId: o.modelId, overrides: o.overrides });

      var ctrl = new AbortController();
      var reason = '';
      var timer = null;
      function arm() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { reason = 'timeout'; ctrl.abort(); }, timeoutMs);
      }
      function onUserAbort() { reason = 'cancel'; ctrl.abort(); }
      if (o.signal) {
        if (o.signal.aborted) return Promise.reject(mkErr('CANCELLED'));
        o.signal.addEventListener('abort', onUserAbort);
      }
      function cleanup() {
        if (timer) clearTimeout(timer);
        if (o.signal) o.signal.removeEventListener('abort', onUserAbort);
      }

      var t0 = Date.now();
      var timings = { start: t0, headers: 0, firstToken: 0, end: 0 };
      var result = {
        text: '', reasoning: '', finishReason: '', malformed: 0, usage: null, streamed: false,
        endpointKind: target.endpointKind, credentialLabel: target.credentialLabel,
        hostKind: target.hostKind, timings: timings, notes: built.notes.concat(target.warnings),
        requestBodyKeys: Object.keys(built.body),
        imageCount: countImages(msgs)
      };
      function abortError(partialText) {
        var e = reason === 'timeout' ? mkErr('TIMEOUT') : mkErr('CANCELLED');
        e.partial = partialText || '';
        e.result = result;
        return e;
      }

      arm();
      return fetchImpl(target.url, {
        method: 'POST', headers: target.headers, body: JSON.stringify(built.body), signal: ctrl.signal
      }).then(function (res) {
        timings.headers = Date.now() - t0;
        result.status = res.status;
        if (!res.ok) {
          return res.text().catch(function () { return ''; }).then(function (t) {
            var e = classifyHttpError(res.status, t, { hasImages: result.imageCount > 0 });
            e.detail = redact(e.detail, secrets);
            e.bodyText = redact(String(t).slice(0, 2000), secrets);
            throw e;
          });
        }
        var ctype = (res.headers.get('content-type') || '').toLowerCase();
        if (stream && res.body && ctype.indexOf('json') === -1) {
          result.streamed = true;
          return readStream(res, result, o.onDelta, arm, timings, t0);
        }
        return res.text().then(function (t) {
          var obj;
          try { obj = JSON.parse(t); } catch (_) {
            // stream:false 인데 SSE로 온 경우
            if (/^\s*data:/m.test(t)) {
              var r2 = { text: '' };
              var p = createSSEParser(function (d) { if (d.trim() === '[DONE]') return; try { r2.text += parseCompletionJSON(JSON.parse(d)).text; } catch (_) { result.malformed++; } });
              p.push(t); p.end();
              result.text = r2.text;
              if (o.onDelta && result.text) o.onDelta(result.text, result.text);
              return result;
            }
            throw mkErr('STREAM_PARSE_ERROR', '응답 JSON을 해석하지 못했습니다.', { detail: redact(String(t).slice(0, 300), secrets) });
          }
          var parsed = parseCompletionJSON(obj);
          result.text = parsed.text; result.reasoning = parsed.reasoning;
          result.finishReason = parsed.finishReason; result.usage = parsed.usage;
          if (o.onDelta && result.text) o.onDelta(result.text, result.text);
          return result;
        });
      }).then(function (r) {
        cleanup();
        timings.end = Date.now() - t0;
        return r;
      }, function (err) {
        cleanup();
        timings.end = Date.now() - t0;
        if (err && err.name === 'AbortError' || ctrl.signal.aborted && !err.code) throw abortError(result.text);
        if (err && err.code) { err.result = err.result || result; throw err; }
        // fetch TypeError → CORS / 네트워크 / 혼합콘텐츠 판별
        if (result.streamed || timings.headers) {
          var ne = mkErr('NETWORK_ERROR', '응답을 받는 도중 연결이 끊겼습니다.', { partial: result.text, result: result });
          throw ne;
        }
        return diagnoseFetchFailure(target.url, fetchImpl, o.pageProtocol).then(function (e) {
          e.detail = redact(err && err.message || '', secrets);
          e.result = result;
          throw e;
        });
      });
    }

    function readStream(res, result, onDelta, arm, timings, t0) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var done = false;
      var streamError = null;
      var parser = createSSEParser(function (data) {
        var d = data.trim();
        if (!d) return;
        if (d === '[DONE]') { done = true; return; }
        var obj;
        try { obj = JSON.parse(d); } catch (_) { result.malformed++; return; }
        if (obj && obj.error) {
          var em = typeof obj.error === 'string' ? obj.error : (obj.error.message || JSON.stringify(obj.error));
          streamError = mkErr('PROVIDER_5XX', '스트리밍 중 공급자가 오류를 보냈습니다.', { detail: redact(em, secrets) });
          return;
        }
        var ch = obj && obj.choices && obj.choices[0];
        if (!ch) { if (obj && obj.usage) result.usage = obj.usage; return; }
        var delta = ch.delta || ch.message || {};
        var piece = contentToText(delta.content) || (typeof ch.text === 'string' ? ch.text : '');
        var rpiece = contentToText(delta.reasoning_content || delta.reasoning);
        if (rpiece) result.reasoning += rpiece;
        if (ch.finish_reason) result.finishReason = ch.finish_reason;
        if (obj.usage) result.usage = obj.usage;
        if (piece) {
          if (!timings.firstToken) timings.firstToken = Date.now() - t0;
          result.text += piece;
          if (onDelta) onDelta(piece, result.text);
        }
      });
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { parser.push(decoder.decode()); parser.end(); return; }
          arm();
          parser.push(decoder.decode(r.value, { stream: true }));
          if (streamError) { try { reader.cancel(); } catch (_) {} throw streamError; }
          if (done) { try { reader.cancel(); } catch (_) {} return; }
          return pump();
        });
      }
      return pump().then(function () {
        if (streamError) throw streamError;
        if (!result.text && result.malformed > 0) {
          throw mkErr('STREAM_PARSE_ERROR', '스트리밍 응답을 해석하지 못했습니다. (' + result.malformed + '개 청크 손상)', { result: result });
        }
        return result;
      }, function (e) {
        if (e && e.code) { e.partial = result.text; throw e; }
        throw e;
      });
    }

    return attempt(wantStream).catch(function (err) {
      // 스트리밍 거부(400 등) → 비스트리밍 1회 재시도
      if (wantStream && g.streamFallback && err && (err.code === 'BAD_REQUEST' || err.code === 'STREAM_PARSE_ERROR') && !(err.partial)) {
        return attempt(false).then(function (r) { r.notes.push('스트리밍 실패로 일반 요청으로 재시도했습니다.'); r.streamFallback = true; return r; });
      }
      throw err;
    });
  }

  // ───────────────────────── Query Planner ─────────────────────────
  var PLANNER_SYSTEM = [
    'You are a search-query planner for a local Danbooru / NovelAI tag database.',
    'Read the image request (often written in Korean) and output English keywords that will be looked up in the tag database.',
    'Rules:',
    '- Output JSON only, exactly in this shape: {"keywords": ["...", "..."]}. No prose, no markdown.',
    '- 10 to 40 keywords. Short Danbooru-style phrases in lowercase, e.g. "leaning on desk", "head down", "school uniform".',
    '- Cover what applies: number of people, character and series names (official romanized / English spelling), hair, eyes, body, clothing, expression, pose and action, camera angle and framing, background and location, lighting and mood.',
    '- If the request edits a previous prompt, focus on what changes and on tags needed for the change.',
    '- If images are attached, base the keywords on what is actually visible in them (people count, character traits, clothing, expression, pose, framing, background, lighting, art style).',
    '- Do not write the final prompt.'
  ].join('\n');

  function buildPlannerMessages(input, ctx, images, vision) {
    ctx = ctx || {};
    var parts = [];
    if (ctx.previousPrompt) parts.push('Previous final prompt:\n<<<\n' + String(ctx.previousPrompt).slice(0, 2500) + '\n>>>');
    if (ctx.recentRequests && ctx.recentRequests.length) {
      parts.push('Earlier requests in this conversation:\n' + ctx.recentRequests.slice(-3).map(function (r) { return '- ' + String(r).slice(0, 300); }).join('\n'));
    }
    var imgs = (images || []).filter(function (i) { return i && i.dataUrl; });
    parts.push('Current request:\n' + (String(input || '').trim() || '(no text)') + (imgs.length ? '\n(' + imgs.length + ' image(s) attached)' : ''));
    return [{ role: 'system', content: PLANNER_SYSTEM }, { role: 'user', content: buildUserContent(parts.join('\n\n'), imgs, vision) }];
  }

  function cleanKeywords(list, max) {
    var out = [];
    var seen = Object.create(null);
    (list || []).forEach(function (k) {
      if (typeof k !== 'string') return;
      var s = k.replace(/[\u0000-\u001f]/g, ' ').replace(/^\s*(?:\d+[.)]\s+|[-*•]\s+)/, '').replace(/^[\s"'`*]+|[\s"'`*]+$/g, '').trim();
      if (!s || s.length > 64 || !/[a-z0-9]/i.test(s)) return;
      var key = s.toLowerCase().replace(/[\s_-]+/g, '_');
      if (seen[key]) return;
      seen[key] = 1;
      out.push(s);
    });
    return out.slice(0, max || 40);
  }

  function parsePlannerOutput(text) {
    var t = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
    function pick(v) {
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') return v.keywords || v.queries || v.tags || v.search || null;
      return null;
    }
    var candidates = [t];
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b > a) candidates.push(t.slice(a, b + 1));
    var c = t.indexOf('['), d = t.lastIndexOf(']');
    if (c !== -1 && d > c) candidates.push(t.slice(c, d + 1));
    for (var i = 0; i < candidates.length; i++) {
      try {
        var v = pick(JSON.parse(candidates[i]));
        if (v && v.length) return { keywords: cleanKeywords(v), ok: true };
      } catch (_) {}
    }
    // JSON이 아니면 줄/쉼표 단위로 최대한 회수
    var loose = cleanKeywords(t.split(/[\n,]/).filter(function (s) { return /^[\x20-\x7e]+$/.test(s.trim()); }));
    return { keywords: loose, ok: false };
  }

  // 입력 문장에 포함된 영어/태그 표현 직접 추출 (Planner 보조 · 실패 시 대체)
  function extractInputTerms(input) {
    var s = String(input || '');
    var out = [];
    s.split(/[,\n]+/).forEach(function (seg) {
      var x = seg.trim();
      if (x && /^[\x20-\x7e]+$/.test(x) && /[a-z]/i.test(x) && x.length <= 64) out.push(x);
    });
    var m = s.match(/[A-Za-z0-9][A-Za-z0-9 _\-'.()]*[A-Za-z0-9)]/g) || [];
    m.forEach(function (x) { if (/[a-z]/i.test(x)) out.push(x.trim()); });
    return cleanKeywords(out, 30);
  }

  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  // ───────────────────────── 참조 블록 (§17) ─────────────────────────
  function formatReferenceBlock(cands) {
    if (!cands || !cands.length) return '';
    var lines = [
      '[REFERENCE TAG CANDIDATES]',
      '# content.csv 로컬 검색에서 이번 요청과 관련해 추린 후보입니다. 참고 자료이며, 사용자의 요구와 System Prompt가 우선합니다.',
      '# 형식: tag | cat | count | alias(검색이 alias로 매칭된 경우만) · cat: 0=general 1=artist 3=copyright 4=character 5=meta'
    ];
    cands.forEach(function (c) {
      var line = c.tag + ' | cat=' + c.category + ' | count=' + Math.round(c.count);
      if (c.alias && c.alias !== c.tag) line += ' | alias=' + c.alias;
      lines.push(line);
    });
    lines.push('[/REFERENCE TAG CANDIDATES]');
    return lines.join('\n');
  }

  // ───────────────────────── 대화 맥락 (§7, §16) ─────────────────────────
  /*
   * history: 현재 요청 이전의 메시지들 [{id, role, content, status}]
   * 반환: { messages, previousPrompt, previousPromptId, includedTurns, droppedTurns, recentRequests }
   */
  function assembleContext(o) {
    var history = o.history || [];
    var ctxOpt = o.context || {};
    var maxTurns = Math.max(1, Number(ctxOpt.maxTurns) || 12);
    var budget = Math.max(1000, Number(ctxOpt.charBudget) || 24000);

    // user → (완료된) assistant 쌍으로 묶는다. 실패/취소된 응답은 맥락에서 제외.
    var turns = [];
    var pendingUser = null;
    history.forEach(function (m) {
      if (m.role === 'user') pendingUser = m;
      else if (m.role === 'assistant' && pendingUser) {
        if (m.status === 'done' && m.content && m.content.trim()) {
          turns.push({ user: pendingUser, assistant: m });
          pendingUser = null;
        }
      }
    });
    var last = turns[turns.length - 1];
    var previousPrompt = last ? last.assistant.content : '';
    var vision = o.vision || {};
    function userContent(m, current) {
      var imgs = m.images || [];
      if (!imgs.length) return m.content;
      if (current || vision.resendHistoryImages) return buildUserContent(m.content, imgs, vision);
      return (m.content ? m.content + '\n' : '') + imageNote(imgs.length);
    }

    // 최신 턴부터 역순 채움. 직전 완성 프롬프트가 있는 마지막 턴은 예산과 무관하게 항상 포함.
    var picked = [];
    var used = 0;
    for (var i = turns.length - 1; i >= 0; i--) {
      var tt = turns[i];
      var size = tt.user.content.length + tt.assistant.content.length;
      if (i !== turns.length - 1 && (picked.length >= maxTurns || used + size > budget)) break;
      picked.unshift(tt);
      used += size;
    }

    var messages = [{ role: 'system', content: o.systemPrompt || '' }];
    if (o.referenceBlock) messages.push({ role: 'system', content: o.referenceBlock });
    picked.forEach(function (tt) {
      messages.push({ role: 'user', content: userContent(tt.user, false) });
      messages.push({ role: 'assistant', content: tt.assistant.content });
    });
    messages.push({ role: 'user', content: userContent({ content: o.input, images: o.images }, true) });

    return {
      messages: messages,
      previousPrompt: previousPrompt,
      previousPromptId: last ? last.assistant.id : null,
      includedTurns: picked.length,
      droppedTurns: turns.length - picked.length,
      historyChars: used,
      recentRequests: turns.slice(-3).map(function (t) { return t.user.content || (t.user.images && t.user.images.length ? '(image only)' : ''); }),
      imageCount: countImages(messages)
    };
  }

  // ───────────────────────── 출력 검증 (§18, §19) ─────────────────────────
  function promptLines(text) {
    return String(text || '').split(/\r?\n/).filter(function (l) {
      var s = l.trim();
      if (!s || /^```/.test(s)) return false;
      if (/^\[[^\]]{1,60}\]$/.test(s)) return false;          // [NAI 프롬프트], [Base Prompt]
      if (/^#{1,6}\s/.test(s)) return false;
      return true;
    }).map(function (l) {
      return l.replace(/^\s*(base|character|negative|undesired)\s*(prompt)?\s*\d*\s*[:：]\s*/i, '');
    });
  }

  function extractTagsFromOutput(text) {
    var tags = [];
    var special = 0;
    promptLines(text).forEach(function (line) {
      line.split(/[,|]/).forEach(function (piece) {
        var p = piece.trim();
        if (!p) return;
        p = p.replace(/^-?\d+(\.\d+)?::/, '').replace(/::$/, '');
        p = p.replace(/^[\s{}\[\]()]+|[\s{}\[\]()]+$/g, '');
        p = p.replace(/:-?\d+(\.\d+)?$/, ''); // (tag:1.2)
        if (!p) return;
        if (/^(source|target|mutual)#/i.test(p)) { special++; p = p.replace(/^(source|target|mutual)#/i, ''); if (!p) return; }
        if (/[^\x20-\x7e]/.test(p)) return;              // 비ASCII(설명문 등)는 태그 검사 제외
        if (p.split(/\s+/).length > 5) return;            // 자연어 구문은 태그 검사 제외
        tags.push(p);
      });
    });
    return { tags: tags, special: special };
  }

  function estimateTokens(text) {
    var body = promptLines(text).join('\n');
    var n = 0;
    var words = body.split(/[\s_]+/);
    for (var i = 0; i < words.length; i++) {
      var w = words[i].replace(/[^A-Za-z0-9가-힣]/g, '');
      if (!w) continue;
      n += /[가-힣]/.test(w) ? w.length : Math.max(1, Math.ceil(w.length / 5));
    }
    var punct = body.match(/[,.:;()\[\]{}|#!?\-]/g);
    return n + (punct ? punct.length : 0);
  }

  function validateOutput(text, o) {
    o = o || {};
    var issues = [];
    var s = String(text || '');
    if (!s.trim()) { issues.push({ level: 'error', code: 'EMPTY_RESPONSE', message: '빈 응답입니다.' }); return issues; }
    if (/^\s*(\{\s*"error"|error\s*[:：]|<!doctype html|<html|rate limit|internal server error|unauthorized|forbidden|bad gateway|service unavailable)/i.test(s) ||
        /"error"\s*:\s*\{\s*"(message|code|type)"/.test(s)) {
      issues.push({ level: 'warn', code: 'ERROR_TEXT', message: 'API 오류 문구가 응답에 섞여 있을 수 있습니다.' });
    }
    if (s.length > (o.maxChars || 6000)) issues.push({ level: 'warn', code: 'TOO_LONG', message: '응답이 매우 깁니다 (' + s.length.toLocaleString() + '자).' });

    var ex = extractTagsFromOutput(s);
    var counts = Object.create(null);
    ex.tags.forEach(function (t) { var k = t.toLowerCase().replace(/[\s_]+/g, ' '); counts[k] = (counts[k] || 0) + 1; });
    var keys = Object.keys(counts);
    var dupTotal = ex.tags.length - keys.length;
    if (ex.tags.length >= 8 && dupTotal / ex.tags.length > 0.15) {
      issues.push({ level: 'warn', code: 'DUPLICATE_RATIO', message: '중복 태그 비율이 높습니다 (' + Math.round(100 * dupTotal / ex.tags.length) + '%).' });
    }
    var repeated = keys.filter(function (k) { return counts[k] >= 3; });
    if (repeated.length) issues.push({ level: 'warn', code: 'REPEATED_TAG', message: '같은 태그가 3회 이상 반복됨: ' + repeated.slice(0, 8).join(', ') });

    if (o.lookupResults) {
      var unknown = [], aliasUsed = [];
      o.lookupResults.forEach(function (r) {
        if (r.status === 'unknown') unknown.push(r.input);
        else if (r.status === 'alias') aliasUsed.push(r.input + ' → ' + r.tag);
      });
      if (aliasUsed.length) issues.push({ level: 'info', code: 'ALIAS_USED', message: 'alias 표기 사용 (정식 태그 권장): ' + aliasUsed.slice(0, 10).join(', ') });
      if (unknown.length) issues.push({ level: 'info', code: 'NOT_IN_CSV', message: 'CSV에 없는 항목 ' + unknown.length + '개 (자연어·특수 문법일 수 있음): ' + unknown.slice(0, 15).join(', ') + (unknown.length > 15 ? ' …' : '') });
    }

    var est = estimateTokens(s);
    if (o.tokenLimit && est > o.tokenLimit) {
      issues.push({ level: 'warn', code: 'TOKEN_ESTIMATE', message: '추정 토큰 ≈' + est + ' (기준 ' + o.tokenLimit + ' 초과 가능, 정확한 NAI 토큰 수 아님)' });
    }
    return issues;
  }

  // ───────────────────────── 지시사항 점검 (§3.1) ─────────────────────────
  function lineOf(text, index) { return text.slice(0, index).split('\n').length; }

  function lintSystemPrompt(text) {
    var s = String(text || '');
    var out = [];
    if (!s.trim()) { out.push({ level: 'warn', message: 'System Prompt가 비어 있습니다.' }); return out; }

    var versions = Object.create(null);
    var res = [
      /(?:NAI|NovelAI|Novel\s*AI|노벨\s*AI)\s*(?:Diffusion\s*)?(?:V|v|ver\.?|version|버전)?\s*([1-9](?:\.\d)?)(?![\d.])/g,
      /\bV([1-9](?:\.\d)?)\s*(?:Full|Curated|Furry)\b/gi,
      /(?:NAI|NovelAI|노벨\s*AI)[^\n]{0,20}?([1-9](?:\.\d)?)\s*(?:버전|계열|모델|Full|Curated)/g
    ];
    res.forEach(function (re) {
      var m;
      while ((m = re.exec(s))) {
        var v = m[1];
        var ln = lineOf(s, m.index);
        var arr = versions[v] = versions[v] || [];
        if (arr.indexOf(ln) === -1) arr.push(ln);
      }
    });
    var vk = Object.keys(versions);
    var majors = Object.create(null);
    vk.forEach(function (v) { majors[v] = 1; });
    if (Object.keys(majors).length > 1) {
      out.push({
        level: 'warn',
        message: 'NAI 버전 표기가 여러 개입니다: ' + vk.map(function (v) { return v + ' (' + versions[v].slice(0, 3).map(function (l) { return l + '행'; }).join(', ') + ')'; }).join(' / ') + '. 어떤 버전 기준인지 확인하세요.'
      });
    }

    var codeRe = /code[_ ]?execution|code\s*interpreter|코드\s*(실행|인터프리터)|파이썬(으로)?\s*(실행|계산)|python\s*(tool|으로|로)/i;
    var cm = codeRe.exec(s);
    if (cm) out.push({ level: 'warn', message: '"' + cm[0] + '" (' + lineOf(s, cm.index) + '행): 일반 Chat Completions API 모델에는 코드 실행 도구가 없어 이 지시를 그대로 수행할 수 없습니다. 앱은 토큰 수를 추정치로만 표시합니다.' });

    var tokRe = /(정확한|exact)\s*(NAI\s*)?(토큰|token)/i;
    var tm = tokRe.exec(s);
    if (tm) out.push({ level: 'warn', message: '"' + tm[0] + '" (' + lineOf(s, tm.index) + '행): NAI 토크나이저가 없으면 정확한 토큰 수를 보장할 수 없습니다.' });

    var webRe = /web\s*search|browsing|웹\s*검색|인터넷\s*검색/i;
    var wm = webRe.exec(s);
    if (wm) out.push({ level: 'info', message: '"' + wm[0] + '" (' + lineOf(s, wm.index) + '행): 이 앱은 모델에 웹 검색 도구를 제공하지 않습니다.' });

    var fileRe = /content\.csv|첨부(된)?\s*(파일|csv)|업로드(된|한)?\s*(파일|csv)/i;
    var fm = fileRe.exec(s);
    if (fm) out.push({ level: 'info', message: '"' + fm[0] + '" (' + lineOf(s, fm.index) + '행): 앱은 CSV 전체가 아니라 검색된 후보만 [REFERENCE TAG CANDIDATES] 블록으로 전달합니다.' });

    if (s.length > 40000) out.push({ level: 'info', message: 'System Prompt가 ' + s.length.toLocaleString() + '자입니다. 매 요청에 포함되므로 비용이 커질 수 있습니다.' });
    return out;
  }

  // ───────────────────────── 권장 설정 점검 (§13) ─────────────────────────
  function checkRecommended(settings, env) {
    env = env || {};
    var out = [];
    var api = settings.api || {}, proxy = settings.proxy || {}, g = settings.generation || {};
    function add(level, message) { out.push({ level: level, message: message }); }
    var apiUrl = resolveApiUrl(api.url, api.mode);
    var apiKind = hostKind(apiUrl);

    if (!String(api.url || '').trim()) add(proxy.enabled ? 'warn' : 'error', proxy.enabled ? 'API URL(원본 엔드포인트)이 비어 있습니다. 프록시가 원본 주소를 헤더로 받는 구조라면 필요합니다.' : 'API URL이 비어 있습니다.');
    else if (apiKind === 'invalid') add('error', 'API URL 형식이 올바르지 않습니다.');
    else if (api.mode !== 'raw' && apiUrl !== String(api.url).trim()) add('info', 'API URL이 자동 감지로 보정되어 호출됩니다: ' + apiUrl);
    if (!String(api.modelId || '').trim()) add('error', '모델 ID가 비어 있습니다.');
    if (/^\s*Bearer\s+/i.test(api.apiKey || '')) add('info', 'API 키 앞의 "Bearer "는 자동으로 제거됩니다.');

    if (proxy.enabled) {
      var pk = hostKind(proxy.url);
      if (!String(proxy.url || '').trim()) add('error', '프록시가 켜져 있지만 프록시 URL이 비어 있습니다.');
      else if (pk === 'invalid') add('error', '프록시 URL 형식이 올바르지 않습니다.');
      if (!String(proxy.token || '').trim()) add('warn', '프록시 토큰이 비어 있습니다. 인증이 필요 없는 프록시가 아니라면 입력하세요.');
      if (String(proxy.url || '').trim() && String(proxy.url).trim().replace(/\/+$/, '') === String(api.url || '').trim().replace(/\/+$/, '')) add('warn', '프록시 URL과 API URL이 같습니다. 프록시 주소가 맞는지 확인하세요.');
      if (isLocalKind(apiKind)) add('info', '로컬 엔드포인트인데 프록시를 사용 중입니다. 로컬 서버는 보통 직접 호출(프록시 OFF)이 가능합니다.');
      if (api.apiKey && !proxy.forwardApiKey) add('info', '프록시 ON: 원본 API 키는 전송하지 않습니다. 프록시가 원본 키를 요구한다면 "원본 API 키도 전달"을 켜세요.');
    } else {
      if (apiKind === 'remote' && !String(api.apiKey || '').trim() && !api.allowNoKey) add('error', '원격 서버인데 API 키가 비어 있습니다. 키가 필요 없는 서버라면 "API 키 없음 허용"을 켜세요.');
      if (isLocalKind(apiKind) && !String(api.apiKey || '').trim()) add('ok', 'API 키 없음 — 로컬 엔드포인트로 정상 처리 (Authorization 헤더 생략)');
      if (env.pageProtocol === 'https:' && /^http:/i.test(apiUrl) && apiKind !== 'loopback') add('warn', 'HTTPS 페이지에서 HTTP 주소(' + apiKind + ')는 브라우저가 차단합니다. HTTPS/프록시를 쓰거나 앱을 http로 여세요.');
      if (apiKind === 'remote' && env.pageProtocol && env.pageProtocol !== 'file:') add('info', '원격 API를 브라우저에서 직접 호출하면 CORS로 막힐 수 있습니다. 막히면 프록시를 사용하세요.');
    }

    if (g.useMaxTokens && Number(g.maxTokens) > 0 && Number(g.maxTokens) < 400) add('warn', '최대 출력 토큰이 ' + g.maxTokens + '로 작아 프롬프트가 잘릴 수 있습니다.');
    if (g.extraBody && String(g.extraBody).trim()) { var eb = parseExtraBody(g.extraBody); if (eb.error) add('error', '추가 body JSON 오류: ' + eb.error); }
    if (!g.stream) add('info', '스트리밍이 꺼져 있습니다. 응답이 끝날 때까지 출력이 보이지 않습니다.');
    if (env.referenceLoaded === false) add('info', '참조 CSV가 없습니다. 태그 후보 없이 생성됩니다.');
    if (settings.planner && settings.planner.enabled === false) add('info', 'Query Planner가 꺼져 있어 한국어 요청의 태그 검색 품질이 낮을 수 있습니다.');
    if (!out.some(function (x) { return x.level === 'error' || x.level === 'warn'; })) add('ok', '필수 설정에 문제가 없습니다.');
    return out;
  }

  // 대화 제목 (별도 API 호출 없이)
  function makeTitle(input) {
    var s = String(input || '').replace(/\s+/g, ' ').trim();
    if (!s) return arguments[1] ? '이미지 분석' : '새 대화';
    var chars = Array.from(s);
    return chars.length > 28 ? chars.slice(0, 28).join('') + '…' : s;
  }

  return {
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    PLANNER_SYSTEM: PLANNER_SYSTEM,
    ERROR_TEXT: ERROR_TEXT,
    clone: clone, mergeDefaults: mergeDefaults, exportSettings: exportSettings,
    PRESET_KEYS: PRESET_KEYS, presetFromSettings: presetFromSettings, applyPreset: applyPreset,
    findPromptPreset: findPromptPreset, makePromptPreset: makePromptPreset, ensurePromptPresets: ensurePromptPresets,
    selectPromptPreset: selectPromptPreset, chatPromptStatus: chatPromptStatus,
    presetMatches: presetMatches, findPreset: findPreset,
    parseUrl: parseUrl, hostKind: hostKind, isLocalKind: isLocalKind,
    resolveApiUrl: resolveApiUrl, modelsUrlFrom: modelsUrlFrom, stripBearer: stripBearer,
    resolveTarget: resolveTarget, autoTokenParam: autoTokenParam, providerOf: providerOf,
    buildBody: buildBody, parseExtraBody: parseExtraBody, normalizeMessages: normalizeMessages,
    buildUserContent: buildUserContent, contentText: contentText, countImages: countImages,
    mkErr: mkErr, classifyHttpError: classifyHttpError, extractErrorMessage: extractErrorMessage,
    redact: redact, secretsOf: secretsOf, diagnoseFetchFailure: diagnoseFetchFailure,
    createSSEParser: createSSEParser, parseCompletionJSON: parseCompletionJSON, callChat: callChat,
    buildPlannerMessages: buildPlannerMessages, parsePlannerOutput: parsePlannerOutput,
    extractInputTerms: extractInputTerms, cleanKeywords: cleanKeywords, hashString: hashString,
    formatReferenceBlock: formatReferenceBlock, assembleContext: assembleContext,
    promptLines: promptLines, extractTagsFromOutput: extractTagsFromOutput, estimateTokens: estimateTokens,
    validateOutput: validateOutput, lintSystemPrompt: lintSystemPrompt, checkRecommended: checkRecommended,
    makeTitle: makeTitle
  };
});
