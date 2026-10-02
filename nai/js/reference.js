/*
 * NAI Prompt Generator — 참조 CSV 엔진 래퍼
 *
 * tag-engine.js 팩토리를 Blob Web Worker로 띄워 22만 행 파싱·인덱싱 중에도
 * UI가 멈추지 않게 한다. (file:// 로 열어도 동작하도록 별도 워커 파일 대신 Blob 사용)
 * 워커를 만들 수 없는 환경이면 메인 스레드에서 같은 엔진을 쓴다.
 */
(function (root) {
  'use strict';

  function workerSource() {
    return 'var E = (' + root.NAITagEngineFactory.toString() + ')();\n' + '(' + function () {
      var idx = null;
      self.onmessage = function (ev) {
        var m = ev.data;
        function reply(type, payload) { var o = { id: m.id, type: type }; for (var k in payload) o[k] = payload[k]; self.postMessage(o); }
        function fail(e) { reply('error', { error: { message: String(e && e.message || e), code: e && e.code || '' } }); }
        try {
          if (m.type === 'load') {
            idx = null;
            Promise.resolve(m.blob ? m.blob.text() : m.text).then(function (text) {
              var t0 = Date.now();
              var bad = 0;
              for (var p = text.indexOf('�'); p !== -1 && bad < 1000; p = text.indexOf('�', p + 1)) bad++;
              idx = E.buildIndex(text, function (stage, pr) { reply('progress', { stage: stage, p: pr }); });
              var st = idx.stats; st.replacementChars = bad; st.buildMs = Date.now() - t0;
              reply('result', { result: st });
            }).catch(fail);
            return;
          }
          if (m.type === 'unload') { idx = null; reply('result', { result: true }); return; }
          if (!idx) { var e = new Error('참조 인덱스가 아직 준비되지 않았습니다.'); e.code = 'NOT_READY'; throw e; }
          if (m.type === 'search') reply('result', { result: E.search(idx, m.query, m.opts) });
          else if (m.type === 'searchMany') reply('result', { result: E.searchMany(idx, m.keywords, m.opts) });
          else if (m.type === 'lookup') reply('result', { result: E.lookup(idx, m.list) });
        } catch (e) { fail(e); }
      };
    }.toString() + ')();';
  }

  function createEngine() {
    var worker = null;
    var mainIdx = null;
    var engine = root.NAITagEngineFactory();
    var seq = 0;
    var pending = new Map();
    var progressCb = null;
    var state = { status: 'empty', stats: null, error: null, mode: '' }; // empty | loading | ready | error
    var readyWaiters = [];

    try {
      var url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = function (ev) {
        var m = ev.data;
        var p = pending.get(m.id);
        if (!p) return;
        if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.stage, m.p); return; }
        pending.delete(m.id);
        if (m.type === 'error') { var e = new Error(m.error.message); e.code = m.error.code; p.reject(e); }
        else p.resolve(m.result);
      };
      worker.onerror = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        pending.forEach(function (p) { p.reject(new Error(ev.message || '워커 오류')); });
        pending.clear();
      };
      state.mode = 'worker';
    } catch (_) {
      worker = null;
      state.mode = 'main';
    }

    function call(type, payload, onProgress) {
      if (!worker) return Promise.reject(new Error('no worker'));
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending.set(id, { resolve: resolve, reject: reject, onProgress: onProgress });
        var msg = { id: id, type: type };
        for (var k in payload) msg[k] = payload[k];
        worker.postMessage(msg);
      });
    }

    function settleReady() {
      var w = readyWaiters; readyWaiters = [];
      w.forEach(function (f) { f(); });
    }

    function load(blob) {
      state.status = 'loading'; state.error = null;
      var onProgress = function (stage, p) { if (progressCb) progressCb(stage, p); };
      var job = worker
        ? call('load', { blob: blob }, onProgress)
        : blob.text().then(function (text) {
            var t0 = Date.now();
            mainIdx = engine.buildIndex(text, onProgress);
            var st = mainIdx.stats; st.buildMs = Date.now() - t0; st.replacementChars = 0;
            return st;
          });
      return job.then(function (stats) {
        state.status = 'ready'; state.stats = stats; settleReady();
        return stats;
      }, function (e) {
        // 워커 자체가 동작하지 않는 환경(일부 file:// 등) → 메인 스레드로 1회 재시도
        if (worker && !e.code) {
          try { worker.terminate(); } catch (_) {}
          worker = null;
          state.mode = 'main';
          return load(blob);
        }
        state.status = 'error';
        state.error = e;
        if (!e.code) e.code = 'REFERENCE_FILE_PARSE_ERROR';
        settleReady();
        throw e;
      });
    }

    function unload() {
      state.status = 'empty'; state.stats = null; state.error = null; mainIdx = null;
      settleReady();
      if (worker) return call('unload', {}).catch(function () {});
      return Promise.resolve();
    }

    function whenSettled() {
      if (state.status !== 'loading') return Promise.resolve();
      return new Promise(function (r) { readyWaiters.push(r); });
    }

    function run(type, payload, local) {
      return whenSettled().then(function () {
        if (state.status !== 'ready') return null;
        if (worker) return call(type, payload);
        return local();
      });
    }

    return {
      state: state,
      onProgress: function (cb) { progressCb = cb; },
      load: load,
      unload: unload,
      whenSettled: whenSettled,
      search: function (query, opts) { return run('search', { query: query, opts: opts }, function () { return engine.search(mainIdx, query, opts); }); },
      searchMany: function (keywords, opts) { return run('searchMany', { keywords: keywords, opts: opts }, function () { return engine.searchMany(mainIdx, keywords, opts); }); },
      lookup: function (list) { return run('lookup', { list: list }, function () { return engine.lookup(mainIdx, list); }); }
    };
  }

  root.NAIReference = { createEngine: createEngine };
})(typeof self !== 'undefined' ? self : this);
