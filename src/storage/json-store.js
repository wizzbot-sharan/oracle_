import fs from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  #queues = new Map();

  constructor(dataDir) {
    this.dataDir = dataDir;
  }

  file(name) {
    return path.join(this.dataDir, `${name}.json`);
  }

  async read(name, fallback) {
    try {
      return JSON.parse(await fs.readFile(this.file(name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(fallback);
      throw error;
    }
  }

  async write(name, value) {
    const file = this.file(name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temp, file);
    return value;
  }

  async update(name, fallback, updater) {
    const previous = this.#queues.get(name) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const current = await this.read(name, fallback);
      const next = await updater(structuredClone(current));
      return this.write(name, next);
    });
    this.#queues.set(name, operation.catch(() => {}));
    return operation;
  }
}
