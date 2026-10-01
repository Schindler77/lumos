'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/tag-engine.js');

const CSV = [
  '﻿1girl,0,6008644,"1girls,sole_female"',
  'solo,0,5000000,',
  'head_down,0,23000,looking_down_head',
  'leaning_on_table,0,4000,"leaning_on_desk,leaning_over_table"',
  'desk,0,90000,',
  'arms_on_table,0,8000,arms_on_desk',
  'upper_body,0,900000,',
  'hatsune_miku,4,150000,miku',
  'some_artist,1,90000,',
  'x-ray,0,3000,',
  'quote_tag,0,10,"say ""hi"",other"',
  'school_uniform,0,700000,seifuku\r',
  'long_hair,0,2000000,',
  ''
].join('\n');

const idx = E.buildIndex(CSV);

test('CSV 파싱: BOM, 따옴표, "" 이스케이프, CRLF', () => {
  const rows = E.parseCSV('a,0,1,"x,y"\r\nb,1,2,"he said ""ok"""\n');
  assert.deepEqual(rows[0], ['a', '0', '1', 'x,y']);
  assert.deepEqual(rows[1], ['b', '1', '2', 'he said "ok"']);
  assert.equal(idx.stats.rows, 13);
  assert.equal(idx.tags[0], '1girl');
  assert.equal(idx.counts[0], 6008644);
});

test('헤더 행 자동 건너뛰기', () => {
  const i2 = E.buildIndex('tag,category,count,aliases\nsmile,0,5,\n');
  assert.equal(i2.stats.rows, 1);
  assert.equal(i2.stats.headerSkipped, true);
});

test('유효 행이 없으면 REFERENCE_FILE_PARSE_ERROR', () => {
  assert.throws(() => E.buildIndex('\n\n'), (e) => e.code === 'REFERENCE_FILE_PARSE_ERROR');
});

test('exact / 공백↔underscore / 대소문자', () => {
  assert.equal(E.search(idx, 'head down')[0].tag, 'head_down');
  assert.equal(E.search(idx, 'HEAD_DOWN')[0].via, 'exact');
  assert.equal(E.search(idx, '  upper   body ')[0].tag, 'upper_body');
});

test('hyphen/underscore 후보 비교', () => {
  assert.equal(E.search(idx, 'x ray')[0].tag, 'x-ray');
  assert.equal(E.search(idx, 'x_ray')[0].via, 'exact');
});

test('alias exact → 원본 태그 + 매칭된 alias', () => {
  const r = E.search(idx, '1girls')[0];
  assert.equal(r.tag, '1girl');
  assert.equal(r.via, 'alias');
  assert.equal(r.alias, '1girls');
  assert.equal(E.search(idx, 'leaning on desk')[0].tag, 'leaning_on_table');
  assert.equal(E.search(idx, 'seifuku')[0].tag, 'school_uniform');
});

test('prefix / token / fuzzy', () => {
  assert.equal(E.search(idx, 'hatsune')[0].tag, 'hatsune_miku');
  assert.equal(E.search(idx, 'hatsune')[0].via, 'prefix');
  const tok = E.search(idx, 'table arms');
  assert.equal(tok[0].tag, 'arms_on_table');
  assert.equal(tok[0].via, 'token');
  const fz = E.search(idx, 'heda down');
  assert.equal(fz[0].tag, 'head_down');
});

test('exact가 인기 태그보다 우선', () => {
  const r = E.search(idx, 'desk');
  assert.equal(r[0].tag, 'desk');
});

test('searchMany: 중복 제거 + 키워드 병합', () => {
  const r = E.searchMany(idx, ['desk', 'leaning on desk', 'leaning_on_desk', 'head down', '1girls'], { perKeyword: 5, maxTotal: 50 });
  const tags = r.map((x) => x.tag);
  assert.equal(new Set(tags).size, tags.length);
  assert.ok(tags.includes('leaning_on_table'));
  assert.ok(tags.includes('1girl'));
  assert.ok(r.length <= 50);
});

test('lookup: 정식/alias/unknown', () => {
  const r = E.lookup(idx, ['long hair', 'miku', 'nonexistent tag']);
  assert.deepEqual(r.map((x) => x.status), ['tag', 'alias', 'unknown']);
  assert.equal(r[1].tag, 'hatsune_miku');
});

test('따옴표 안 "" 가 들어간 alias 처리', () => {
  assert.equal(E.search(idx, 'other')[0].tag, 'quote_tag');
});

test('boundedLevenshtein: 전치 1회', () => {
  assert.equal(E.boundedLevenshtein('abcd', 'abdc', 2), 1);
  assert.equal(E.boundedLevenshtein('kitten', 'sitting', 2), 3);
});
