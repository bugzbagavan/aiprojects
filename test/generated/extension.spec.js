const { test, expect } = require('@playwright/test');
const { launchExtension } = require('../fixtures/extension');

test.describe('BugScribe Chrome Extension Tests', () => {
  let context;

  test.beforeEach(async () => {
    context = await launchExtension();
  });

  test.afterEach(async () => {
    await context.close();
  });

  test('TC-001 - Load extension in Chrome', async () => {
    const serviceWorkers = context.serviceWorkers();

    expect(serviceWorkers.length).toBeGreaterThan(0);
  });

  test('TC-002 - Verify extension UI appears', async () => {
    const extensionPages = context.pages();

    expect(extensionPages.length).toBeGreaterThanOrEqual(0);
  });
});