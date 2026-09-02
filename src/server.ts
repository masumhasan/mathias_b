import 'dotenv/config';
import http from 'http';
import cron from 'node-cron';
import app from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { emailSyncService } from './services/emailSyncService';
import { seedSuperAdmin } from './services/seedAdminService';
import logger from './utils/logger';

const PORT = parseInt(process.env.PORT || '3005', 10);
const SYNC_SCHEDULE = process.env.SYNC_SCHEDULE || '0 0 * * *'; // Every 24 hours (daily at midnight)

async function start(): Promise<void> {
  await connectDatabase();
  logger.info('Database connected');

  await seedSuperAdmin();

  const server = http.createServer(app);

  server.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}`, {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: PORT,
    });
  });

  const emailSyncEnabled = process.env.EMAIL_SYNC_ENABLED === 'true';

  if (emailSyncEnabled) {
    // Initial sync on startup — runs in background, does not block server start
    logger.info('Starting initial email sync...');
    emailSyncService.sync().catch((err: Error) =>
      logger.error('Initial sync error', { error: err.message }),
    );

    // 24-hour recurring sync
    cron.schedule(SYNC_SCHEDULE, () => {
      logger.info('Scheduled sync triggered');
      emailSyncService.sync().catch((err: Error) =>
        logger.error('Scheduled sync error', { error: err.message }),
      );
    });

    logger.info(`Email sync scheduled: ${SYNC_SCHEDULE}`);
  } else {
    logger.info('Email sync is disabled via EMAIL_SYNC_ENABLED configuration');
  }

  // Graceful shutdown — synchronous signal handler, disconnect happens inside server.close callback
  const shutdown = (signal: string): void => {
    logger.info(`${signal} received — shutting down gracefully`);

    server.close(() => {
      disconnectDatabase()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });

    // Force exit after 30 seconds if connections don't drain
    setTimeout(() => process.exit(1), 30_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
    process.exit(1);
  });
}

start().catch((err: Error) => {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});
