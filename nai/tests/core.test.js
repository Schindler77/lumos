'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const C = require('../js/core.js');

function settings(patch) {
  const s = C.mergeDefaults(patch || {});
  return s;
}

// ───────── URL / 대상 / 인증 ─────────
test('resolveApiUrl 자동 감지', () => {
  assert.equal(C.resolveApiUrl('http://localhost:1234', 'auto'), 'http://localhost:1234/v1/chat/completions');
  assert.equal(C.resolveApiUrl('http://localhost:1234/v1/', 'auto'), 'http://localhost:1234/v1/chat/completions');
  assert.equal(C.resolveApiUrl('https://api.openai.com/v1/chat/completions', 'auto'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(C.resolveApiUrl('https://generativelanguage.googleapis.com/v1beta/openai', 'auto'), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(C.resolveApiUrl('https://x.com/custom/path', 'auto'), 'https://x.com/custom/path');
  assert.equal(C.resolveApiUrl('http://localhost:1234', 'raw'), 'http://localhost:1234');
  assert.equal(C.modelsUrlFrom('http://localhost:1234/v1/chat/completions'), 'http://localhost:1234/v1/models');
});

test('hostKind', () => {
  assert.equal(C.hostKind('http://localhost:1234/v1'), 'loopback');
  assert.equal(C.hostKind('http://127.0.0.1:1234/v1'), 'loopback');
  assert.equal(C.hostKind('http://[::1]:1234/v1'), 'loopback');
  assert.equal(C.hostKind('http://192.168.0.10:1234/v1'), 'private');
  assert.equal(C.hostKind('http://172.20.1.1/v1'), 'private');
  assert.equal(C.hostKind('https://api.openai.com/v1'), 'remote');
  assert.equal(C.hostKind('not a url'), 'invalid');
});

test('로컬 + 키 없음 → Authorization 헤더 생략 (빈 Bearer 금지)', () => {
  const t = C.resolveTarget(settings({ api: { url: 'http://localhost:1234/v1', modelId: 'm', apiKey: '' } }));
  assert.equal(t.error, null);
  assert.equal(t.endpointKind, 'local');
  assert.equal('Authorization' in t.headers, false);
  assert.equal(t.credential, 'none');
});

test('원격 + 키 없음 → CONFIG_ERROR, allowNoKey면 허용', () => {
  const t = C.resolveTarget(settings({ api: { url: 'https://api.example.com/v1', modelId: 'm' } }));
  assert.equal(t.error.code, 'CONFIG_ERROR');
  const t2 = C.resolveTarget(settings({ api: { url: 'https://api.example.com/v1', modelId: 'm', allowNoKey: true } }));
  assert.equal(t2.error, null);
  assert.equal('Authorization' in t2.headers, false);
});

test('API 키 → Bearer (중복 Bearer 접두어 제거)', () => {
  const t = C.resolveTarget(settings({ api: { url: 'https://api.example.com/v1', apiKey: 'Bearer sk-abc123' } }));
  assert.equal(t.headers.Authorization, 'Bearer sk-abc123');
  assert.equal(t.credential, 'api-key');
});

test('프록시 ON → 프록시 URL + 프록시 토큰, 원본 키 미전송, 원본 URL 보존', () => {
  const s = settings({
    api: { url: 'https://api.example.com/v1', apiKey: 'sk-original-key', modelId: 'gpt-x' },
    proxy: { enabled: true, url: 'https://p.workers.dev/v1/chat/completions', token: 'proxy-tok' }
  });
  const t = C.resolveTarget(s);
  assert.equal(t.url, 'https://p.workers.dev/v1/chat/completions');
  assert.equal(t.headers.Authorization, 'Bearer proxy-tok');
  assert.equal(t.headers['X-Lumos-Proxy-Token'], 'proxy-tok');
  assert.equal(t.headers['X-Lumos-Upstream-Url'], 'https://api.example.com/v1/chat/completions');
  assert.ok(!JSON.stringify(t.headers).includes('sk-original-key'));
  assert.equal(s.api.url, 'https://api.example.com/v1'); // 원본 설정 보존
  const { body } = C.buildBody(s, [{ role: 'user', content: 'x' }], {});
  assert.equal(body.model, 'gpt-x');
  s.proxy.forwardApiKey = true;
  assert.equal(C.resolveTarget(s).headers['X-Lumos-Upstream-Authorization'], 'Bearer sk-original-key');
});

test('프록시 ON + URL 없음 → CONFIG_ERROR', () => {
  const t = C.resolveTarget(settings({ proxy: { enabled: true, url: '' } }));
  assert.equal(t.error.code, 'CONFIG_ERROR');
});

// ───────── body ─────────
test('buildBody: 토큰 파라미터 자동, 미설정 값 미전송', () => {
  let r = C.buildBody(settings({ api: { modelId: 'gpt-4o-mini' } }), [], {});
  assert.equal(r.body.max_tokens, 2048);
  assert.equal('reasoning_effort' in r.body, false);
  assert.equal('temperature' in r.body, false);
  r = C.buildBody(settings({ api: { modelId: 'gpt-5-mini' } }), [], {});
  assert.equal(r.body.max_completion_tokens, 2048);
  assert.equal('max_tokens' in r.body, false);
  r = C.buildBody(settings({ api: { modelId: 'x' }, generation: { tokenParam: 'none' } }), [], {});
  assert.equal(Object.keys(r.body).filter((k) => /max/.test(k)).length, 0);
  r = C.buildBody(settings({ api: { modelId: 'x' }, generation: { useMaxTokens: false } }), [], {});
  assert.equal('max_tokens' in r.body, false);
});

test('buildBody: reasoning / thinking / extraBody', () => {
  let r = C.buildBody(settings({ api: { modelId: 'gemini-3-pro' }, generation: { reasoningEffort: 'low', thinkingLevel: 'high' } }), [], {});
  assert.equal(r.body.reasoning_effort, 'low');
  assert.equal(r.body.extra_body.google.thinking_config.thinking_level, 'high');
  r = C.buildBody(settings({ api: { modelId: 'claude-sonnet' }, generation: { thinkingBudget: 2000 } }), [], {});
  assert.deepEqual(r.body.thinking, { type: 'enabled', budget_tokens: 2000 });
  r = C.buildBody(settings({ api: { modelId: 'qwen' }, generation: { thinkingBudget: 2000 } }), [], {});
  assert.equal('thinking' in r.body, false);
  assert.ok(r.notes.length > 0);
  r = C.buildBody(settings({ api: { modelId: 'q' }, generation: { extraBody: '{"top_p":0.5,"stream":true}' } }), [], { stream: false });
  assert.equal(r.body.top_p, 0.5);
  assert.equal(r.body.stream, false);
  assert.throws(() => C.buildBody(settings({ generation: { extraBody: '{bad' } }), [], {}), (e) => e.code === 'CONFIG_ERROR');
});

test('normalizeMessages 호환 옵션', () => {
  const msgs = [
    { role: 'system', content: 'S1' }, { role: 'system', content: 'REF' },
    { role: 'assistant', content: 'A0' }, { role: 'user', content: 'U1' }, { role: 'user', content: 'U2' }
  ];
  let out = C.normalizeMessages(msgs, { hasFirstSystemPrompt: true });
  assert.equal(out.filter((m) => m.role === 'system').length, 1);
  assert.equal(out[0].content, 'S1\n\nREF');
  out = C.normalizeMessages(msgs, { hasFirstSystemPrompt: true, mustStartWithUserInput: true, requiresAlternateRole: true });
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(out[3].content, 'U1\n\nU2');
  out = C.normalizeMessages(msgs, { systemAsUser: true });
  assert.equal(out.some((m) => m.role === 'system'), false);
  assert.equal(out[0].role, 'user');
});

// ───────── 오류 ─────────
test('classifyHttpError', () => {
  assert.equal(C.classifyHttpError(401, '{"error":{"message":"bad key"}}').code, 'AUTH_FAILED');
  assert.equal(C.classifyHttpError(403, '').code, 'AUTH_FAILED');
  assert.equal(C.classifyHttpError(404, 'Not Found').code, 'ENDPOINT_NOT_FOUND');
  assert.equal(C.classifyHttpError(404, '{"error":{"message":"The model `x` does not exist"}}').code, 'MODEL_NOT_FOUND');
  assert.equal(C.classifyHttpError(400, '{"error":{"message":"model not found: foo"}}').code, 'MODEL_NOT_FOUND');
  assert.equal(C.classifyHttpError(429, '').code, 'RATE_LIMITED');
  assert.equal(C.classifyHttpError(502, '').code, 'PROVIDER_5XX');
  assert.equal(C.classifyHttpError(400, '{"error":"unsupported parameter"}').code, 'BAD_REQUEST');
});

test('redact: 키/토큰 마스킹', () => {
  const s = C.redact('auth Bearer sk-secret-123456 and proxy-token-xyz', ['proxy-token-xyz']);
  assert.ok(!s.includes('sk-secret-123456'));
  assert.ok(!s.includes('proxy-token-xyz'));
});

test('diagnoseFetchFailure: CORS / 네트워크 / 혼합콘텐츠 구분', async () => {
  const cors = await C.diagnoseFetchFailure('https://api.example.com/v1', () => Promise.resolve({ type: 'opaque' }), 'https:');
  assert.equal(cors.code, 'CORS_BLOCKED');
  const net = await C.diagnoseFetchFailure('https://api.example.com/v1', () => Promise.reject(new TypeError('x')), 'https:');
  assert.equal(net.code, 'NETWORK_ERROR');
  const mixed = await C.diagnoseFetchFailure('http://192.168.0.2:1234/v1', () => Promise.resolve({}), 'https:');
  assert.equal(mixed.code, 'MIXED_CONTENT');
  const loop = await C.diagnoseFetchFailure('http://localhost:1234/v1', () => Promise.resolve({}), 'https:');
  assert.equal(loop.code, 'CORS_BLOCKED');
});

// ───────── SSE ─────────
test('SSE 파서: 청크 경계, 주석, 다중 data, CRLF', () => {
  const got = [];
  const p = C.createSSEParser((d) => got.push(d));
  p.push(': keep-alive\n\nda');
  p.push('ta: {"a":1}\r\n\r\ndata: x\ndata: y\n\ndata: [DONE]');
  p.end();
  assert.deepEqual(got, ['{"a":1}', 'x\ny', '[DONE]']);
});

// ───────── 실제 HTTP 호출 (모의 서버) ─────────
function startServer(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const rec = { headers: req.headers, body: body ? JSON.parse(body) : null, url: req.url };
        seen.push(rec);
        handler(req, res, rec);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: 'http://127.0.0.1:' + srv.address().port + '/v1' }));
  });
}

