import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', 'C:/Users/ohuiseok/Desktop/면접준비/sample-interview.csv');
await page.waitForSelector('.cameraPanel', { timeout: 10000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: 'C:/Users/ohuiseok/Desktop/면접준비/ui-practice-screen.png', fullPage: true });
await browser.close();
