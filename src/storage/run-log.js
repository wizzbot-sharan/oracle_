import { newId } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';

export class RunLog {
  constructor(store) {
    this.store = store;
  }

  async append(type, payload = {}) {
    const event = { eventId: newId('evt'), type, at: nowIso(), ...payload };
    await this.store.update('runs', [], rows => [...rows, event]);
    return event;
  }
}