function sse(res, pieces, opts) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let i = 0;
  const tick = () => {
    if (i < pieces.length) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] }) + '\n\n');
      setTimeout(tick, (opts && opts.delay) || 5);
    } else {
      if (!(opts && opts.noDone)) res.write('data: [DONE]\n\n');
      res.end();
    }
  };
  if (opts && opts.malformed) res.write('data: {not json\n\n');
  tick();
}

test('callChat: 로컬 no-key 스트리밍 성공, Authorization 헤더 없음', async () => {
  const { srv, seen, url } = await startServer((req, res) => sse(res, ['1girl', ', solo', ', smile'], { malformed: true }));
  try {
    const deltas = [];
    const r = await C.callChat({ settings: settings({ api: { url, modelId: 'local-model' } }), messages: [{ role: 'user', content: 'hi' }], onDelta: (p) => deltas.push(p) });
    assert.equal(r.text, '1girl, solo, smile');
    assert.equal(r.streamed, true);
    assert.equal(r.malformed, 1);
    assert.equal(r.endpointKind, 'local');
    assert.equal(seen[0].headers.authorization, undefined);
    assert.equal(seen[0].body.model, 'local-model');
    assert.equal(seen[0].body.stream, true);
    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.deepEqual(deltas, ['1girl', ', solo', ', smile']);
  } finally { srv.close(); }
});

