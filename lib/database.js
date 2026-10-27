const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { getDataDirectory } = require("./restaurant-config");

class Database {
  constructor({ dataDir = getDataDirectory(), loadDataDir } = {}) {
    this.engine = loadDataDir
      ? new PGlite({ dataDir, loadDataDir })
      : new PGlite(dataDir);
    this.lock = Promise.resolve();
  }

  async waitReady() {
    await this.engine.waitReady;
  }

  async acquire() {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  }

  async query(text, values = []) {
    const release = await this.acquire();
    try {
      return await this.run(text, values);
    } finally {
      release();
    }
  }

  async run(text, values = []) {
    const result = values.length ? await this.engine.query(text, values) : await this.engine.exec(text);
    const finalResult = Array.isArray(result) ? result.at(-1) : result;
    return {
      ...finalResult,
      rows: finalResult?.rows || [],
      rowCount: finalResult?.rows?.length || finalResult?.affectedRows || 0,
    };
  }

  async connect() {
    const releaseLock = await this.acquire();
    let released = false;
    return {
      query: (text, values = []) => this.run(text, values),
      release: () => {
        if (released) return;
        released = true;
        releaseLock();
      },
    };
  }

  async dumpDataDir() {
    const release = await this.acquire();
    try {
      return await this.engine.dumpDataDir();
    } finally {
      release();
    }
  }

  async end() {
    await this.engine.close();
  }
}

module.exports = { Database };
