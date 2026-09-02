const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

async function launchExtension() {
  const extensionPath = path.resolve(
    __dirname,
    '../../tab-recorder-extension/dist'
  );

  console.log('Extension path:', extensionPath);

  if (!fs.existsSync(extensionPath)) {
    throw new Error(
      `Extension directory does not exist: ${extensionPath}`
    );
  }

  const manifestPath = path.join(
    extensionPath,
    'manifest.json'
  );

  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Extension manifest does not exist: ${manifestPath}`
    );
  }

  const backgroundPath = path.join(
    extensionPath,
    'background.js'
  );

  if (!fs.existsSync(backgroundPath)) {
    throw new Error(
      [
        'Extension background service worker does not exist.',
        '',
        `Expected: ${backgroundPath}`,
        '',
        'Check the Build Chrome extension step.'
      ].join('\n')
    );
  }

  console.log('Extension manifest found.');
  console.log('Extension background.js found.');

  const context = await chromium.launchPersistentContext('', {
    headless: true,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  console.log('Chromium launched.');
  console.log('Waiting for extension service worker...');

  try {
    let serviceWorker = context.serviceWorkers()[0];

    if (!serviceWorker) {
      try {
        serviceWorker = await context.waitForEvent(
          'serviceworker',
          { timeout: 15000 }
        );
      } catch (error) {
        console.error(
          'Extension service worker was not detected.'
        );

        console.error(
          'Currently registered service workers:',
          context.serviceWorkers().map(worker => worker.url())
        );

        console.error(
          'Current pages:',
          context.pages().map(page => page.url())
        );

        throw new Error(
          [
            'BugScribe extension failed to start.',
            '',
            `Extension path: ${extensionPath}`,
            '',
            'Expected service worker:',
            'background.js',
            '',
            'The extension was loaded but Chromium did not register',
            'the Manifest V3 background service worker.'
          ].join('\n')
        );
      }
    }

    console.log(
      'Extension service worker detected:',
      serviceWorker.url()
    );

    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

module.exports = {
  launchExtension,
};