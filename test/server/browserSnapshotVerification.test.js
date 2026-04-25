import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertVerifiedBrowserSessionSnapshot,
  verifyBrowserSessionSnapshot,
} from '../../server/browser/sessionSnapshot.js';
import { scoreResolvedCandidate } from '../../server/browser/shared.js';
import { extractUrlOrDomain } from '../../server/browser/siteResolutionSupport.js';

test('browser snapshot verification rejects blank and browser error pages', () => {
  assert.equal(verifyBrowserSessionSnapshot({ url: 'about:blank', title: 'Blank' }).ok, false);
  assert.equal(
    verifyBrowserSessionSnapshot({ url: 'chrome-error://chromewebdata/', title: 'Error', screenshotUrl: '/shot.png' }).reason,
    'chrome-error',
  );
});

test('browser snapshot verification rejects HTTP error status when available', () => {
  const result = verifyBrowserSessionSnapshot({
    url: 'https://example.com/missing',
    title: 'Not found',
    readerText: '404',
    screenshotUrl: '/shot.png',
  }, { responseStatus: 404 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'http-status-404');
});

test('browser snapshot verification accepts visible page state', () => {
  const session = {
    url: 'https://example.com/',
    title: 'Example Domain',
    readerText: 'Example Domain',
    screenshotUrl: '/runtime/example.png',
  };

  const verification = assertVerifiedBrowserSessionSnapshot(session, { responseStatus: 200 });
  assert.equal(verification.ok, true);
  assert.equal(verification.hasReaderText, true);
  assert.equal(verification.hasScreenshot, true);
});

test('browser site scoring has local stem similarity available', () => {
  const score = scoreResolvedCandidate('azbyka', 'открой сайт азбука', 'Азбука веры', 'https://azbyka.ru/');
  assert.ok(score > 0.4, `Expected useful score, got ${score}`);
});

test('browser support can extract direct domains without missing regex globals', () => {
  assert.equal(extractUrlOrDomain('open azbyka.ru'), 'https://azbyka.ru');
});
