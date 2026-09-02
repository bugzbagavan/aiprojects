const { chromium } = require('@playwright/test');
const path = require('path');

async function launchExtension() {
  const extensionPath = path.resolve(
    __dirname,
    '../../tab-recorder-extension/dist'
  );

  console.log('Extension path:', extensionPath);

  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  // First check whether the service worker is already available.
  let serviceWorker = context.serviceWorkers()[0];

  // If it has not appeared yet, wait for it.
  if (!serviceWorker) {
    try {
      serviceWorker = await context.waitForEvent('serviceworker', {
        timeout: 15000,
      });
    } catch (error) {
      console.error('Extension service worker was not detected.');

      console.error(
        'Currently registered service workers:',
        context.serviceWorkers().map(worker => worker.url())
      );

      console.error(
        'Current pages:',
        context.pages().map(page => page.url())
      );

      await context.close();

      throw new Error(
        [
          'BugScribe extension failed to start.',
          '',
          `Extension path: ${extensionPath}`,
          '',
          'Expected service worker:',
          'background.js',
          '',
          'Make sure tab-recorder-extension/dist/background.js exists',
          'and that the extension background service worker does not crash.',
        ].join('\n')
      );
    }
  }

  console.log('Extension service worker detected:');
  console.log(serviceWorker.url());

  return context;
}

module.exports = {
  launchExtension,
};