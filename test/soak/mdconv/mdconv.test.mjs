// Hold-out acceptance for the P6 soak goal. The agents see the command, not this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.env.MDCONV;
assert.ok(BIN, 'set MDCONV to the path of bin/mdconv.js');
const norm = s => s.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
function conv(md) {
  const f = join(mkdtempSync(join(tmpdir(), 'mdconv-')), 'in.md');
  writeFileSync(f, md);
  return norm(execFileSync('node', [BIN, f], { encoding: 'utf8', timeout: 10_000 }));
}

test('headings', () => {
  assert.match(conv('# One\n\n### Three'), /<h1>One<\/h1><h3>Three<\/h3>/);
});
test('paragraphs are separated by blank lines and joined within', () => {
  assert.equal(conv('a\nb\n\nc'), '<p>a b</p><p>c</p>'.replace('a b', conv('a\nb').includes('a\nb') ? 'a\nb' : 'a b'));
});
test('emphasis, strong, inline code', () => {
  const h = conv('some *em* and **strong** and `x < y`');
  assert.match(h, /<em>em<\/em>/);
  assert.match(h, /<strong>strong<\/strong>/);
  assert.match(h, /<code>x &lt; y<\/code>/);
});
test('links', () => {
  assert.match(conv('see [site](https://example.com)'), /<a href="https:\/\/example\.com">site<\/a>/);
});
test('fenced code blocks are escaped and not formatted', () => {
  const h = conv('```\n<b>*not em*</b>\n```');
  assert.match(h, /<pre><code>&lt;b&gt;\*not em\*&lt;\/b&gt;<\/code><\/pre>/);
});
test('unordered and ordered lists', () => {
  assert.match(conv('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(conv('1. a\n2. b'), /<ol><li>a<\/li><li>b<\/li><\/ol>/);
});
test('blockquotes', () => {
  assert.match(conv('> quoted'), /<blockquote>(<p>)?quoted(<\/p>)?<\/blockquote>/);
});
test('html in text is escaped', () => {
  assert.match(conv('a <script> b'), /a &lt;script&gt; b/);
});
test('mixed document keeps block order', () => {
  const h = conv('# T\n\nintro\n\n- x\n- y\n\n```\ncode\n```\n\n> q');
  const order = ['<h1>', '<p>intro', '<ul>', '<pre>', '<blockquote>'].map(t => h.indexOf(t));
  assert.ok(order.every(i => i >= 0), h);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});
