import { app } from './api/server';
import { config } from './config';
import { initDb } from './db/database';
import { logger } from './logger';

async function bootstrap() {
  try {
    await initDb();

    const server = app.listen(config.PORT, () => {
      logger.info(`Server listening on port ${config.PORT}`);
    });

    process.on('SIGTERM', () => {
      logger.info('SIGTERM received — draining connections');
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 30_000);
    });
  } catch (error) {
    logger.error('Failed to start application', { error: String(error) });
    process.exit(1);
  }
}

bootstrap();