test('callChat: 취소 → CANCELLED + 부분 출력', async () => {
  const { srv, url } = await startServer((req, res) => sse(res, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], { delay: 60 }));
  try {
    const ctrl = new AbortController();
    const p = C.callChat({ settings: settings({ api: { url, modelId: 'm' } }), messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal, onDelta: (_, full) => { if (full.length >= 2) ctrl.abort(); } });
    await assert.rejects(p, (e) => e.code === 'CANCELLED' && e.partial.startsWith('ab'));
  } finally { srv.close(); }
});

test('callChat: 401 → AUTH_FAILED, 키가 오류에 노출되지 않음', async () => {
  const { srv, url } = await startServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: ' + req.headers.authorization } }));
  });
  try {
    await assert.rejects(
      C.callChat({ settings: settings({ api: { url, modelId: 'm', apiKey: 'sk-very-secret-key-123' } }), messages: [{ role: 'user', content: 'x' }] }),
      (e) => e.code === 'AUTH_FAILED' && e.status === 401 && !String(e.detail).includes('sk-very-secret-key-123') && !String(e.bodyText).includes('sk-very-secret-key-123')
    );
  } finally { srv.close(); }
});

test('callChat: 404 모델 → MODEL_NOT_FOUND, 500 → PROVIDER_5XX, 429 → RATE_LIMITED', async () => {
  let mode = 404;
  const { srv, url } = await startServer((req, res) => {
    res.writeHead(mode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: mode === 404 ? 'model "nope" not found' : 'oops' } }));
  });
  try {
    const s = settings({ api: { url, modelId: 'nope' } });
    await assert.rejects(C.callChat({ settings: s, messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'MODEL_NOT_FOUND');
    mode = 500;
    await assert.rejects(C.callChat({ settings: s, messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'PROVIDER_5XX');
    mode = 429;
    await assert.rejects(C.callChat({ settings: s, messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'RATE_LIMITED');
  } finally { srv.close(); }
});

test('callChat: 스트리밍 거부(400) → 일반 요청 재시도', async () => {
  const { srv, seen, url } = await startServer((req, res, rec) => {
    if (rec.body.stream) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"stream not supported"}}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'plain result' }, finish_reason: 'stop' }] }));
  });
  try {
    const r = await C.callChat({ settings: settings({ api: { url, modelId: 'm' } }), messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.text, 'plain result');
    assert.equal(r.streamFallback, true);
    assert.equal(seen.length, 2);
  } finally { srv.close(); }
});

