import 'reflect-metadata';

// Set environment variables before any module is imported.
// ConfigModule.forRoot() reads process.env synchronously when the @Module()
// decorator runs — these must be present at import time, not just in beforeAll().
if (!process.env['DATABASE_URL'])
  process.env['DATABASE_URL'] = 'postgresql://pureplay:pureplay@localhost:5432/pureplay_ingest';
if (!process.env['REDIS_URL']) process.env['REDIS_URL'] = 'redis://localhost:6379';
if (!process.env['NODE_ENV']) process.env['NODE_ENV'] = 'test';
if (!process.env['WEBHOOK_AUTH_MODE']) process.env['WEBHOOK_AUTH_MODE'] = 'none';
