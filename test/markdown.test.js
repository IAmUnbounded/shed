import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/markdown.js';

test('agent replies render common Markdown', () => {
  const html = renderMarkdown('## Plan\n\nDo **this** and *that*:\n\n1. First `step`\n2. Second\n\n- a\n- b\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> note\n\n```sh\nnpm test\n```\n\nSee [docs](https://example.com/x?a=1&b=2).');
  assert.match(html, /<h4>Plan<\/h4>/);
  assert.match(html, /<strong>this<\/strong> and <em>that<\/em>/);
  assert.match(html, /<ol><li>First <code>step<\/code><\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<th>A<\/th><th>B<\/th>.*<td>1<\/td><td>2<\/td>/s);
  assert.match(html, /<blockquote>note<\/blockquote>/);
  assert.match(html, /<pre><code>npm test<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/example.com\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
});

test('replies cannot inject markup or script links', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](https://a.com/"onmouseover="alert(1)) `<b>` snake_case_name');
  assert.doesNotMatch(html, /<img|<b>|href="javascript/);
  assert.doesNotMatch(html, /"onmouseover="/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
  assert.match(html, /snake_case_name/, 'underscores inside words are not italics');
});
