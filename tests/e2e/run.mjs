// End-to-end browser test. Starts the server with the scripted fake AI client
// (tests/e2e/fake-ai.js) and drives the real UI with Playwright.
// Usage: node tests/e2e/run.mjs [screenshotDir]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const shots = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'pps-shots'));
fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pps-e2e-'));
const fx = path.join(dataDir, 'fixtures');
execFileSync(process.execPath, [path.join(root, 'tests/fixtures/make-fixtures.mjs'), fx]);

const SINGLE = process.env.PPS_SINGLE_FILE ? path.resolve(process.env.PPS_SINGLE_FILE) : null;
const PORT = 3200 + Math.floor(Math.random() * 500);
const server = SINGLE ? { kill() {}, stdout: { on() {} }, stderr: { on() {} } } : spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TEST_FAKE_AI_MODULE: 'tests/e2e/fake-ai.js', ANTHROPIC_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
if (!SINGLE) await new Promise((r) => setTimeout(r, 1500));
const BASE = SINGLE ? `file://${SINGLE}` : `http://localhost:${PORT}`;
const at = (hash) => (SINGLE ? `${BASE}${hash}` : `${BASE}/${hash}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
const shot = async (name) => { await page.waitForTimeout(350); return page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false }); };
const step = (s) => console.log(`• ${s}`);

try {
  step('Dashboard');
  await page.goto(at(''));
  await page.getByRole('heading', { name: 'What are you studying today?' }).waitFor();
  await shot('01-dashboard');

  step('New workspace');
  await page.locator('[data-q="new"]').first().click();
  await page.locator('#nw').fill('Year 6 Study Session');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('heading', { name: 'Year 6 Study Session' }).waitFor();

  step('Add a book and choose the edition');
  await page.locator('#bf-title').fill('Collins Busy Ants Maths Book 6A');
  await page.locator('#book-form button[type=submit]').click();
  await page.getByText('Busy Ant Maths Pupil Book 6B').waitFor({ timeout: 15000 });
  await shot('02-candidates');
  await page.locator('[data-choose]').first().click();
  await page.getByText('Access limitations').waitFor({ timeout: 15000 });
  await shot('03-research');
  assert.ok(await page.getByText('Access Limited').first().isVisible());

  step('Upload documents');
  await page.locator('.stepper [data-step="uploads"]').click();
  await page.locator('#file-input').setInputFiles([path.join(fx, 'sample-maths-book.pdf'), path.join(fx, 'water-cycle.docx'), path.join(fx, 'ww1-history.pptx')]);
  await page.waitForFunction(() => document.querySelectorAll('.src-item').length === 4 && !document.querySelector('.badge.busy'), null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await shot('04-uploads');

  step('Select pages with printed numbering and exclusions');
  await page.locator('.stepper [data-step="pages"]').click();
  await page.locator('[data-ptab]').nth(1).click();
  await page.getByText('Printed page numbers differ').waitFor();
  await page.locator('[data-mode="custom"]').click();
  await page.locator('#sel-ranges').fill('1-8');
  await page.locator('#sel-exclude').fill('3');
  await page.getByText('Missing (1):').waitFor({ timeout: 5000 });
  await page.waitForTimeout(700);
  await shot('05-pages');
  const preview = await page.locator('#sel-preview').innerText();
  assert.match(preview, /6 pages will be used/);
  assert.match(preview, /Excluded: 3/);

  step('Deselect the book (no content) and the slides, summarise at level 2');
  const book = page.locator('.src-item').first().locator('input[type=checkbox]');
  await book.uncheck();
  await page.waitForTimeout(500);
  await page.locator('.src-item').nth(3).locator('input[type=checkbox]').uncheck();
  await page.waitForTimeout(500);
  await page.locator('.stepper [data-step="mode"]').click();
  await page.locator('[data-pickmode="summarize"]').click();
  await page.locator('[data-level="2"]').click();
  await shot('06-settings');
  await page.locator('.stepper [data-step="start"]').click();
  await shot('07-start');
  await page.locator('[data-act="start"]').click();
  await page.locator('#doc').waitFor({ timeout: 20000 });
  await page.waitForTimeout(400);
  await shot('08-summary');
  assert.ok(await page.getByText('All citations verified').isVisible());

  step('Open a citation');
  await page.locator('#doc .cite').first().click();
  await page.getByText('Where did this come from?').waitFor();
  await page.locator('.unit-text').first().waitFor();
  await shot('09-citation');
  await page.keyboard.press('Escape');

  step('Change detail level');
  await page.locator('#lvl').selectOption('5');
  await page.getByText('Low detail').first().waitFor({ timeout: 15000 });
  await page.locator('#doc').waitFor({ timeout: 20000 });

  step('Quiz me on this (test mode)');
  await page.locator('[data-a="quiz"]').click();
  await page.locator('#qs-count').selectOption('5');
  await page.getByRole('button', { name: 'Create quiz' }).click();
  await page.locator('.qcard').waitFor({ timeout: 20000 });
  await shot('10-quiz-q1');
  // Q1 numeric 384 × 27: hint disabled in test mode before submit
  assert.equal(await page.locator('[data-a="hint"]').count(), 0);
  await page.locator('#ans').fill('10,368');
  await page.locator('[data-a="submit"]').click();
  await page.getByText('Correct!').first().waitFor();
  await page.getByText('Step-by-step working').waitFor();
  await shot('11-quiz-working');
  await page.locator('[data-a="next"]').click();
  // Q2 MCQ: choose wrong answer
  await page.locator('[data-opt="0"]').click();
  await page.locator('[data-a="submit"]').click();
  await page.getByText('Not quite').waitFor();
  await shot('12-quiz-wrong');
  await page.locator('[data-a="next"]').click();
  await page.locator('[data-opt="0"]').click();
  await page.locator('[data-a="submit"]').click();
  await page.getByText('Correct!').first().waitFor();
  await page.locator('[data-a="next"]').click();
  // Q4 written: wrong then teacher explanation
  await page.locator('#ans').fill('You just guess');
  await page.locator('[data-a="submit"]').click();
  await page.getByText('Where it went wrong').waitFor();
  await page.locator('[data-a="finish"]').last().click();
  page.once('dialog', (d) => d.accept());
  await page.locator('[data-a="finish"]').last().click().catch(() => {});
  await page.getByRole('heading', { name: 'Quiz results' }).waitFor({ timeout: 10000 });
  await shot('13-quiz-results');
  assert.ok(await page.getByText('Topics to improve').isVisible());

  step('Results list expands');
  await page.locator('.qlist-item summary').nth(1).click();
  await shot('13b-results-detail');

  step('Generate another quiz');
  await page.locator('[data-r="another"]').click();
  await page.locator('.qcard').waitFor({ timeout: 20000 });

  step('Learning mode quiz: hint, working, explain step, retry, reveal');
  await page.goto(at('#/workspaces'));
  await page.locator('.card.link').first().click();
  await page.locator('.stepper [data-step="mode"]').click();
  await page.locator('[data-pickmode="quiz"]').click();
  await page.locator('[data-seg="mode"] [data-v="learning"]').click();
  await page.locator('[data-seg="count"] [data-v="5"]').click();
  await page.locator('.stepper [data-step="start"]').click();
  await page.locator('[data-act="start"]').click();
  await page.locator('.qcard').waitFor({ timeout: 20000 });
  await page.locator('[data-a="hint"]').click();
  await page.getByText('Hint 1:').waitFor();
  await page.locator('[data-a="working"]').click();
  await page.getByText('Step-by-step working').waitFor();
  await page.locator('[data-explain^="step:"]').first().click();
  await page.waitForFunction(() => !document.querySelector('[data-explain="step:0"]'), null, { timeout: 15000 });
  await page.locator('#ans').fill('999');
  await page.locator('[data-a="submit"]').click();
  await page.locator('[data-a="retry"]').waitFor();
  await shot('16-learning-retry');
  await page.locator('[data-a="retry"]').click();
  await page.locator('#ans').fill('10368');
  await page.locator('[data-a="submit"]').click();
  await page.getByText('Correct!').first().waitFor();
  await page.locator('[data-a="next"]').click();
  await page.locator('[data-a="reveal"]').click();
  await page.getByText('Answer', { exact: true }).waitFor();

  step('Compare sources needs two sources and works');
  await page.goto(at('#/workspaces'));
  await page.locator('.card.link').first().click();
  await page.locator('.stepper [data-step="mode"]').click();
  await page.locator('[data-pickmode="compare"]').click();
  await page.locator('[data-level="4"]').click();
  await page.locator('.stepper [data-step="start"]').click();
  await page.locator('[data-act="start"]').click();
  await page.locator('#doc').waitFor({ timeout: 20000 });
  assert.match(await page.locator('h1').first().innerText(), /Source comparison/);

  step('Study mode');
  await page.goto(at('#/workspaces'));
  await page.locator('.card.link').first().click();
  await page.locator('.stepper [data-step="mode"]').click();
  await page.locator('[data-pickmode="study"]').click();
  await page.locator('.stepper [data-step="start"]').click();
  await page.locator('[data-act="start"]').click();
  await page.locator('.msg.assistant .prose').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  await page.locator('[data-quick="example"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.msg.assistant').length >= 2, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  await shot('14-study');

  step('Mobile layout');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(at('#/'));
  await page.getByRole('heading', { name: 'What are you studying today?' }).waitFor();
  await shot('15-mobile-dashboard');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'no horizontal scroll on mobile');

  assert.deepEqual(errors, [], `browser errors:\n${errors.join('\n')}`);
  console.log(`\nE2E PASSED. Screenshots in ${shots}`);
} catch (err) {
  await shot('zz-failure').catch(() => {});
  console.error('\nE2E FAILED:', err.message);
  console.error(errors.join('\n'));
  console.error(serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
