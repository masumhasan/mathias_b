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
import { ContactInfo } from '../models/ContactInfo';
import { Service } from '../models/Service';
import { Package } from '../models/Package';
import { User } from '../models/User';
import { stripe } from '../services/stripeService';

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

const VALID_POLICY_TYPES: PolicyType[] = ['privacy-policy', 'terms-of-service', 'about-us', 'our-team', 'how-it-works', 'imprint'];

const AdminContactInfoSchema = z.object({
  address: z.string().trim().min(1),
  email: z.string().trim().email(),
});

/**
 * GET /api/admin/contact-info
 */
router.get(
  '/contact-info',
  asyncHandler(async (req: Request, res: Response) => {
    let contact = await ContactInfo.findOne();
    if (!contact) {
      contact = await ContactInfo.create({
        address: '30 N Gould St, Ste N\nSheridan, WY 82801 USA',
        email: 'supporteuvisa@gmail.com',
      });
    }
    res.json(contact);
  }),
);

/**
 * POST /api/admin/contact-info
 */
router.post(
  '/contact-info',
  asyncHandler(async (req: Request, res: Response) => {
    const { address, email } = AdminContactInfoSchema.parse(req.body);
    const contact = await ContactInfo.findOneAndUpdate(
      {},
      { address, email },
      { upsert: true, new: true },
    );
    res.json({ message: 'Saved.', updatedAt: contact.updatedAt });
  }),
);

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

// ── Subscribers list ──────────────────────────────────────────────────────────

/**
 * GET /api/admin/subscribers
 * Returns all users who have ever had a subscription plan, with their
 * current plan, status, amount paid (from the package price), and dates.
 */
router.get(
  '/subscribers',
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const subscribers = await User.find({
      subscriptionPlan: { $ne: 'none' },
      stripeSubscriptionId: { $exists: true, $ne: null },
    })
      .select('firstName lastName email subscriptionPlan subscriptionStatus subscribedAt currentPeriodEnd cancelAtPeriodEnd stripeSubscriptionId')
      .sort({ subscribedAt: -1 })
      .lean();

    // Load packages once for price lookup
    const packages = await Package.find().lean();
    const priceByTier: Record<string, number> = {};
    packages.forEach((p) => { priceByTier[p.tier] = p.price; });

    const result = subscribers.map((u) => ({
      id: (u._id as { toString(): string }).toString(),
      name: `${u.firstName} ${u.lastName}`.trim(),
      email: u.email,
      plan: u.subscriptionPlan,
      status: u.subscriptionStatus ?? 'none',
      amount: priceByTier[u.subscriptionPlan] ?? null,
      subscribedAt: u.subscribedAt ?? null,
      currentPeriodEnd: u.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: u.cancelAtPeriodEnd ?? false,
    }));

    res.json({ subscribers: result, total: result.length });
  }),
);

// ── Stripe revenue stats ──────────────────────────────────────────────────────

/**
 * GET /api/admin/stripe/revenue-stats
 * Returns total revenue (all time), this month's revenue, and total subscriber count.
 */
router.get(
  '/stripe/revenue-stats',
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    // Active subscribers (paid + currently active status)
    const totalSubscribers = await User.countDocuments({
      subscriptionStatus: 'active',
      stripeSubscriptionId: { $exists: true, $ne: null },
    });

    // Pull paid invoices from Stripe (up to 100 per page, accumulate)
    let totalRevenueCents = 0;
    let thisMonthCents = 0;
    const now = new Date();
    const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

    let hasMore = true;
    let startingAfter: string | undefined;
    while (hasMore) {
      const invoices = await stripe.invoices.list({
        status: 'paid',
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const inv of invoices.data) {
        totalRevenueCents += inv.amount_paid;
        if (inv.created >= monthStart) thisMonthCents += inv.amount_paid;
      }
      hasMore = invoices.has_more;
      if (invoices.data.length > 0) startingAfter = invoices.data[invoices.data.length - 1].id;
    }

    res.json({
      totalRevenue: totalRevenueCents / 100,
      thisMonthRevenue: thisMonthCents / 100,
      totalSubscribers,
    });
  }),
);

// ── Stripe: Sync packages to Stripe products/prices ─────────────────────────

/**
 * POST /api/admin/stripe/sync
 * Creates or updates Stripe Products and Prices for all packages,
 * then stores the Stripe IDs back in the Package documents.
 */
router.post(
  '/stripe/sync',
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const packages = await Package.find();
    const results: { tier: string; stripePriceId: string; stripeProductId: string | undefined }[] = [];

    for (const pkg of packages) {
      // Create or update Stripe Product.
      // If the stored product was deleted in Stripe, fall through to create a fresh one.
      let productId: string | undefined = pkg.stripeProductId ?? undefined;
      if (productId) {
        try {
          await stripe.products.update(productId, { name: pkg.name, description: pkg.description });
        } catch {
          // Product no longer exists in Stripe — recreate it
          productId = undefined;
          pkg.stripePriceId = undefined; // old price is gone too
        }
      }
      if (!productId) {
        const product = await stripe.products.create({
          name: pkg.name,
          description: pkg.description,
          metadata: { tier: pkg.tier },
        });
        productId = product.id;
      }

      // Always create a new Price (prices are immutable in Stripe)
      // Archive the old one if it exists
      if (pkg.stripePriceId) {
        try {
          await stripe.prices.update(pkg.stripePriceId, { active: false });
        } catch {
          // Price may already be archived — ignore
        }
      }

      const price = await stripe.prices.create({
        product: productId,
        unit_amount: Math.round(pkg.price * 100), // cents
        currency: 'eur',
        recurring: { interval: 'month' },
        metadata: { tier: pkg.tier },
      });

      pkg.stripeProductId = productId;
      pkg.stripePriceId = price.id;
      await pkg.save();

      results.push({ tier: pkg.tier, stripeProductId: productId, stripePriceId: price.id });
    }

    res.json({ synced: results.length, results });
  }),
);

/**
 * GET /api/admin/stripe/sync-status
 * Returns which packages have been synced to Stripe.
 */
router.get(
  '/stripe/sync-status',
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const packages = await Package.find().select('name tier stripePriceId stripeProductId').lean();
    res.json({
      packages: packages.map((p) => ({
        tier: p.tier,
        name: p.name,
        synced: !!(p.stripePriceId && p.stripeProductId),
        stripePriceId: p.stripePriceId ?? null,
        stripeProductId: p.stripeProductId ?? null,
      })),
    });
  }),
);

export default router;
