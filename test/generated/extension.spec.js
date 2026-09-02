const { test, expect } = require('@playwright/test');
const { launchExtension } = require('../fixtures/extension');

test.describe('BugScribe Chrome Extension Tests', () => {
  test('TC-001 - Load extension in Chrome', async () => {
    const context = await launchExtension();

    try {
      const serviceWorkers = context.serviceWorkers();

      expect(serviceWorkers.length).toBeGreaterThan(0);

      const serviceWorker = serviceWorkers[0];

      expect(serviceWorker).toBeTruthy();
      expect(serviceWorker.url()).toMatch(/^chrome-extension:\/\//);
    } finally {
      await context.close();
    }
  });
});