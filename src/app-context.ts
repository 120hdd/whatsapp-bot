import type { AppConfig } from './config/schema.js';
import { Database } from './db/database.js';
import {
  AuditRepository,
  AuthRepository,
  ControllerRepository,
  DestinationRepository,
  JobRepository,
  MediaRepository,
  StateRepository,
} from './db/repositories/index.js';
import { HealthService } from './health/health-service.js';
import { createLogger } from './logging/logger.js';
import { MessageService } from './messaging/message-service.js';

export function createAppContext(config: AppConfig) {
  const database = new Database(config.databasePath);
  database.open();
  database.migrate();
  const audit = new AuditRepository(database);
  const auth = new AuthRepository(database);
  const controller = new ControllerRepository(database);
  const destinations = new DestinationRepository(database);
  const jobs = new JobRepository(database);
  const media = new MediaRepository(database);
  const state = new StateRepository(database);
  const logger = createLogger(config);
  const messages = new MessageService(destinations, jobs, media, config);
  const health = new HealthService(database, jobs, state, auth, config);
  return {
    config,
    database,
    audit,
    auth,
    controller,
    destinations,
    jobs,
    media,
    state,
    logger,
    messages,
    health,
    close: () => database.close(),
  };
}

export type AppContext = ReturnType<typeof createAppContext>;
