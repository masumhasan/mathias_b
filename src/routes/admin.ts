import { Router, Request, Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import {
  listLegalAdviceClients,
  getLegalAdviceClient,
  updateLegalAdviceClient,
  setLegalAdviceClientBanned,
  deleteLegalAdviceClient,
  listClientChats,
  getClientChatDetail,
  listRecentActivity,
  listPackages,
  createPackage,
  updatePackage,
  deletePackage,
} from '../services/adminService';
import { asyncHandler, createError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireAdmin } from '../middleware/requireAdmin';
import { emailSyncService } from '../services/emailSyncService';
import { PolicyPage, PolicyType } from '../models/PolicyPage';
import { Service } from '../models/Service';

const router = Router();

const PackageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  price: z.number().min(0),
  description: z.string().trim().min(1).max(2000),
  tier: z.enum(['silver', 'gold', 'platinum']),
});

const UpdateClientSchema = z.object({
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().optional(),
  country: z.string().trim().optional(),
  city: z.string().trim().optional(),
  bio: z.string().trim().max(1000).optional(),
});

const BanClientSchema = z.object({
  banned: z.boolean(),
});

function requireValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) throw createError('Client not found.', 404);
}

/**
 * GET /api/admin/public-packages
 * Public — returns all subscription packages for the subscription selection screen.
 */
router.get(
  '/public-packages',
  asyncHandler(async (_req: Request, res: Response) => {
    const packages = await listPackages();
    res.json({ packages });
  }),
);

router.use(requireAuth, requireAdmin);

/**
 * GET /api/admin/legal-advice-clients
 * Lists every registered user and their /legalchat usage, for the admin dashboard.
 */
router.get(
  '/legal-advice-clients',
  asyncHandler(async (_req: Request, res: Response) => {
    const clients = await listLegalAdviceClients();
    res.json({ clients });
  }),
);

/**
 * GET /api/admin/legal-advice-clients/:id
 * Returns the full profile for one client (the "view account" detail page).
 */
router.get(
  '/legal-advice-clients/:id',
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    const client = await getLegalAdviceClient(req.params.id);
    res.json({ client });
  }),
);

/**
 * PATCH /api/admin/legal-advice-clients/:id
 * Edits a client's profile fields.
 */
router.patch(
  '/legal-advice-clients/:id',
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    const input = UpdateClientSchema.parse(req.body);
    const client = await updateLegalAdviceClient(req.params.id, input);
    res.json({ client });
  }),
);

/**
 * PATCH /api/admin/legal-advice-clients/:id/ban
 * Bans or unbans a client, instantly cutting off any already-issued session.
 */
router.patch(
  '/legal-advice-clients/:id/ban',
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    const { banned } = BanClientSchema.parse(req.body);
    const client = await setLegalAdviceClientBanned(req.params.id, banned);
    res.json({ client });
  }),
);

/**
 * DELETE /api/admin/legal-advice-clients/:id
 * Deletes a client's account and all of their conversations.
 */
router.delete(
  '/legal-advice-clients/:id',
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    await deleteLegalAdviceClient(req.params.id);
    res.status(204).send();
  }),
);

/**
 * GET /api/admin/client-chats
 * Lists every /client-chat portal user and their last message, for the
 * "Client Chats" admin page (formerly "Inbox").
 */
router.get(
  '/client-chats',
  asyncHandler(async (_req: Request, res: Response) => {
    const clients = await listClientChats();
    res.json({ clients });
  }),
);

/**
 * GET /api/admin/client-chats/:id
 * Returns one client's full conversation transcript, for the eye-icon modal.
 */
router.get(
  '/client-chats/:id',
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    const client = await getClientChatDetail(req.params.id);
    res.json({ client });
  }),
);

/**
 * GET /api/admin/activity
 * Lists the most recent audit log entries across the app, for the Overview
 * page's "Recent Activity" feed.
 */
router.get(
  '/activity',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const activity = await listRecentActivity(limit);
    res.json({ activity });
  }),
);

/**
 * GET /api/admin/packages
 * Lists all service packages.
 */
router.get(
  '/packages',
  asyncHandler(async (_req: Request, res: Response) => {
    const packages = await listPackages();
    res.json({ packages });
  }),
);

/**
 * POST /api/admin/packages
 * Creates a new service package.
 */
