import { AppError } from '../../shared/errors.js';

export interface HealthRepo {
  ping(): Promise<void>;
}

export class HealthService {
  constructor(private readonly repo: HealthRepo) {}

  async checkDatabase(): Promise<void> {
    try {
      await this.repo.ping();
    } catch {
      throw new AppError('DATABASE_DOWN', 'Database is not reachable', 503);
    }
  }
}
