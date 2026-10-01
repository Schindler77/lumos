/*
 * NAI Prompt Generator — 로컬 태그 검색 엔진
 *
 * content.csv (헤더 없는 4열: tag, category, usage_count, aliases)를 파싱하고
 * exact / alias / prefix / token / substring / fuzzy 검색 인덱스를 만든다.
 *
 * 이 팩토리 함수는 외부 변수를 참조하지 않는다. Web Worker 안에서 실행할 수 있도록
 * 앱이 Function.prototype.toString()으로 그대로 Blob 워커에 넣기 때문이다.
 */
function NAITagEngineFactory() {
  'use strict';

  var CATEGORY_LABELS = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' };

  // ───────────────────────── 정규화 ─────────────────────────
  function baseNorm(s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFKC'); } catch (_) {}
    return s.toLowerCase().trim().replace(/\s+/g, ' ');
  }
  // 공백 ↔ underscore 동일 취급
  function key(s) {
    return baseNorm(s).replace(/ /g, '_');
  }
  // hyphen / underscore / 공백 차이까지 무시
  function looseKey(s) {
    return key(s).replace(/[-_]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function stem(t) {
    if (t.length > 4 && /ies$/.test(t)) return t.slice(0, -3) + 'y';
    if (t.length > 3 && /s$/.test(t) && !/ss$/.test(t)) return t.slice(0, -1);
    return t;
  }
  function tokens(s) {
    var parts = looseKey(s).split(/[_()\[\]{}:;,.!?'"\/\\]+/);
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      var st = stem(p);
      if (!seen[st]) { seen[st] = 1; out.push(st); }
    }
    return out;
  }

  // ───────────────────────── CSV 파서 ─────────────────────────
  // RFC4180 호환: 따옴표 필드, "" 이스케이프, CRLF/LF, BOM.
  function parseCSV(text, onProgress) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var rows = [];
    var len = text.length;
    var i = 0;
    var field = '';
    var row = [];
    var inQuotes = false;
    var lastReport = 0;
    while (i < len) {
      var c = text.charCodeAt(i);
      if (inQuotes) {
        if (c === 34) { // "
          if (text.charCodeAt(i + 1) === 34) { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        var q = text.indexOf('"', i);
        if (q === -1) { field += text.slice(i); i = len; break; }
        field += text.slice(i, q); i = q; continue;
      }
      if (c === 34 && field === '') { inQuotes = true; i++; continue; }
      if (c === 44) { row.push(field); field = ''; i++; continue; } // ,
      if (c === 10 || c === 13) {
        row.push(field); field = '';
        rows.push(row); row = [];
        if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
        i++;
        if (onProgress && i - lastReport > 500000) { lastReport = i; onProgress(i / len); }
        continue;
      }
      // 따옴표가 없는 일반 필드: 다음 구분자까지 한 번에 자른다.
      var j = i;
      while (j < len) {
        var d = text.charCodeAt(j);
        if (d === 44 || d === 10 || d === 13) break;
        j++;
      }
      field += text.slice(i, j); i = j;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // ───────────────────────── 인덱스 빌드 ─────────────────────────
  function buildIndex(text, onProgress) {
    var report = onProgress || function () {};
    report('parse', 0);
    var rows = parseCSV(text, function (p) { report('parse', p); });
    report('parse', 1);

    var tags = [];
    var cats = [];
    var counts = [];
    var aliasesRaw = [];
    var skipped = 0;
    var headerSkipped = false;

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var tag = row[0] == null ? '' : String(row[0]).trim();
      if (!tag) { if (row.length > 1 || tag) skipped++; continue; }
      if (r === 0 && row.length > 1 && row[1] !== '' && isNaN(Number(row[1])) && /^(tag|name)$/i.test(tag)) {
        headerSkipped = true; continue;
      }
      var cat = parseInt(row[1], 10);
      var cnt = parseFloat(row[2]);
      tags.push(tag);
      cats.push(isFinite(cat) && cat >= 0 && cat < 256 ? cat : 0);
      counts.push(isFinite(cnt) && cnt > 0 ? cnt : 0);
      aliasesRaw.push(row.length > 3 ? row.slice(3).join(',') : '');
    }
    rows = null;
    if (!tags.length) {
      var err = new Error('CSV에서 유효한 태그 행을 찾지 못했습니다.');
      err.code = 'REFERENCE_FILE_PARSE_ERROR';
      throw err;
    }

    var n = tags.length;
    var catArr = new Uint8Array(cats);
    var cntArr = new Float64Array(counts);
    var tokenCount = new Uint8Array(n);

    var exactTagMap = new Map();      // key(tag) → id
    var normalizedTagMap = new Map(); // looseKey(tag) → [id]
    var aliasMap = new Map();         // looseKey(alias) → [id]
    var tokenIndex = new Map();       // token → [id]
    var categoryIndex = new Map();    // cat → 행 수
    var prefixEntries = [];
    var keysArr = new Array(n);
    var aliasTotal = 0;

    function push(map, k, id) {
      var arr = map.get(k);
      if (!arr) map.set(k, [id]);
      else if (arr[arr.length - 1] !== id) arr.push(id);
    }

    for (var id = 0; id < n; id++) {
      var k = key(tags[id]);
      keysArr[id] = k;
      if (!exactTagMap.has(k)) exactTagMap.set(k, id);
      push(normalizedTagMap, looseKey(k), id);
      categoryIndex.set(catArr[id], (categoryIndex.get(catArr[id]) || 0) + 1);
      prefixEntries.push(k + '\u0000' + id);

      var tt = tokens(k);
      tokenCount[id] = Math.min(255, tt.length);
      for (var t = 0; t < tt.length; t++) push(tokenIndex, tt[t], id);

      var raw = aliasesRaw[id];
      if (raw) {
        var al = raw.split(',');
        for (var a = 0; a < al.length; a++) {
          var ak = key(al[a]);
          if (!ak || ak === k) continue;
          aliasTotal++;
          push(aliasMap, looseKey(ak), id);
          prefixEntries.push(ak + '\u0000' + id + '\u0000a');
          var at = tokens(ak);
          for (var u = 0; u < at.length; u++) push(tokenIndex, at[u], id);
        }
      }
      if ((id & 16383) === 0) report('index', id / n);
    }
    report('sort', 0);
    prefixEntries.sort();

    // usageCountIndex: 사용량 내림차순 id 목록 (substring / fuzzy 스캔 순서)
    var order = new Int32Array(n);
    for (var o = 0; o < n; o++) order[o] = o;
    var orderArr = Array.prototype.slice.call(order);
    orderArr.sort(function (x, y) { return cntArr[y] - cntArr[x]; });
    var usageCountIndex = Int32Array.from(orderArr);
    report('done', 1);

    var catStats = {};
    categoryIndex.forEach(function (v, c) { catStats[c] = v; });

    return {
      tags: tags, keys: keysArr, cats: catArr, counts: cntArr, aliasesRaw: aliasesRaw,
      tokenCount: tokenCount,
      exactTagMap: exactTagMap, normalizedTagMap: normalizedTagMap, aliasMap: aliasMap,
      tokenIndex: tokenIndex, prefixEntries: prefixEntries,
      usageCountIndex: usageCountIndex, categoryIndex: categoryIndex,
      stats: { rows: n, aliases: aliasTotal, skipped: skipped, headerSkipped: headerSkipped, categories: catStats }
    };
  }

  // ───────────────────────── 검색 ─────────────────────────
  // 제한 거리 편집 거리 (인접 문자 뒤바뀜 = 1회, OSA)
  function boundedLevenshtein(a, b, max) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    var prev2 = new Array(lb + 1), prev = new Array(lb + 1), cur = new Array(lb + 1);
    for (var j = 0; j <= lb; j++) prev[j] = j;
    for (var i = 1; i <= la; i++) {
      cur[0] = i;
      var rowMin = cur[0];
      var ca = a.charCodeAt(i - 1);
      for (var k = 1; k <= lb; k++) {
        var cb = b.charCodeAt(k - 1);
        var v = prev[k - 1] + (ca === cb ? 0 : 1);
        if (prev[k] + 1 < v) v = prev[k] + 1;
        if (cur[k - 1] + 1 < v) v = cur[k - 1] + 1;
        if (i > 1 && k > 1 && ca === b.charCodeAt(k - 2) && a.charCodeAt(i - 2) === cb && prev2[k - 2] + 1 < v) v = prev2[k - 2] + 1;
        cur[k] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      var tmp = prev2; prev2 = prev; prev = cur; cur = tmp;
    }
    return prev[lb];
  }

  function lowerBound(arr, target) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >>> 1;
      if (arr[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  var TIER = { exact: 1000, normalized: 970, alias: 900, prefix: 600, token: 300, substring: 200, fuzzy: 150 };

  function searchOne(idx, query, opts) {
    opts = opts || {};
    var limit = opts.limit || 10;
    var q = key(query);
    var lq = looseKey(query);
    if (!q || !lq) return [];
    var found = new Map();

    function add(id, score, via, alias) {
      var prev = found.get(id);
      if (!prev || prev.base < score) found.set(id, { id: id, base: score, via: via, alias: alias || '' });
    }

    // 1. exact tag
    var ex = idx.exactTagMap.get(q);
    if (ex !== undefined) add(ex, TIER.exact, 'exact');
    var nm = idx.normalizedTagMap.get(lq);
    if (nm) for (var i = 0; i < nm.length; i++) add(nm[i], TIER.normalized, 'exact');
    // 2. exact alias
    var am = idx.aliasMap.get(lq);
    if (am) for (var a = 0; a < am.length; a++) add(am[a], TIER.alias, 'alias', q);

    // 3. prefix
    if (q.length >= 3) {
      var pe = idx.prefixEntries;
      var start = lowerBound(pe, q);
      var scanned = 0;
      for (var p = start; p < pe.length && scanned < 4000; p++, scanned++) {
        var entry = pe[p];
        if (entry.lastIndexOf(q, 0) !== 0) break;
        var parts = entry.split('\u0000');
        var k = parts[0];
        if (k === q) continue; // exact 단계에서 처리됨
        var pid = +parts[1];
        var ratio = q.length / k.length;
        if (parts[2] === 'a') add(pid, TIER.prefix - 40 + 60 * ratio, 'alias-prefix', k);
        else add(pid, TIER.prefix + 60 * ratio, 'prefix');
      }
    }

    // 4. token/word
    var qt = tokens(q);
    if (qt.length) {
      var hit = new Map();
      for (var t = 0; t < qt.length; t++) {
        var post = idx.tokenIndex.get(qt[t]);
        if (!post || post.length > 60000) continue;
        for (var x = 0; x < post.length; x++) hit.set(post[x], (hit.get(post[x]) || 0) + 1);
      }
      var need = qt.length === 1 ? 1 : Math.max(2, Math.ceil(qt.length * 0.6));
      hit.forEach(function (m, hid) {
        if (m < need) return;
        var coverage = m / qt.length;
        var precision = Math.min(1, m / Math.max(1, idx.tokenCount[hid]));
        add(hid, TIER.token * coverage + 150 * precision, 'token');
      });
    }

    var order = idx.usageCountIndex;
    var keys = idx.keys;
    // 5. substring
    if (q.length >= 4 && found.size < limit * 2) {
      var subFound = 0;
      for (var s = 0; s < order.length && subFound < limit * 3; s++) {
        var sid = order[s];
        if (keys[sid].indexOf(q) !== -1 && !found.has(sid)) { add(sid, TIER.substring, 'substring'); subFound++; }
      }
    }
    // 6. fuzzy
    if (q.length >= 4 && found.size < limit) {
      var maxD = q.length <= 6 ? 1 : 2;
      var fz = 0;
      for (var f = 0; f < order.length && fz < limit * 2; f++) {
        var fid = order[f];
        var fk = keys[fid];
        if (Math.abs(fk.length - q.length) > maxD || found.has(fid)) continue;
        var d = boundedLevenshtein(q, fk, maxD);
        if (d <= maxD) { add(fid, TIER.fuzzy - 40 * d, 'fuzzy'); fz++; }
      }
    }

    var cats = idx.cats, counts = idx.counts;
    var catFilter = opts.categories || null;
    var out = [];
    found.forEach(function (r) {
      var c = cats[r.id];
      if (catFilter && catFilter.indexOf(c) === -1) return;
      var pop = Math.log10(counts[r.id] + 1);
      var score = r.base + pop * (r.base >= TIER.alias ? 3 : 8);
      if (r.base < TIER.alias) {
        if (c === 1) score -= 120;      // artist 태그가 부분 일치로 섞이는 것 방지
        else if (c === 5) score -= 30;  // meta
      }
      if (score > 0) out.push({ id: r.id, score: score, via: r.via, alias: r.alias });
    });
    out.sort(function (x, y) { return y.score - x.score || counts[y.id] - counts[x.id]; });
    if (out.length > limit) out.length = limit;
    return out;
  }

  function describe(idx, r) {
    return {
      tag: idx.tags[r.id],
      category: idx.cats[r.id],
      categoryLabel: CATEGORY_LABELS[idx.cats[r.id]] || String(idx.cats[r.id]),
      count: idx.counts[r.id],
      score: Math.round(r.score),
      via: r.via,
      alias: r.alias || '',
      keywords: r.keywords || undefined
    };
  }

  function search(idx, query, opts) {
    return searchOne(idx, query, opts).map(function (r) { return describe(idx, r); });
  }

  // 여러 키워드 → 중복 제거된 후보 목록
  function searchMany(idx, keywords, opts) {
    opts = opts || {};
    var perKeyword = opts.perKeyword || 10;
    var maxTotal = opts.maxTotal || 150;
    var merged = new Map();
    var seenKw = Object.create(null);
    for (var i = 0; i < keywords.length; i++) {
      var kw = String(keywords[i] || '').trim();
      var nk = looseKey(kw);
      if (!nk || seenKw[nk]) continue;
      seenKw[nk] = 1;
      var res = searchOne(idx, kw, { limit: perKeyword, categories: opts.categories });
      for (var j = 0; j < res.length; j++) {
        var r = res[j];
        var prev = merged.get(r.id);
        if (!prev) {
          merged.set(r.id, { id: r.id, score: r.score, via: r.via, alias: r.alias, keywords: [kw] });
        } else {
          prev.keywords.push(kw);
          if (r.score > prev.score) { prev.score = r.score; prev.via = r.via; if (r.alias) prev.alias = r.alias; }
        }
      }
    }
    var out = [];
    merged.forEach(function (m) {
      m.score += 20 * (m.keywords.length - 1);
      out.push(m);
    });
    out.sort(function (x, y) { return y.score - x.score; });
    if (out.length > maxTotal) out.length = maxTotal;
    return out.map(function (r) { return describe(idx, r); });
  }

  // 태그 존재 확인 (출력 검증용): 정식 태그 / alias 여부
  function lookup(idx, list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var k = key(s);
      var ex = idx.exactTagMap.get(k);
      if (ex === undefined) {
        var nm = idx.normalizedTagMap.get(looseKey(s));
        if (nm) ex = nm[0];
      }
      if (ex !== undefined) { out.push({ input: s, status: 'tag', tag: idx.tags[ex] }); continue; }
      var am = idx.aliasMap.get(looseKey(s));
      if (am) { out.push({ input: s, status: 'alias', tag: idx.tags[am[0]] }); continue; }
      out.push({ input: s, status: 'unknown' });
    }
    return out;
  }

  return {
    CATEGORY_LABELS: CATEGORY_LABELS,
    key: key, looseKey: looseKey, tokens: tokens,
    parseCSV: parseCSV, buildIndex: buildIndex,
    search: search, searchMany: searchMany, lookup: lookup,
    boundedLevenshtein: boundedLevenshtein
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NAITagEngineFactory();
  module.exports.NAITagEngineFactory = NAITagEngineFactory;
}
