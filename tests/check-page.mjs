/**
 * 静态检查：node tests/check-page.mjs
 * 不启动浏览器也能抓到的低级错误：脚本语法、选择器打错、资源漏放。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const problems = [];
const notes = [];

const html = read('index.html');

// 1) 内联脚本语法（不执行，只编译）
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (inlineScripts.length !== 1) problems.push(`index.html 里内联 <script> 数量异常：${inlineScripts.length}`);
inlineScripts.forEach((code, i) => {
  try {
    new vm.Script(code, { filename: `index.html#inline${i}` });
    notes.push(`内联脚本 #${i} 语法通过（${code.length} 字符）`);
  } catch (err) {
    problems.push(`内联脚本 #${i} 语法错误：${err.message}`);
  }
});

// 2) 独立脚本语法
for (const file of ['core.js', 'sw.js']) {
  try {
    new vm.Script(read(file), { filename: file });
    notes.push(`${file} 语法通过`);
  } catch (err) {
    problems.push(`${file} 语法错误：${err.message}`);
  }
}

// 3) manifest 是合法 JSON
try {
  JSON.parse(read('manifest.webmanifest'));
  notes.push('manifest.webmanifest 是合法 JSON');
} catch (err) {
  problems.push(`manifest.webmanifest 非法 JSON：${err.message}`);
}

// 4) 页面里 $('#xxx') / getElementById 用到的 id 必须真的存在
const idsInHtml = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const referenced = new Set();
for (const m of html.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) referenced.add(m[1]);
for (const m of html.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) referenced.add(m[1]);
const missingIds = [...referenced].filter((id) => !idsInHtml.has(id));
if (missingIds.length) problems.push(`引用了不存在的元素 id：${missingIds.join(', ')}`);
else notes.push(`检查了 ${referenced.size} 个元素 id，全部存在`);

// 5) 本地资源文件必须都在
const assets = [...html.matchAll(/(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)].map((m) => m[1]);
const missingFiles = [...new Set(assets)].filter((a) => !fs.existsSync(path.join(root, a)));
if (missingFiles.length) problems.push(`缺少本地资源：${missingFiles.join(', ')}`);
else notes.push(`检查了 ${new Set(assets).size} 个本地资源引用，全部存在`);

// 6) service worker 预缓存清单里的文件也必须在
const sw = read('sw.js');
const precache = [...sw.matchAll(/'\.\/([A-Za-z0-9._\/-]+)'/g)].map((m) => m[1]).filter((p) => p && !p.endsWith('/'));
const missingPrecache = precache.filter((p) => !fs.existsSync(path.join(root, p)));
if (missingPrecache.length) problems.push(`sw.js 预缓存清单里有不存在的文件：${missingPrecache.join(', ')}`);
else notes.push(`sw.js 预缓存 ${precache.length} 个文件，全部存在`);

notes.forEach((n) => console.log('  ok   ' + n));
if (problems.length) {
  problems.forEach((p) => console.log('  FAIL ' + p));
  console.log(`\n${problems.length} 个问题\n`);
  process.exit(1);
}
console.log('\n静态检查通过\n');
