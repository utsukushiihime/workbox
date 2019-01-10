/*
  Copyright 2019 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

/* global Workbox, sinon */
/* eslint-disable no-console */


const {expect} = require('chai');
const templateData = require('../../../infra/testing/server/template-data');
const waitUntil = require('../../../infra/testing/wait-until');

// Store local references of these globals.
const {webdriver, server} = global.__workbox;

/**
 * Executes the passed function (and args) async and logs any errors that
 * occur. Errors are assumed to be passed to the callback as an object
 * with the `error` property.
 *
 * @param {...*} args
 * @return {*}
 */
const executeAsyncAndCatch = async (...args) => {
  const result = await webdriver.executeAsyncScript(...args);

  if (result && result.error) {
    console.error(result.error);
    throw new Error('Error executing async script');
  }
  return result;
};

/**
 * Gets the window handle of the last openned tab.
 *
 * @return {string}
 */
const getLastWindowHandle = async () => {
  const allHandles = await webdriver.getAllWindowHandles();
  return allHandles[allHandles.length - 1];
};

/**
 * Opens a new window for the passed URL. If no URL is passed, a blank page
 * is opened.
 *
 * @param {string} url
 * @param {Object} options
 * @return {string}
 */
const openNewTab = async (url) => {
  await webdriver.executeAsyncScript((url, cb) => {
    window.open(url);
    cb();
  }, url);

  const lastHandle = await getLastWindowHandle();
  await webdriver.switchTo().window(lastHandle);

  // Return the handle of the window that was just opened.
  return lastHandle;
};

/**
 * Waits for the current window to load if it's not already loaded.
 */
const windowLoaded = async () => {
  // Wait for the window to load, so the `Workbox` global is available.
  await executeAsyncAndCatch(async (cb) => {
    try {
      if (document.readyState === 'complete') {
        cb();
      } else {
        addEventListener('load', () => cb());
      }
    } catch (error) {
      cb({error: error.stack});
    }
  });
};

/**
 * Unregisters any active SWs so the next page load can start clean.
 * Note: a new page load is needed before controlling SWs stop being active.
 */
const unregisterAllSws = async () => {
  await executeAsyncAndCatch(async (cb) => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        await reg.unregister();
      }
      cb();
    } catch (error) {
      cb({error: error.stack});
    }
  });
};

const testServerOrigin = server.getAddress();
const testPath = `${testServerOrigin}/test/workbox-window/static/`;
const unitTestPath = `${testServerOrigin}/test/workbox-window/unit/`;

describe(`[workbox-window]`, function() {
  it(`passes all unit tests`, async function() {
    // Don't retry failed unit tests.
    this.retries(0);

    await webdriver.get(unitTestPath);

    // In dev mode, stub the environment variables.
    if (process.env.NODE_ENV !== 'production') {
      await webdriver.executeScript(() => {
        self.process = {env: {NODE_ENV: 'dev'}};
        console.info(self.process);
      });
    }

    // Wait until the mocha tests are finished.
    await waitUntil(async () => {
      return await webdriver.executeScript(() => self.mochaResults);
    }, 120, 500); // Retry for 60 seconds.

    const results = await webdriver.executeScript(() => self.mochaResults);

    if (results.failures > 0) {
      console.log(`\n${results.failures} test failure(s):`);

      for (const report of results.reports) {
        console.log('');
        console.log('Name     : ', report.name);
        console.log('Message  : ', report.message);
        console.log('Error    : ', report.stack);
      }
      console.log('');

      throw new Error('Unit tests failed, see logs above for details');
    }
  });
});

