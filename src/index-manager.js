'use strict';

const { buildIndexAsync, validateRoot } = require('./indexer');
const { CallGraphStore } = require('./store');

const DEFAULT_ERROR_MESSAGE_LIMIT = 500;

function boundedMessage(error, rootPath) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [rootPath, String(rootPath).replace(/\\/gu, '/')]) {
    if (value) message = message.split(value).join('<configured-root>');
  }
  return message.slice(0, DEFAULT_ERROR_MESSAGE_LIMIT);
}

class IndexManager {
  constructor(rootPath, options = {}) {
    Object.defineProperty(this, 'rootPath', {
      value: options.skipValidation ? rootPath : validateRoot(rootPath),
      enumerable: true,
      writable: false,
      configurable: false,
    });
    this._build = options.buildIndex || buildIndexAsync;
    this._storeFactory = options.storeFactory || (() => new CallGraphStore());
    this._store = null;
    this._activeBuild = null;
    this.state = 'idle';
    this.generation = 0;
    this.lastError = null;
    this.lastAttemptAt = null;
  }

  get store() {
    return this._store;
  }

  get hasUsableIndex() {
    return this._store !== null;
  }

  snapshot() {
    return {
      state: this.state,
      generation: this.generation,
      hasUsableIndex: this.hasUsableIndex,
      indexedAt: this._store?.stats?.indexedAt || null,
      lastAttemptAt: this.lastAttemptAt,
      lastError: this.lastError,
      stats: this._store?.stats || null,
      diagnostics: this._store?.diagnostics || [],
    };
  }

  start() {
    return this._runBuild();
  }

  reindex() {
    return this._runBuild();
  }

  _runBuild() {
    if (this._activeBuild) return this._activeBuild;

    this.state = 'building';
    this.lastAttemptAt = new Date().toISOString();
    const nextGeneration = this.generation + 1;

    this._activeBuild = (async () => {
      try {
        const result = await this._build(this.rootPath);
        const nextStore = this._storeFactory();
        const stats = { ...result.stats, generation: nextGeneration };
        nextStore.load({ ...result, stats });
        nextStore.diagnostics = Object.freeze([...(result.diagnostics || [])]);

        // Publish only after the complete generation has been built and loaded.
        this._store = nextStore;
        this.generation = nextGeneration;
        this.state = 'ready';
        this.lastError = null;
        return this.snapshot();
      } catch (error) {
        this.state = 'failed';
        this.lastError = boundedMessage(error, this.rootPath);
        throw error;
      } finally {
        this._activeBuild = null;
      }
    })();
    return this._activeBuild;
  }
}

module.exports = { IndexManager };
