'use strict';

const Module = require('node:module');

function loadWithMocks(modulePath, mocks = {}) {
  const resolved = require.resolve(modulePath);
  const originalLoad = Module._load;

  delete require.cache[resolved];
  Module._load = function mockedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

async function withMockedModules(mocks, callback) {
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return await callback();
  } finally {
    Module._load = originalLoad;
  }
}

module.exports = { loadWithMocks, withMockedModules };