describe(`[workbox-window] Workbox`, function() {
  beforeEach(async function() {
    templateData.assign({version: '1'});
    await webdriver.get(testPath);
    await windowLoaded();
  });

  afterEach(async function() {
    await unregisterAllSws();
  });

  describe('register', () => {
    it(`registers a new service worker`, async function() {
      const result = await executeAsyncAndCatch(async (cb) => {
        try {
          const wb = new Workbox('sw-clients-claim.tmp.js');
          await wb.register();

          const reg = await navigator.serviceWorker.getRegistration();
          const sw = reg.installing || reg.waiting || reg.active;

          cb({scriptUrl: sw.scriptURL});
        } catch (error) {
          cb({error: error.stack});
        }
      });

      expect(result.scriptUrl).to.equal(`${testPath}sw-clients-claim.tmp.js`);
    });

    it(`reports all events for a new SW registration`, async function() {
      const result = await executeAsyncAndCatch(async (cb) => {
        try {
          const wb = new Workbox('sw-clients-claim.tmp.js');
          await wb.register();

          const installedSpy = sinon.spy();
          const waitingSpy = sinon.spy();
          const activatedSpy = sinon.spy();
          const controllingSpy = sinon.spy();

          wb.addEventListener('installed', installedSpy);
          wb.addEventListener('waiting', waitingSpy);
          wb.addEventListener('activated', activatedSpy);
          wb.addEventListener('controlling', controllingSpy);

          wb.addEventListener('controlling', () => {
            cb({
              installedSpyCallCount: installedSpy.callCount,
              waitingSpyCallCount: waitingSpy.callCount,
              activatedSpyCallCount: activatedSpy.callCount,
              controllingSpyCallCount: controllingSpy.callCount,
            });
          });
        } catch (error) {
          cb({error: error.stack});
        }
      });

      expect(result.installedSpyCallCount).to.equal(1);
      expect(result.activatedSpyCallCount).to.equal(1);
      expect(result.controllingSpyCallCount).to.equal(1);

      //  A new installation shouldn't enter the waiting phase.
      expect(result.waitingSpyCallCount).to.equal(0);
    });

    it(`reports all events for an external SW registration`, async function() {
      const firstTab = await getLastWindowHandle();

      await executeAsyncAndCatch(async (cb) => {
        try {
          const wb = new Workbox('sw-clients-claim.tmp.js');
          await wb.register();

          // Use a global variable so these are accessible to future
          // `executeAsyncAndCatch()` calls.
          self.__spies = {
            installedSpy: sinon.spy(),
            waitingSpy: sinon.spy(),
            activatedSpy: sinon.spy(),
            controllingSpy: sinon.spy(),
            externalInstalledSpy: sinon.spy(),
            externalActivatedSpy: sinon.spy(),
          };

          wb.addEventListener('installed', self.__spies.installedSpy);
          wb.addEventListener('waiting', self.__spies.waitingSpy);
          wb.addEventListener('activated', self.__spies.activatedSpy);
          wb.addEventListener('controlling', self.__spies.controllingSpy);
          wb.addEventListener('externalInstalled', self.__spies.externalInstalledSpy);
          wb.addEventListener('externalActivated', self.__spies.externalActivatedSpy);

          // Resolve this execution block once the SW is controlling.
          wb.addEventListener('controlling', () => cb());
        } catch (error) {
          cb({error: error.stack});
        }
      });

      // Update the version in sw.js to trigger a new installation.
      templateData.assign({version: '2'});

      await openNewTab(testPath);
      await windowLoaded();

      await executeAsyncAndCatch(async (cb) => {
        try {
          const wb = new Workbox('sw-clients-claim.tmp.js');
          await wb.register();

          // Resolve this execution block once the SW is controlling.
          wb.addEventListener('controlling', () => cb());
        } catch (error) {
          cb({error: error.stack});
        }
      });

      // Close the second tab and switch back to the first tab before
      // executing the following block.
      await webdriver.close();
      await webdriver.switchTo().window(firstTab);

      const result = await executeAsyncAndCatch(async (cb) => {
        try {
          cb({
            installedSpyCallCount: self.__spies.installedSpy.callCount,
            waitingSpyCallCount: self.__spies.waitingSpy.callCount,
            activatedSpyCallCount: self.__spies.activatedSpy.callCount,
            controllingSpyCallCount: self.__spies.controllingSpy.callCount,
            externalInstalledSpyCallCount: self.__spies.externalInstalledSpy.callCount,
            externalActivatedSpyCallCount: self.__spies.externalActivatedSpy.callCount,
          });
        } catch (error) {
          cb({error: error.stack});
        }
      });

      expect(result.installedSpyCallCount).to.equal(1);
      expect(result.activatedSpyCallCount).to.equal(1);
      expect(result.controllingSpyCallCount).to.equal(1);
      expect(result.externalInstalledSpyCallCount).to.equal(1);
      expect(result.externalActivatedSpyCallCount).to.equal(1);

      // The waiting phase should have been skipped.
      expect(result.waitingSpyCallCount).to.equal(0);
    });

    it(`notifies a controlling SW that the window is ready`, async function() {
      // Register a SW and wait until it's controlling the page since
      // ready messages are only sent to controlling SWs with matching URLs.
      await executeAsyncAndCatch(async (cb) => {
        try {
          const wb = new Workbox('sw-window-ready.js');
          await wb.register();

          wb.addEventListener('controlling', () => cb());
        } catch (error) {
          cb({error: error.stack});
        }
      });

      const result = await executeAsyncAndCatch(async (cb) => {
        try {
          const readyMessageReceived = new Promise((resolve) => {
            navigator.serviceWorker.addEventListener('message', (event) => {
              if (event.data.type === 'sw:message:ready') {
                resolve();
              }
            });
          });

          const wb = new Workbox('sw-window-ready.js');
          wb.register();

          await readyMessageReceived;
          cb(true);
        } catch (error) {
          cb({error: error.stack});
        }
      });

      expect(result).to.equal(true);
    });
  });
});