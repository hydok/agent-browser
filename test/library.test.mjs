// Unit test for bookmark/history storage (no Electron needed). Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { Library } = createRequire(import.meta.url)('../dist/main/library.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ab-lib-'));

test('북마크 토글과 재시작 후 유지', () => {
  const dir = tmp();
  const lib = new Library(dir);
  assert.equal(lib.toggleBookmark('https://a.com/', 'A'), true);
  assert.equal(lib.isBookmarked('https://a.com/'), true);
  assert.equal(new Library(dir).isBookmarked('https://a.com/'), true);
  assert.equal(lib.toggleBookmark('https://a.com/', 'A'), false);
  assert.equal(new Library(dir).bookmarks.length, 0);
});

test('방문 기록: 최신순, 연속 중복 합침, 제목 갱신, http/file만 기록', () => {
  const dir = tmp();
  const lib = new Library(dir);
  lib.addVisit('https://a.com/', '');
  lib.updateTitle('https://a.com/', 'A 사이트');
  lib.addVisit('https://b.com/', 'B');
  lib.addVisit('https://b.com/', 'B');
  lib.addVisit('about:blank', '');
  lib.addVisit('chrome://settings', '');
  assert.deepEqual(lib.history.map((h) => [h.url, h.title]), [['https://b.com/', 'B'], ['https://a.com/', 'A 사이트']]);
  lib.saveHistory();
  assert.equal(new Library(dir).history.length, 2);
  lib.clearHistory();
  assert.equal(new Library(dir).history.length, 0);
});

test('방문 기록은 2000개까지만 보관', () => {
  const lib = new Library(tmp());
  for (let i = 0; i < 2100; i++) lib.addVisit(`https://x.com/${i}`, '');
  assert.equal(lib.history.length, 2000);
  assert.equal(lib.history[0].url, 'https://x.com/2099');
  lib.saveHistory();
});
