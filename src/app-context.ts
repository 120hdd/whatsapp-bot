import type { AppConfig } from './config/schema.js';
import { Database } from './db/database.js';
import {
  AuditRepository,
  AuthRepository,
  BatchRepository,
  ControllerRepository,
  DestinationRepository,
  GroupSetRepository,
  JobRepository,
  MediaRepository,
  StateRepository,
} from './db/repositories/index.js';
import { HealthService } from './health/health-service.js';
import { createLogger } from './logging/logger.js';
import { MessageService } from './messaging/message-service.js';
import { BulkMessageService } from './messaging/bulk-message-service.js';

export function createAppContext(config: AppConfig) {
  const database = new Database(config.databasePath);
  database.open();
  database.migrate();
  const audit = new AuditRepository(database);
  const auth = new AuthRepository(database);
  const batches = new BatchRepository(database);
  const controller = new ControllerRepository(database);
  const destinations = new DestinationRepository(database);
  const groupSets = new GroupSetRepository(database);
  const jobs = new JobRepository(database);
  const media = new MediaRepository(database);
  const state = new StateRepository(database);
  const logger = createLogger(config);
  const messages = new MessageService(destinations, jobs, media, config);
  const bulkMessages = new BulkMessageService(messages, batches, logger);
  const health = new HealthService(database, jobs, state, auth, config);
  return {
    config,
    database,
    audit,
    auth,
    batches,
    controller,
    destinations,
    groupSets,
    jobs,
    media,
    state,
    logger,
    messages,
    bulkMessages,
    health,
    close: () => database.close(),
  };
}

export type AppContext = ReturnType<typeof createAppContext>;