test('callChat: stream 요청에 JSON 응답이 와도 처리', async () => {
  const { srv, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'json body' } }] }));
  });
  try {
    const r = await C.callChat({ settings: settings({ api: { url, modelId: 'm' } }), messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.text, 'json body');
    assert.equal(r.streamed, false);
  } finally { srv.close(); }
});

test('callChat: 스트림 중 error 이벤트 → PROVIDER_5XX', async () => {
  const { srv, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'part' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ error: { message: 'overloaded' } }) + '\n\n');
    res.end();
  });
  try {
    await assert.rejects(C.callChat({ settings: settings({ api: { url, modelId: 'm' } }), messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'PROVIDER_5XX' && e.partial === 'part');
  } finally { srv.close(); }
});

test('callChat: 타임아웃 → TIMEOUT', async () => {
  const { srv, url } = await startServer(() => { /* 응답하지 않음 */ });
  try {
    await assert.rejects(C.callChat({ settings: settings({ api: { url, modelId: 'm' } }), messages: [{ role: 'user', content: 'x' }], timeoutMs: 200 }), (e) => e.code === 'TIMEOUT');
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('callChat: 프록시 경유 헤더와 model 유지', async () => {
  const { srv, seen, url } = await startServer((req, res) => sse(res, ['ok']));
  try {
    const s = settings({
      api: { url: 'https://api.example.com/v1', apiKey: 'sk-upstream-key', modelId: 'orig-model' },
      proxy: { enabled: true, url: url + '/chat/completions', token: 'ptoken' }
    });
    const r = await C.callChat({ settings: s, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.text, 'ok');
    assert.equal(r.endpointKind, 'proxy');
    assert.equal(seen[0].headers.authorization, 'Bearer ptoken');
    assert.equal(seen[0].headers['x-lumos-proxy-token'], 'ptoken');
    assert.equal(seen[0].body.model, 'orig-model');
    assert.ok(!JSON.stringify(seen[0].headers).includes('sk-upstream-key'));
  } finally { srv.close(); }
});

// ───────── Planner / 맥락 / 검증 / 점검 ─────────
test('parsePlannerOutput: JSON, 코드펜스, think, 배열, 비JSON 복구', () => {
  assert.deepEqual(C.parsePlannerOutput('{"keywords":["desk","head down"]}').keywords, ['desk', 'head down']);
  assert.deepEqual(C.parsePlannerOutput('<think>hmm</think>```json\n{"keywords":["a b","a_b","c"]}\n```').keywords, ['a b', 'c']);
  assert.deepEqual(C.parsePlannerOutput('Sure! ["x", "y"]').keywords, ['x', 'y']);
  const loose = C.parsePlannerOutput('desk, head down\nbent arms');
  assert.equal(loose.ok, false);
  assert.deepEqual(loose.keywords, ['desk', 'head down', 'bent arms']);
  const pm = C.buildPlannerMessages('책상', { previousPrompt: '1girl, desk' });
  assert.equal(pm[0].role, 'system');
  assert.ok(pm[1].content.includes('1girl, desk'));
});

test('extractInputTerms', () => {
  const t = C.extractInputTerms('미사에가 beach에서 1girl, smile 상태');
  assert.ok(t.includes('beach'));
  assert.ok(t.some((x) => /1girl/.test(x)));
});

test('assembleContext: 직전 완성 프롬프트 보존, 취소/오류 제외, 예산 초과 시 오래된 턴부터 제거', () => {
  const big = 'x'.repeat(3000);
  const history = [
    { id: 'u1', role: 'user', content: 'old ' + big },
    { id: 'a1', role: 'assistant', content: 'OLD PROMPT ' + big, status: 'done' },
    { id: 'u2', role: 'user', content: '해변 장면' },
    { id: 'a2', role: 'assistant', content: 'FINAL PROMPT', status: 'done' },
    { id: 'u3', role: 'user', content: '복장 변경' },
    { id: 'a3', role: 'assistant', content: 'partial…', status: 'cancelled' }
  ];
  const ctx = C.assembleContext({ systemPrompt: 'SYS', referenceBlock: 'REF', history, input: '표정 유지', context: { maxTurns: 12, charBudget: 2000 } });
  assert.equal(ctx.previousPrompt, 'FINAL PROMPT');
  assert.equal(ctx.previousPromptId, 'a2');
  assert.equal(ctx.droppedTurns, 1);
  const contents = ctx.messages.map((m) => m.content);
  assert.equal(ctx.messages[0].content, 'SYS');
  assert.equal(ctx.messages[1].content, 'REF');
  assert.ok(contents.includes('FINAL PROMPT'));
  assert.ok(!contents.some((c) => c.includes('partial')));
  assert.ok(!contents.some((c) => c.startsWith('OLD PROMPT')));
  assert.equal(ctx.messages[ctx.messages.length - 1].content, '표정 유지');
  // 마지막 턴은 예산보다 커도 항상 포함
  const ctx2 = C.assembleContext({ systemPrompt: 'S', history: [{ id: 'u', role: 'user', content: 'a' }, { id: 'a', role: 'assistant', content: big + big, status: 'done' }], input: 'q', context: { charBudget: 1000 } });
  assert.equal(ctx2.includedTurns, 1);
});

test('formatReferenceBlock: 매칭된 alias만 표시', () => {
  const b = C.formatReferenceBlock([{ tag: 'head_down', category: 0, count: 23000 }, { tag: '1girl', category: 0, count: 6008644, alias: '1girls' }]);
  assert.ok(b.startsWith('[REFERENCE TAG CANDIDATES]'));
  assert.ok(b.includes('head_down | cat=0 | count=23000\n'));
  assert.ok(b.includes('1girl | cat=0 | count=6008644 | alias=1girls'));
  assert.ok(b.endsWith('[/REFERENCE TAG CANDIDATES]'));
  assert.equal(C.formatReferenceBlock([]), '');
});

test('extractTagsFromOutput: 헤더/가중치/특수 문법/자연어 처리', () => {
  const out = '[NAI 프롬프트]\n1girl, 1.2::smile::, {blue hair}, source#hug, a girl sitting quietly by the window at night\n[Character Prompt 1]\ntarget#hug, 한국어 설명';
  const r = C.extractTagsFromOutput(out);
  assert.deepEqual(r.tags, ['1girl', 'smile', 'blue hair', 'hug', 'hug']);
  assert.equal(r.special, 2);
});

test('validateOutput: 빈 응답, 오류 문구, 반복, CSV 미존재(경고만)', () => {
  assert.equal(C.validateOutput('   ')[0].code, 'EMPTY_RESPONSE');
  assert.ok(C.validateOutput('{"error": {"message": "bad"}}').some((x) => x.code === 'ERROR_TEXT'));
  const rep = C.validateOutput('smile, smile, smile, 1girl, a, b, c, d, e');
  assert.ok(rep.some((x) => x.code === 'REPEATED_TAG'));
  const lk = C.validateOutput('1girl, foo', { lookupResults: [{ input: '1girl', status: 'tag', tag: '1girl' }, { input: 'foo', status: 'unknown' }] });
  const nic = lk.find((x) => x.code === 'NOT_IN_CSV');
  assert.equal(nic.level, 'info');
  const tok = C.validateOutput(Array(400).fill('long tag name').join(', '), { tokenLimit: 700 });
  assert.ok(tok.some((x) => x.code === 'TOKEN_ESTIMATE' && /추정/.test(x.message)));
});

test('lintSystemPrompt: 버전 충돌과 code_execution 경고, 원문 불변', () => {
  const sp = 'NAI 5 계열 기준으로 작성\n...\nNAI Diffusion V4.5 Full 기준\n토큰 수는 code_execution으로 정확한 토큰 수를 센다';
  const copy = sp.slice();
  const r = C.lintSystemPrompt(sp);
  assert.ok(r.some((x) => x.level === 'warn' && /버전/.test(x.message)));
  assert.ok(r.some((x) => /code_execution/.test(x.message)));
  assert.ok(r.some((x) => /정확한 토큰/.test(x.message)));
  assert.equal(sp, copy);
  assert.equal(C.lintSystemPrompt(C.DEFAULT_SYSTEM_PROMPT).filter((x) => x.level === 'warn').length, 0);
  assert.equal(C.makeTitle('', 1), '이미지 분석');
});

test('checkRecommended', () => {
  const r = C.checkRecommended(settings({ proxy: { enabled: true, url: '' } }));
  assert.ok(r.some((x) => x.level === 'error' && /프록시 URL/.test(x.message)));
  assert.ok(r.some((x) => x.level === 'error' && /모델 ID/.test(x.message)));
  const local = C.checkRecommended(settings({ api: { url: 'http://localhost:1234/v1', modelId: 'm' } }));
  assert.ok(local.some((x) => x.level === 'ok' && /로컬 엔드포인트/.test(x.message)));
  assert.ok(!local.some((x) => x.level === 'error'));
  const same = C.checkRecommended(settings({ api: { url: 'https://a.com/v1', modelId: 'm' }, proxy: { enabled: true, url: 'https://a.com/v1', token: 't' } }));
  assert.ok(same.some((x) => /같습니다/.test(x.message)));
  const remote = C.checkRecommended(settings({ api: { url: 'https://a.com/v1', modelId: 'm' } }));
  assert.ok(remote.some((x) => x.level === 'error' && /API 키/.test(x.message)));
});

test('exportSettings: 기본은 키 제외', () => {
  const s = settings({ api: { apiKey: 'sk-1' }, proxy: { token: 'pt' } });
  const e = C.exportSettings(s, false);
  assert.equal(e.api.apiKey, '');
  assert.equal(e.proxy.token, '');
  assert.equal(C.exportSettings(s, true).api.apiKey, 'sk-1');
  assert.equal(s.api.apiKey, 'sk-1');
});

// ───────── 이미지 입력 (비전) ─────────
const IMG = { id: 'i1', dataUrl: 'data:image/jpeg;base64,AAAA', width: 10, height: 10 };

test('buildUserContent: 이미지 없으면 문자열, 있으면 content parts', () => {
  assert.equal(C.buildUserContent('hi', []), 'hi');
  const c = C.buildUserContent('분석해줘', [IMG], { detail: '' });
  assert.deepEqual(c, [{ type: 'text', text: '분석해줘' }, { type: 'image_url', image_url: { url: IMG.dataUrl } }]);
  assert.equal(C.buildUserContent('', [IMG], { detail: 'low' })[1].image_url.detail, 'low');
  assert.equal(C.buildUserContent('', [IMG])[0].text, '(이미지 첨부)');
});

test('assembleContext: 현재 요청 이미지는 전송, 이전 턴 이미지는 기본 생략', () => {
  const history = [
    { id: 'u1', role: 'user', content: '이 이미지 분석', images: [IMG] },
    { id: 'a1', role: 'assistant', content: 'PROMPT', status: 'done' }
  ];
  const ctx = C.assembleContext({ systemPrompt: 'S', history, input: '표정만 바꿔줘', context: {} });
  assert.equal(typeof ctx.messages[1].content, 'string');
  assert.ok(ctx.messages[1].content.includes('첨부 이미지 1장'));
  assert.equal(ctx.imageCount, 0);
  const re = C.assembleContext({ systemPrompt: 'S', history, input: 'x', vision: { resendHistoryImages: true }, context: {} });
  assert.equal(re.imageCount, 1);
  const cur = C.assembleContext({ systemPrompt: 'S', history: [], input: '분석', images: [IMG, IMG], context: {} });
  const last = cur.messages[cur.messages.length - 1];
  assert.ok(Array.isArray(last.content));
  assert.equal(cur.imageCount, 2);
});

test('normalizeMessages: 배열 content 유지·병합', () => {
  const msgs = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'a' },
    { role: 'user', content: C.buildUserContent('b', [IMG]) }
  ];
  const out = C.normalizeMessages(msgs, { hasFirstSystemPrompt: true, requiresAlternateRole: true });
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].content.map((p) => p.type), ['text', 'text', 'image_url']);
  const su = C.normalizeMessages(msgs, { systemAsUser: true });
  assert.equal(su.length, 1);
  assert.ok(su[0].content[0].text.startsWith('SYS'));
  assert.equal(C.countImages(su), 1);
});

