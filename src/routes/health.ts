import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { SyncState } from '../models/SyncState';
import { Email } from '../models/Email';
import { emailSyncService } from '../services/emailSyncService';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

const DB_STATE_LABELS = ['disconnected', 'connected', 'connecting', 'disconnecting'] as const;

router.get('/', (_req: Request, res: Response) => {
  const dbState = mongoose.connection.readyState as number;
  const dbStatus = DB_STATE_LABELS[dbState] ?? 'unknown';

  res.json({
    status: dbState === 1 ? 'healthy' : 'degraded',
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

router.get(
  '/sync-status',
  asyncHandler(async (_req: Request, res: Response) => {
    const [syncStates, totalEmails, emptyBodyCount] = await Promise.all([
      SyncState.find().lean(),
      Email.countDocuments(),
      Email.countDocuments({ textBody: '' }),
    ]);

    res.json({
      isSyncing: emailSyncService.syncing,
      totalEmails,
      emptyBodyCount,
      folders: syncStates.map((s) => ({
        folder: s.folder,
        lastSyncAt: s.lastSyncAt,
        totalSynced: s.totalSynced,
        status: s.status,
        lastError: s.lastError,
      })),
    });
  }),
);

router.post(
  '/repair-bodies',
  asyncHandler(async (_req: Request, res: Response) => {
    const count = await Email.countDocuments({ textBody: '' });
    res.json({
      message: `Found ${count} emails with empty body. Run a fresh sync (POST /api/health/sync) to re-fetch and re-parse them with HTML→text extraction.`,
      emptyBodyCount: count,
    });
  }),
);

router.post(
  '/sync',
  asyncHandler(async (_req: Request, res: Response) => {
    if (process.env.EMAIL_SYNC_ENABLED !== 'true') {
      res.status(403).json({ error: 'Email sync is disabled via configuration' });
      return;
    }
    if (emailSyncService.syncing) {
      res.status(409).json({ error: 'Sync already in progress' });
      return;
    }
    emailSyncService.sync().catch(() => undefined);
    res.json({ message: 'Sync started' });
  }),
);

export default router;
