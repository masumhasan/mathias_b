import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { stripe } from '../services/stripeService';
import { asyncHandler, createError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/requireAuth';
import { User } from '../models/User';
import { Package } from '../models/Package';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';

/**
 * POST /api/stripe/create-checkout-session
 * Creates a Stripe Checkout session for a subscription tier.
 * Redirects the user to Stripe-hosted checkout.
 */
router.post(
  '/create-checkout-session',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { tier } = req.body as { tier?: string };
    if (!tier || !['silver', 'gold', 'platinum'].includes(tier)) {
      throw createError('Invalid subscription tier.', 400);
    }

    const pkg = await Package.findOne({ tier }).lean();
    if (!pkg) throw createError('Package not found.', 404);
    if (!pkg.stripePriceId) {
      throw createError(
        'This package has not been synced to Stripe yet. Please ask an admin to sync packages.',
        422,
      );
    }

    const user = await User.findById(req.userId).select(
      'email firstName lastName stripeCustomerId stripeSubscriptionId',
    );
    if (!user) throw createError('User not found.', 404);

    // Get or create Stripe Customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: `${user.firstName} ${user.lastName}`.trim(),
        metadata: { userId: user._id.toString() },
      });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    // If already has an active subscription, send to portal instead
    if (user.stripeSubscriptionId) {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${FRONTEND_URL}/subscribe`,
      });
      res.json({ url: portalSession.url });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: pkg.stripePriceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}/subscribe?payment=success&tier=${tier}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/subscribe?payment=canceled`,
      subscription_data: {
        metadata: { userId: user._id.toString(), tier },
      },
      metadata: { userId: user._id.toString(), tier },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  }),
);

/**
 * POST /api/stripe/customer-portal
 * Creates a Stripe Customer Portal session for managing/canceling subscriptions.
 */
router.post(
  '/customer-portal',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await User.findById(req.userId).select('stripeCustomerId');
    if (!user) throw createError('User not found.', 404);
    if (!user.stripeCustomerId) {
      throw createError('No billing account found. Please subscribe to a plan first.', 400);
    }

    const returnUrl = (req.body?.returnUrl as string) ?? `${FRONTEND_URL}/profile`;

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  }),
);

/**
 * POST /api/stripe/verify-session
 * Called right after Stripe checkout redirects back with ?session_id=xxx.
 * Retrieves the exact completed checkout session from Stripe, confirms payment,
 * and immediately writes the subscription into the user record.
 */
router.post(
  '/verify-session',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId, tier: tierHint } = req.body as { sessionId?: string; tier?: string };

    if (!sessionId) throw createError('sessionId is required.', 400);

    // Retrieve the checkout session directly — no timing ambiguity
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'subscription.items.data.price'],
    });

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      res.json({ synced: false, reason: 'payment_not_complete' });
      return;
    }

    const sub = session.subscription as Stripe.Subscription | null;
    if (!sub) {
      res.json({ synced: false, reason: 'no_subscription' });
      return;
    }

    const priceId = sub.items?.data[0]?.price?.id;

    // Resolve tier: from subscription metadata → URL hint → DB lookup
    const tier =
      (sub.metadata?.tier as string | undefined) ??
      tierHint ??
      (priceId ? (await Package.findOne({ stripePriceId: priceId }).lean())?.tier : null) ??
      null;

    if (!tier) {
      res.json({ synced: false, reason: 'tier_unknown' });
      return;
    }

    const periodEnd = (sub as unknown as { current_period_end: number }).current_period_end;

    await User.findByIdAndUpdate(req.userId, {
      stripeCustomerId: session.customer as string,
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      subscriptionPlan: tier,
      subscriptionStatus: 'active',
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : undefined,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      subscribedAt: new Date(),
    });

    console.log(`[Stripe] User ${req.userId} subscribed to ${tier} via session ${sessionId}`);
    res.json({ synced: true, tier });
  }),
);

export default router;