test('buildPlannerMessages: 이미지 첨부 시 content parts', () => {
  const pm = C.buildPlannerMessages('', {}, [IMG], {});
  assert.ok(Array.isArray(pm[1].content));
  assert.ok(pm[1].content[0].text.includes('1 image(s) attached'));
  assert.equal(typeof C.buildPlannerMessages('x', {}, [], {})[1].content, 'string');
});

test('classifyHttpError: 이미지 요청 거부 → VISION_UNSUPPORTED', () => {
  assert.equal(C.classifyHttpError(400, '{"error":{"message":"This model does not support image input"}}', { hasImages: true }).code, 'VISION_UNSUPPORTED');
  assert.equal(C.classifyHttpError(400, '{"error":{"message":"This model does not support image input"}}', { hasImages: false }).code, 'BAD_REQUEST');
});

test('callChat: 이미지 body 전송 및 비전 미지원 분류', async () => {
  const { srv, seen, url } = await startServer((req, res, rec) => {
    const hasImg = rec.body.messages.some((m) => Array.isArray(m.content));
    if (hasImg && req.url.startsWith('/novision')) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"image_url is not supported by this model"}}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  try {
    const msgs = [{ role: 'user', content: C.buildUserContent('x', [IMG]) }];
    const r = await C.callChat({ settings: settings({ api: { url, modelId: 'm' } }), messages: msgs, stream: false });
    assert.equal(r.imageCount, 1);
    assert.equal(seen[0].body.messages[0].content[1].image_url.url, IMG.dataUrl);
    const bad = url.replace('/v1', '/novision/v1');
    await assert.rejects(C.callChat({ settings: settings({ api: { url: bad, modelId: 'm' } }), messages: msgs, stream: false }), (e) => e.code === 'VISION_UNSUPPORTED');
  } finally { srv.close(); }
});
