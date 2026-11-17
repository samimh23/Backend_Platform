import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { HealthRepo } from './health.service.js';

export class DrizzleHealthRepo implements HealthRepo {
  constructor(private readonly db: Db) {}

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }
}
