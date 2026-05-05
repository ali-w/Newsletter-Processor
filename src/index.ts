import { app } from './api/server';
import { config } from './config';
import { initDb } from './db/database';

async function bootstrap() {
  try {
    // Initialize Database
    await initDb();

    // Start server
    app.listen(config.PORT, () => {
      console.log(`🚀 Server listening on port ${config.PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start application:', error);
    process.exit(1);
  }
}

bootstrap();
