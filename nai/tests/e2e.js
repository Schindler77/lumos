'use strict';
/*
 * 브라우저 E2E (Playwright + 모의 서버). 실행:
 *   NODE_PATH=$(npm root -g) node nai/tests/e2e.js [스크린샷 폴더]
 * 지시서 §28 T01~T10 시나리오를 실제 UI로 확인한다.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');
const { createServers } = require('./mock-server');
const { generate } = require('./gen-csv');

const shotDir = process.argv[2] || path.join(os.tmpdir(), 'nai-e2e');
fs.mkdirSync(shotDir, { recursive: true });
const results = [];
function check(name, ok, info) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  — ' + info : ''));
}

async function openSettings(page, tab) {
  await page.click('#btn-settings-side');
  await page.click('.set-tab[data-tab="' + tab + '"]');
}
async function closeSettings(page) {
  await page.click('#set-cancel');
  await page.waitForFunction(() => !document.getElementById('settings').open);
}
async function configure(page, o) {
  await openSettings(page, 'api');
  await page.fill('#f-url', o.url);
  await page.fill('#f-model', o.modelId || 'mock-model');
  await page.fill('#f-key', o.key || '');
  await page.setChecked('#f-proxy-on', !!o.proxyUrl);
  await page.fill('#f-purl', o.proxyUrl || '');
  await page.fill('#f-ptok', o.proxyToken || '');
  await page.click('#set-save');
  await page.waitForFunction(() => !document.getElementById('settings').open);
}
async function send(page, text) {
  const before = await page.locator('.msg.assistant').count();
  await page.fill('#input', text);
  await page.press('#input', 'Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.msg.assistant').length > n && !document.querySelector('.status-line .spinner'), before, { timeout: 30000 });
}
async function lastAssistant(page) { return page.locator('.msg.assistant').last(); }

(async () => {
  const csvPath = path.join(os.tmpdir(), 'nai-e2e-content.csv');
  if (!fs.existsSync(csvPath)) generate(csvPath);
  const srv = await createServers();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: srv.staticUrl.replace(/\/$/, '') });
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  page.on('pageerror', (e) => consoleLines.push('PAGEERROR ' + e.message));

  try {
    await page.goto(srv.staticUrl);
    await page.waitForSelector('.empty h1');
    await page.screenshot({ path: path.join(shotDir, '01-empty.png') });
    check('설정 버튼은 왼쪽 아래 하나만', !(await page.$('#btn-settings')) && (await page.locator('#btn-settings-side').count()) === 1);
    await openSettings(page, 'api');
    check('추론 설정이 API 탭에 표시', await page.isVisible('.set-panel[data-panel="api"] #f-effort') && await page.isVisible('#f-tlevel') && await page.isVisible('#f-tbudget'));
    await closeSettings(page);

    // T04 — LM Studio 형태 로컬 no-key
    await configure(page, { url: srv.apiBase + '/v1' });

    // T05 — 22만 행 CSV 업로드, UI 멈춤 없음
    await openSettings(page, 'reference');
    const t0 = Date.now();
    await page.setInputFiles('#ref-file', csvPath);
    let maxGap = 0;
    while (!(await page.evaluate(() => /행$/.test(document.getElementById('ref-status').textContent)))) {
      const s = Date.now();
      await page.evaluate(() => 1);
      maxGap = Math.max(maxGap, Date.now() - s);
      if (Date.now() - t0 > 60000) throw new Error('CSV 인덱스 시간 초과');
      await page.waitForTimeout(50);
    }
    const loadMs = Date.now() - t0;
    const rowsText = await page.textContent('#ref-status');
    check('T05 CSV 221,787행 로드', /221,787행/.test(rowsText), rowsText + ' · ' + loadMs + 'ms');
    check('T05 인덱싱 중 UI 응답 (최대 지연 < 250ms)', maxGap < 250, maxGap + 'ms');
    await page.fill('#ref-test-q', '1girls');
    await page.click('#ref-test-btn');
    await page.waitForSelector('#ref-test-out table');
    check('T05 alias 검색 (1girls → 1girl)', (await page.textContent('#ref-test-out tbody tr:first-child')).includes('1girl'));
    await page.fill('#ref-test-q', 'heda down');
    await page.click('#ref-test-btn');
    await page.waitForFunction(() => document.querySelector('#ref-test-out tbody tr td') && document.querySelector('#ref-test-out tbody tr td').textContent === 'head_down');
    check('T05 fuzzy 검색 (heda down → head_down)', true);
    await page.screenshot({ path: path.join(shotDir, '02-reference.png') });
    await closeSettings(page);

    // T06 — 한국어 요청 → Planner → CSV → 최종
    srv.log.length = 0;
    await send(page, '책상 위에 엎드려 팔을 접고 머리를 숙인 자세');
    const planner = srv.log.find((r) => r.kind === 'planner');
    const final = srv.log.find((r) => r.kind === 'final');
    check('T06 Query Planner 호출', !!planner);
    const sys = final.body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    check('T06 참조 후보 블록 포함 (leaning_on_table, head_down)', sys.includes('[REFERENCE TAG CANDIDATES]') && sys.includes('leaning_on_table | cat=0') && sys.includes('head_down'));
    check('AC3 CSV 전체 미전송 (요청 크기)', final.rawLength < 60000, final.rawLength + ' bytes vs CSV ' + fs.statSync(csvPath).size);
    check('T04 Authorization 헤더 없음', final.headers.authorization === undefined && planner.headers.authorization === undefined);
    check('System Prompt가 첫 system 메시지', final.body.messages[0].role === 'system' && final.body.messages[0].content.startsWith('당신은 NovelAI'));
    const out1 = await (await lastAssistant(page)).locator('.result-body').innerText();
    check('T01 결과 출력', out1.includes('[NAI 프롬프트]') && out1.includes('leaning on table'), out1.replace(/\n/g, ' | '));
    await page.screenshot({ path: path.join(shotDir, '03-result.png') });

    // 복사
    await (await lastAssistant(page)).locator('.result-head .act').first().click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('결과 복사', clip.trim() === out1.trim());

    // T07 — 후속 수정: 직전 완성 프롬프트 포함
    srv.log.length = 0;
    await send(page, '표정은 그대로 두고 복장만 바꿔줘');
    const f2 = srv.log.find((r) => r.kind === 'final');
    const asstMsgs = f2.body.messages.filter((m) => m.role === 'assistant');
    check('T07 직전 완성 프롬프트가 맥락에 포함', asstMsgs.length === 1 && asstMsgs[0].content.trim() === out1.trim());
    const pl2 = srv.log.find((r) => r.kind === 'planner');
    check('T07 Planner에도 직전 프롬프트 전달', pl2 && pl2.body.messages[1].content.includes('Previous final prompt'));

    // 재생성
    srv.log.length = 0;
    const countBefore = await page.locator('.msg.assistant').count();
    await (await lastAssistant(page)).locator('button:has-text("재생성")').click();
    await page.waitForFunction(() => !document.querySelector('.status-line .spinner'));
    check('재생성 (메시지 수 유지, Planner 캐시 재사용)', (await page.locator('.msg.assistant').count()) === countBefore && !srv.log.some((r) => r.kind === 'planner'));

    // 보낸 메시지 수정 — 취소는 그대로, 저장은 아래 대화 삭제 후 재전송
    const firstUser = page.locator('.msg.user').first();
    const msgCountBefore = await page.locator('.msg').count();
    srv.log.length = 0;
    await firstUser.hover();
    await firstUser.locator('button:has-text("수정")').click();
    await page.fill('.edit-box textarea', '바뀐 내용 (취소될 것)');
    await page.click('.edit-box button:has-text("취소")');
    check('수정 → 취소: 아무것도 바뀌지 않음', (await page.locator('.msg').count()) === msgCountBefore && !(await page.$('.edit-box')) && (await page.locator('.msg.user .bubble-text').first().innerText()) === '책상 위에 엎드려 팔을 접고 머리를 숙인 자세' && srv.log.length === 0);
    await firstUser.hover();
    await firstUser.locator('button:has-text("수정")').click();
    await page.press('.edit-box textarea', 'Escape');
    check('수정 → Esc: 빠져나옴', !(await page.$('.edit-box')));
    await firstUser.hover();
    await firstUser.locator('button:has-text("수정")').click();
    await page.fill('.edit-box textarea', '해변에 누워 있는 소녀');
    await page.screenshot({ path: path.join(shotDir, '11-edit.png') });
    await page.click('.edit-box button:has-text("저장")');
    await page.waitForFunction(() => !document.querySelector('.status-line .spinner') && document.querySelectorAll('.msg').length === 2);
    const ef = srv.log.find((r) => r.kind === 'final');
    check('수정 → 저장: 아래 대화 삭제 + 수정 내용으로 재전송', (await page.locator('.msg').count()) === 2 && ef && ef.body.messages[ef.body.messages.length - 1].content === '해변에 누워 있는 소녀' && !ef.body.messages.some((m) => m.role === 'assistant'));
    check('수정 → 저장: 새 결과 출력', (await (await lastAssistant(page)).locator('.result-body').count()) === 1);

    // T08 — 스트리밍 중 취소
    await page.fill('#input', 'SLOW 테스트');
    await page.press('#input', 'Enter');
    await page.waitForFunction(() => { const a = document.querySelectorAll('.msg.assistant'); const l = a[a.length - 1]; const b = l && l.querySelector('.result-body'); return b && b.textContent.length > 20 && l.querySelector('.spinner'); }, null, { timeout: 15000 });
    await page.click('#btn-send');
    await page.waitForFunction(() => !document.querySelector('.status-line .spinner'));
    const cancelText = await (await lastAssistant(page)).innerText();
    check('T08 취소 배지 + 부분 출력 보존', cancelText.includes('취소된 응답') && cancelText.includes('a, a'), cancelText.slice(0, 120).replace(/\n/g, ' | '));
    const lastFinal = await page.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('nai-prompt-generator');
      r.onsuccess = () => {
        const g = r.result.transaction('chats').objectStore('chats').getAll();
        g.onsuccess = () => {
          const c = g.result.sort((a, b) => b.updatedAt - a.updatedAt)[0];
          const last = c.messages[c.messages.length - 1];
          res({ lastFinalId: c.lastFinalPromptMsgId, lastId: last.id, lastStatus: last.status, lastFinal: c.lastFinalPrompt });
        };
      };
    }));
    check('T08 부분 응답은 lastFinalPrompt로 승격되지 않음', lastFinal.lastStatus === 'cancelled' && lastFinal.lastFinalId !== lastFinal.lastId && !/^a, a/.test(lastFinal.lastFinal));
    check('T08 직후 send 버튼 복귀', !(await page.$('#btn-send.stop')));

    // T02 — CORS 차단은 CORS_BLOCKED (인증 오류 아님)
    await page.click('#btn-new-chat');
    await configure(page, { url: srv.apiBase + '/nocors/v1' });
    await send(page, '해변에 누워 있는 소녀');
    const err2 = await (await lastAssistant(page)).locator('.err-card').innerText();
    check('T02 CORS_BLOCKED 분류', err2.includes('CORS_BLOCKED') && err2.includes('프록시'), err2.split('\n')[0]);
    await page.screenshot({ path: path.join(shotDir, '04-cors.png') });

    // 연결 테스트 (CORS)
    await openSettings(page, 'api');
    await page.click('#btn-conn-test');
    await page.waitForFunction(() => !document.querySelector('#diag-out .spinner'));
    const diagCors = await page.innerText('#diag-out');
    check('연결 테스트: CORS 차단 → 프록시 권장', diagCors.includes('CORS로 차단') && diagCors.includes('프록시 사용 권장'));
    await closeSettings(page);

    // T09 — 잘못된 키 → AUTH_FAILED, 키 노출 없음
    await configure(page, { url: srv.apiBase + '/auth/v1', key: 'wrong-key-12345' });
    await send(page, '해변에 누워 있는 소녀');
    const err3 = await (await lastAssistant(page)).locator('.err-card').innerText();
    check('T09 AUTH_FAILED 분류', err3.includes('AUTH_FAILED') && err3.includes('401'));
    check('T09 오류 표시에 키 노출 없음', !(await page.innerText('body')).includes('wrong-key-12345'));

    // T01 — 원격 형태 + 올바른 키
    await configure(page, { url: srv.apiBase + '/auth/v1', key: 'good-key' });
    await send(page, '해변에 누워 있는 소녀');
    check('T01 API 키 직접 호출 성공', (await (await lastAssistant(page)).locator('.result-body').count()) === 1);

    // T03 — 프록시: 원본 모델 ID 유지, 프록시 토큰만 전송
    srv.log.length = 0;
    await configure(page, { url: 'https://api.example.com/v1', key: 'sk-upstream-zzz', proxyUrl: srv.apiBase + '/proxy/v1/chat/completions', proxyToken: 'ptok' });
    await openSettings(page, 'api');
    const cred = await page.innerText('#cred-summary');
    check('프록시 전송 credential UI 표시', cred.includes('프록시 토큰') && cred.includes('전송하지 않음') && !cred.includes('ptok') && !cred.includes('sk-upstream-zzz'));
    await closeSettings(page);
    await send(page, '해변에 누워 있는 소녀');
    const pf = srv.log.find((r) => r.kind === 'final');
    check('T03 프록시 호출 성공', pf && pf.url.startsWith('/proxy/') && (await (await lastAssistant(page)).locator('.result-body').count()) === 1);
    check('T03 원본 모델 ID 유지 + 프록시 토큰 헤더', pf.body.model === 'mock-model' && pf.headers['x-lumos-proxy-token'] === 'ptok' && pf.headers.authorization === 'Bearer ptok');
    check('T03 원본 API 키 미전송', !JSON.stringify(pf.headers).includes('sk-upstream-zzz'));
    check('T03 원본 URL 헤더 보존', pf.headers['x-lumos-upstream-url'] === 'https://api.example.com/v1/chat/completions');

    // 이미지 분석 (비전) — 첨부 → Planner/최종 요청에 이미지 → 후속 수정은 이미지 재전송 없음
    await page.click('#btn-new-chat');
    await configure(page, { url: srv.apiBase + '/v1' });
    const pngPath = path.join(os.tmpdir(), 'nai-e2e-image.png');
    const pngData = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1200; const g = c.getContext('2d'); g.fillStyle = '#3a6'; g.fillRect(0, 0, 2400, 1200); g.fillStyle = '#fc0'; g.fillRect(200, 200, 600, 600); return c.toDataURL('image/png'); });
    fs.writeFileSync(pngPath, Buffer.from(pngData.split(',')[1], 'base64'));
    await page.setInputFiles('#img-file', pngPath);
    await page.waitForSelector('#attach-tray .att img');
    const attTitle = await page.getAttribute('#attach-tray .att', 'title');
    check('이미지 첨부 + 축소(긴 변 1536)', /1536×768/.test(attTitle), attTitle);
    srv.log.length = 0;
    await send(page, '이 이미지를 Base / Character 프롬프트로 각각 분석해줘');
    const vPlan = srv.log.find((r) => r.kind === 'planner');
    const vFinal = srv.log.find((r) => r.kind === 'final');
    check('비전: Planner에 이미지 전송', vPlan && vPlan.images === 1);
    const vLast = vFinal.body.messages[vFinal.body.messages.length - 1];
    check('비전: 최종 요청에 image_url(JPEG) 포함', Array.isArray(vLast.content) && vLast.content[1].type === 'image_url' && /^data:image\/jpeg;base64,/.test(vLast.content[1].image_url.url));
    const vSys = vFinal.body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    check('비전: 이미지 키워드로 CSV 후보 검색', vSys.includes('beach | cat=0'));
    const vOut = await (await lastAssistant(page)).locator('.result-body').innerText();
    check('비전: Base / Character 프롬프트 출력', vOut.includes('[Base Prompt]') && vOut.includes('[Character Prompt 2]'));
    check('비전: 사용자 메시지에 썸네일', (await page.locator('.msg.user .thumb img').count()) === 1);
    await page.screenshot({ path: path.join(shotDir, '10-vision.png') });
    await page.click('.msg.user .thumb');
    check('비전: 썸네일 클릭 시 크게 보기', await page.evaluate(() => document.getElementById('lightbox').open));
    await page.click('#lightbox');
    srv.log.length = 0;
    await send(page, '표정만 바꿔줘');
    const vF2 = srv.log.find((r) => r.kind === 'final');
    check('비전: 후속 수정은 이미지 재전송 없음 + 직전 프롬프트 유지', vF2.images === 0 && vF2.body.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('첨부 이미지 1장')) && vF2.body.messages.some((m) => m.role === 'assistant' && m.content.includes('[Base Prompt]')));

    // 이미지만 붙여넣기 (글 없음) → 새 대화 제목 "이미지 분석"
    await page.click('#btn-new-chat');
    await page.evaluate((d) => {
      const bin = atob(d.split(',')[1]); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u8], 'pasted.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.getElementById('input').dispatchEvent(ev);
    }, pngData);
    await page.waitForSelector('#attach-tray .att img');
    const before2 = await page.locator('.msg.assistant').count();
    await page.press('#input', 'Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.msg.assistant').length > n && !document.querySelector('.status-line .spinner'), before2);
    check('비전: 붙여넣기 이미지만 전송 + 제목 "이미지 분석"', (await page.textContent('#chat-title')) === '이미지 분석' && (await (await lastAssistant(page)).locator('.result-body').count()) === 1);

    // 비전 미지원 모델 → VISION_UNSUPPORTED
    await configure(page, { url: srv.apiBase + '/novision/v1' });
    await page.setInputFiles('#img-file', pngPath);
    await page.waitForSelector('#attach-tray .att img');
    await send(page, '분석해줘');
    const vErr = await (await lastAssistant(page)).locator('.err-card').innerText();
    check('비전: 미지원 모델 → VISION_UNSUPPORTED', vErr.includes('VISION_UNSUPPORTED'), vErr.split('\n')[0]);

    // 연결 테스트 (로컬, 정상)
    await configure(page, { url: srv.apiBase + '/v1' });
    await openSettings(page, 'api');
    await page.click('#btn-conn-test');
    await page.waitForFunction(() => !document.querySelector('#diag-out .spinner'));
    const diagOk = await page.innerText('#diag-out');
    check('연결 테스트: 서버/모델/스트리밍/키 없음', ['서버 연결 성공', '모델 확인', '스트리밍 지원', 'API Key 없음', '/models'].every((s) => diagOk.includes(s)), diagOk.replace(/\n/g, ' | '));
    await page.screenshot({ path: path.join(shotDir, '05-conn-test.png') });

    // 모델 진단
    page.once('dialog', (d) => d.accept());
    await page.click('#btn-diag');
    await page.waitForFunction(() => !document.querySelector('#diag-out .spinner'), null, { timeout: 30000 });
    const diag = await page.innerText('#diag-out');
    check('모델 진단 실행', diag.includes('system role 허용') && diag.includes('max_tokens'));
    check('모델 진단: 비전 지원 확인', diag.includes('이미지 입력(비전) 지원'));

    // 권장 설정 점검
    await page.click('#btn-reco');
    const reco = await page.innerText('#diag-out');
    check('권장 설정 점검', reco.includes('로컬 엔드포인트로 정상 처리'));

    // 지시사항 점검 — 경고만, 원문 불변
    await page.click('.set-tab[data-tab="prompt"]');
    const sp = 'NAI 5 계열 기준\nNAI Diffusion V4.5 Full 기준\ncode_execution으로 정확한 토큰 수를 센다';
    await page.fill('#sp-text', sp);
    await page.click('#sp-lint-btn');
    const lint = await page.innerText('#sp-lint');
    check('지시사항 점검: 버전 충돌·code_execution 경고', lint.includes('버전') && lint.includes('code_execution'));
    check('지시사항 원문 불변', (await page.inputValue('#sp-text')) === sp);
    await page.screenshot({ path: path.join(shotDir, '06-settings-prompt.png') });
    page.once('dialog', (d) => d.accept());
    await page.click('#set-cancel');
    await page.waitForFunction(() => !document.getElementById('settings').open);

    // 새로고침 후 유지
    const chatCount = await page.locator('.chat-item').count();
    await page.reload();
    await page.waitForFunction(() => /행$/.test(document.getElementById('ref-status').textContent), null, { timeout: 30000 });
    check('새로고침 후 대화·참조 CSV 유지', (await page.locator('.chat-item').count()) === chatCount && chatCount === 4);
    check('새로고침 후 첨부 이미지 유지', await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('nai-prompt-generator'); r.onsuccess = () => { const g = r.result.transaction('chats').objectStore('chats').getAll(); g.onsuccess = () => res(g.result.some((c) => c.messages.some((m) => m.images && m.images[0] && /^data:image\/jpeg/.test(m.images[0].dataUrl)))); }; })));
    check('새로고침 후 설정 유지', await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('nai-prompt-generator'); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('settings'); g.onsuccess = () => res(g.result.api.modelId === 'mock-model'); }; })));

    // 대화방 이름 변경 / 삭제
    await page.locator('.chat-item').first().hover();
    await page.locator('.chat-item').first().locator('button[title="이름 변경"]').click();
    await page.fill('.chat-item input', '테스트 대화');
    await page.press('.chat-item input', 'Enter');
    check('대화방 이름 변경', (await page.locator('.chat-item').first().innerText()).includes('테스트 대화'));

    // T10 — 콘솔에 비밀값 없음
    const secrets = ['ptok', 'good-key', 'sk-upstream-zzz', 'wrong-key-12345'];
    check('T10 콘솔에 키/토큰 출력 없음', !consoleLines.some((l) => secrets.some((s) => l.includes(s))), consoleLines.length + ' lines');
    check('페이지 오류 없음', !consoleLines.some((l) => l.startsWith('PAGEERROR')), consoleLines.filter((l) => l.startsWith('PAGEERROR')).join(' / '));

    // 모바일 레이아웃
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#btn-sidebar-open');
    await page.waitForTimeout(300);
    check('모바일: 사이드바 drawer 열림', await page.evaluate(() => document.getElementById('app').classList.contains('sb-open')));
    await page.screenshot({ path: path.join(shotDir, '08-mobile-drawer.png') });
    await page.locator('.chat-item .open').last().click();
    await page.waitForTimeout(300);
    check('모바일: 대화 선택 시 drawer 닫힘', !(await page.evaluate(() => document.getElementById('app').classList.contains('sb-open'))));
    await page.screenshot({ path: path.join(shotDir, '07-mobile.png') });
    const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check('모바일: 가로 스크롤 없음', !hscroll);
  } catch (e) {
    check('예외 없이 완료', false, e.stack);
    await page.screenshot({ path: path.join(shotDir, 'error.png') }).catch(() => {});
  } finally {
    await browser.close();
    srv.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed · screenshots: ' + shotDir);
  process.exit(failed.length ? 1 : 0);
})();
