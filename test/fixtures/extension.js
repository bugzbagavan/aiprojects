const { chromium } = require('@playwright/test');
const path = require('path');

async function launchExtension() {
  const extensionPath = path.resolve(
    __dirname,
    '../../tab-recorder-extension/dist'
  );

  const context = await chromium.launchPersistentContext('', {
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  return context;
}

module.exports = {
  launchExtension,
};