router.post(
  '/packages',
  asyncHandler(async (req: Request, res: Response) => {
    const input = PackageSchema.parse(req.body);
    const pkg = await createPackage(input);
    res.status(201).json({ package: pkg });
  }),
);

/**
 * PATCH /api/admin/packages/:id
 * Updates an existing service package.
 */
router.patch(
  '/packages/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw createError('Package not found.', 404);
    const input = PackageSchema.parse(req.body);
    const pkg = await updatePackage(req.params.id, input);
    res.json({ package: pkg });
  }),
);

/**
 * DELETE /api/admin/packages/:id
 * Deletes a service package.
 */
router.delete(
  '/packages/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw createError('Package not found.', 404);
    await deletePackage(req.params.id);
    res.status(204).send();
  }),
);

/**
 * POST /api/admin/repair-email-bodies
 * Re-fetches emails from IMAP that have an empty textBody and patches them.
 * Safe to call repeatedly — already-repaired emails are skipped automatically.
 */
router.post(
  '/repair-email-bodies',
  asyncHandler(async (_req: Request, res: Response) => {
    if (emailSyncService.repairing) {
      res.status(409).json({ error: 'Body repair already in progress.' });
      return;
    }
    // Fire-and-forget — repair runs in the background; status is in server logs
    void emailSyncService.repairEmptyBodies();
    res.json({ message: 'Body repair started. Check server logs for progress.' });
  }),
);

const VALID_POLICY_TYPES: PolicyType[] = ['privacy-policy', 'terms-of-service', 'about-us', 'our-team', 'how-it-works'];

/**
 * GET /api/admin/pages/:type
 * Returns current saved content for a policy page.
 */
router.get(
  '/pages/:type',
  asyncHandler(async (req: Request, res: Response) => {
    const type = req.params.type as PolicyType;
    if (!VALID_POLICY_TYPES.includes(type)) throw createError('Page not found.', 404);
    const page = await PolicyPage.findOne({ type }).lean();
    res.json({ content: page?.content ?? '', updatedAt: page?.updatedAt ?? null });
  }),
);

/**
 * POST /api/admin/pages/:type
 * Saves (upserts) the HTML content for a policy page.
 */
router.post(
  '/pages/:type',
  asyncHandler(async (req: Request, res: Response) => {
    const type = req.params.type as PolicyType;
    if (!VALID_POLICY_TYPES.includes(type)) throw createError('Page not found.', 404);
    const { content } = z.object({ content: z.string() }).parse(req.body);
    const page = await PolicyPage.findOneAndUpdate(
      { type },
      { content },
      { upsert: true, new: true },
    );
    res.json({ message: 'Saved.', updatedAt: page.updatedAt });
  }),
);

// ── Service Manager ──────────────────────────────────────────────────────────

const ServiceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(200).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers and hyphens only'),
  content: z.string().default(''),
  order: z.number().int().default(0),
});

/** GET /api/admin/services */
router.get(
  '/services',
  asyncHandler(async (_req: Request, res: Response) => {
    const services = await Service.find().sort({ order: 1, createdAt: 1 }).lean();
    res.json({ services });
  }),
);

/** POST /api/admin/services */
router.post(
  '/services',
  asyncHandler(async (req: Request, res: Response) => {
    const body = ServiceSchema.parse(req.body);
    const existing = await Service.findOne({ slug: body.slug });
    if (existing) throw createError('A service with this slug already exists.', 409);
    const service = await Service.create(body);
    res.status(201).json({ service });
  }),
);

/** PATCH /api/admin/services/:id */
router.patch(
  '/services/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw createError('Invalid ID.', 400);
    const body = ServiceSchema.partial().parse(req.body);
    if (body.slug) {
      const conflict = await Service.findOne({ slug: body.slug, _id: { $ne: req.params.id } });
      if (conflict) throw createError('A service with this slug already exists.', 409);
    }
    const service = await Service.findByIdAndUpdate(req.params.id, body, { new: true });
    if (!service) throw createError('Service not found.', 404);
    res.json({ service });
  }),
);

/** DELETE /api/admin/services/:id */
router.delete(
  '/services/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw createError('Invalid ID.', 400);
    const service = await Service.findByIdAndDelete(req.params.id);
    if (!service) throw createError('Service not found.', 404);
    res.status(204).send();
  }),
);

export default router;
