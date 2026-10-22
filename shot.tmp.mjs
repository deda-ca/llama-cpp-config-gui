// Temporary screenshot helper (playwright-core + system chrome).
import { chromium } from 'playwright-core';

const url = process.env.SHOT_URL || 'http://localhost:3901';
const out = process.argv[2] || 'shot.png';
const mode = process.argv[3] || 'launch';

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--headless=new', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await page.goto(url, { waitUntil: 'networkidle' });

// Engines tab
await page.click('button.tab:has-text("Engines")');
await page.waitForTimeout(400);

// Open the editor for the first instance (gear button)
await page.click('.engine-block .row-btn[title="Configure"]');
await page.waitForTimeout(500);

if (mode === 'command') {
  await page.click('.tab-btn:has-text("Command")');
  await page.waitForTimeout(900);
}

if (mode === 'picker') {
  await page.click('button:has-text("+ Add Parameter")');
  await page.waitForTimeout(400);
}

await page.screenshot({ path: out });
await browser.close();
console.log('wrote', out);
