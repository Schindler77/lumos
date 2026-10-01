'use strict';
/*
 * E2E용 모의 서버
 *   - 정적 파일: http://localhost:<staticPort>/ (nai/ 폴더)
 *   - 모의 API : http://127.0.0.1:<apiPort>/...  (다른 origin → CORS 동작 확인 가능)
 *
 *   /v1/chat/completions         CORS 허용, 키 불필요 (LM Studio 형태)
 *   /v1/models                   모델 목록
 *   /nocors/v1/chat/completions  CORS 헤더 없음 → 브라우저에서 CORS_BLOCKED
 *   /auth/v1/chat/completions    Bearer good-key 필요
 *   /proxy/v1/chat/completions   X-Lumos-Proxy-Token: ptok 필요
 *   /novision/v1/chat/completions 이미지가 들어오면 400 (비전 미지원 모델 흉내)
 *
 * 사용자 메시지에 SLOW 가 있으면 느린 스트림을 보낸다 (취소 테스트).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

function createServers(opts) {
  opts = opts || {};
  const root = path.join(__dirname, '..');
  const log = [];

  const staticSrv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file).pipe(res);
  });

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-lumos-proxy-token, x-lumos-original-url, x-lumos-upstream-url, x-lumos-upstream-authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  }

  function txt(c) { return Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : String(c || ''); }
  function hasImage(body) { return (body.messages || []).some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')); }

  function plannerReply(body) {
    const user = body.messages.map((m) => txt(m.content)).join('\n');
    let kws = ['1girl', 'solo'];
    if (/책상|엎드려/.test(user)) kws = kws.concat(['desk', 'leaning on desk', 'head down', 'bent arms', 'arms on table', 'upper body']);
    if (/복장/.test(user)) kws = kws.concat(['school uniform', 'shirt']);
    if (/해변/.test(user)) kws = kws.concat(['beach', 'lying']);
    if (hasImage(body)) kws = ['2girls', 'beach', 'sunset', 'silver hair', 'black hair', 'lying', 'sitting'];
    return { choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify({ keywords: kws }) + '\n```' }, finish_reason: 'stop' }] };
  }

  function finalText(body) {
    const sys = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const hasRef = sys.includes('[REFERENCE TAG CANDIDATES]');
    const lastMsg = body.messages[body.messages.length - 1];
    const last = txt(lastMsg.content);
    if (Array.isArray(lastMsg.content) && lastMsg.content.some((p) => p.type === 'image_url')) {
      return '[Base Prompt]\n2girls, beach, sunset, outdoors\n[Character Prompt 1]\ngirl, silver hair, lying, smile\n[Character Prompt 2]\ngirl, black hair, sitting';
    }
    const prev = body.messages.filter((m) => m.role === 'assistant').pop();
    if (/복장/.test(last) && prev) return prev.content.replace(/\n.*$/, '').replace('[NAI 프롬프트]', '[NAI 프롬프트]') + '\n1girl, solo, school uniform, head down, leaning on table';
    return '[NAI 프롬프트]\n1girl, solo, ' + (hasRef ? 'leaning on table, head down, arms on table' : 'desk') + ', upper body, indoors';
  }

  function sse(res, text, delay) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const pieces = text.match(/.{1,6}/gs) || [''];
    let i = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (i < pieces.length) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] }) + '\n\n');
        setTimeout(tick, delay);
      } else { res.write('data: [DONE]\n\n'); res.end(); }
    };
    tick();
  }

  const apiSrv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const noCors = url.startsWith('/nocors/');
    if (!noCors) cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && /\/v1\/models$/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'other' }] }));
      return;
    }
    if (req.method === 'GET') { res.writeHead(404); res.end('nf'); return; }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      const rec = { url, headers: req.headers, body, rawLength: raw.length };
      rec.images = (body.messages || []).reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0), 0);
      log.push(rec);
      if (url.startsWith('/auth/') && req.headers.authorization !== 'Bearer good-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: ' + (req.headers.authorization || '') } }));
        return;
      }
      if (url.startsWith('/proxy/') && req.headers['x-lumos-proxy-token'] !== 'ptok') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"bad proxy token"}');
        return;
      }
      if (body.model && body.model !== 'mock-model') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model "' + body.model + '" not found' } }));
        return;
      }
      const isPlanner = (body.messages || []).some((m) => m.role === 'system' && m.content.startsWith('You are a search-query planner'));
      rec.kind = isPlanner ? 'planner' : 'final';
      if (isPlanner) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(plannerReply(body)));
        return;
      }
      if (url.startsWith('/novision/') && hasImage(body)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Model does not support image input (image_url)' } }));
        return;
      }
      const lastText = txt(((body.messages || []).slice(-1)[0] || { content: '' }).content);
      const slow = /SLOW/.test(lastText);
      const text = /main color/.test(lastText) ? 'Red' : /ping|OK/.test(lastText) ? 'OK' : finalText(body);
      if (body.stream) sse(res, slow ? 'a, '.repeat(400) : text, slow ? 40 : 5);
      else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
      }
    });
  });

  return new Promise((resolve) => {
    staticSrv.listen(opts.staticPort || 0, 'localhost', () => {
      apiSrv.listen(opts.apiPort || 0, '127.0.0.1', () => {
        resolve({
          log,
          staticUrl: 'http://localhost:' + staticSrv.address().port + '/',
          apiBase: 'http://127.0.0.1:' + apiSrv.address().port,
          close: () => { staticSrv.close(); apiSrv.closeAllConnections(); apiSrv.close(); }
        });
      });
    });
  });
}

module.exports = { createServers };

if (require.main === module) {
  createServers({ staticPort: 8080, apiPort: 8081 }).then((s) => {
    console.log('app :', s.staticUrl);
    console.log('api :', s.apiBase + '/v1  (모델 ID: mock-model)');
  });
}
