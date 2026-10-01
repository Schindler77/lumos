'use strict';
// 테스트용 합성 content.csv 생성 (기본 221,787행, 헤더 없는 4열)
const fs = require('fs');

function generate(file, rows) {
  rows = rows || 221787;
  const words = ('hair eyes long short blue red black white smile open mouth desk table lying on leaning head down arms bent elbows ' +
    'sitting standing beach sand ocean sky cloud school uniform shirt skirt dress hat gloves boots looking at viewer from above below side ' +
    'upper body full body indoors outdoors night day sunlight window room bed chair book holding hand hands crossed legs kneeling away ' +
    'closed blush tears angry sad happy surprised wings tail ears animal cat dog fox girl boy solo jacket coat sweater pants shorts ' +
    'swimsuit bikini necklace earrings ribbon bow glasses mask sword flower tree grass water rain snow fire light shadow').split(' ');
  const real = [
    ['1girl', 0, 6008644, '1girls,sole_female'], ['solo', 0, 5000000, ''], ['head_down', 0, 23000, ''],
    ['leaning_on_table', 0, 4000, 'leaning_on_desk'], ['desk', 0, 90000, ''], ['arms_on_table', 0, 8000, 'arms_on_desk'],
    ['upper_body', 0, 900000, ''], ['bent_elbows', 0, 500, ''], ['school_uniform', 0, 700000, 'seifuku'],
    ['beach', 0, 200000, 'seaside'], ['hatsune_miku', 4, 150000, 'miku']
  ];
  const q = (s) => (/[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const lines = real.map((r) => [r[0], r[1], r[2], q(r[3])].join(','));
  const seen = new Set(real.map((r) => r[0]));
  let a = 7;
  const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  while (lines.length < rows) {
    const n = 1 + Math.floor(rnd() * 4);
    const t = [];
    for (let i = 0; i < n; i++) t.push(words[Math.floor(rnd() * words.length)]);
    let tag = t.join('_');
    if (rnd() < 0.3) tag += '_' + Math.floor(rnd() * 99999);
    if (seen.has(tag)) continue;
    seen.add(tag);
    const cat = [0, 0, 0, 0, 1, 1, 3, 4, 4, 5][Math.floor(rnd() * 10)];
    const cnt = Math.floor(Math.pow(rnd(), 6) * 500000);
    const al = rnd() < 0.35 ? q(tag.replace(/_/g, '') + ',' + tag + 's') : '';
    lines.push(tag + ',' + cat + ',' + cnt + ',' + al);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { rows: lines.length, size: fs.statSync(file).size };
}

module.exports = { generate };
if (require.main === module) console.log(generate(process.argv[2] || 'content.csv', Number(process.argv[3]) || undefined));
