import { Request, Response } from 'express';
import Stripe from 'stripe';
import { stripe, mapStripeStatus } from '../services/stripeService';
import { User } from '../models/User';
import { Package } from '../models/Package';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

/** Resolve our subscription tier from a Stripe price ID */
async function tierFromPriceId(priceId: string): Promise<string | null> {
  const pkg = await Package.findOne({ stripePriceId: priceId }).lean();
  return pkg?.tier ?? null;
}

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    res.status(400).json({ error: 'Missing stripe-signature header.' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', (err as Error).message);
    res.status(400).json({ error: `Webhook Error: ${(err as Error).message}` });
    return;
  }

  try {
    switch (event.type) {
      // ── Checkout completed ───────────────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== 'subscription') break;

        const userId = session.metadata?.userId;
        const tier = session.metadata?.tier;
        if (!userId || !tier) break;

        const subscriptionId = session.subscription as string;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = subscription.items.data[0]?.price?.id;

        await User.findByIdAndUpdate(userId, {
          stripeSubscriptionId: subscriptionId,
          stripePriceId: priceId,
          subscriptionPlan: tier,
          subscriptionStatus: mapStripeStatus(subscription.status),
          currentPeriodEnd: new Date((subscription as unknown as { current_period_end: number }).current_period_end * 1000),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          subscribedAt: new Date(),
        });
        break;
      }

      // ── Subscription updated (upgrade / downgrade / cancel scheduled) ────────
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.userId;
        if (!userId) break;

        const priceId = sub.items.data[0]?.price?.id;
        const tier = priceId ? await tierFromPriceId(priceId) : null;

        const updatePayload: Record<string, unknown> = {
          stripeSubscriptionId: sub.id,
          stripePriceId: priceId,
          subscriptionStatus: mapStripeStatus(sub.status),
          currentPeriodEnd: new Date((sub as unknown as { current_period_end: number }).current_period_end * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        };
        if (tier) updatePayload.subscriptionPlan = tier;

        await User.findByIdAndUpdate(userId, updatePayload);
        break;
      }

      // ── Subscription canceled / deleted ──────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.userId;
        if (!userId) break;

        await User.findByIdAndUpdate(userId, {
          subscriptionPlan: 'none',
          subscriptionStatus: 'canceled',
          stripeSubscriptionId: null,
          stripePriceId: null,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
        });
        break;
      }

      // ── Invoice payment succeeded ────────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = (invoice as unknown as { subscription: string }).subscription;
        if (!subId) break;

        const sub = await stripe.subscriptions.retrieve(subId);
        const userId = sub.metadata?.userId;
        if (!userId) break;

        await User.findByIdAndUpdate(userId, {
          subscriptionStatus: 'active',
          currentPeriodEnd: new Date((sub as unknown as { current_period_end: number }).current_period_end * 1000),
        });
        break;
      }

      // ── Invoice payment failed ───────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = (invoice as unknown as { subscription: string }).subscription;
        if (!subId) break;

        const sub = await stripe.subscriptions.retrieve(subId);
        const userId = sub.metadata?.userId;
        if (!userId) break;

        await User.findByIdAndUpdate(userId, { subscriptionStatus: 'past_due' });
        break;
      }

      default:
        // Unhandled event type — acknowledged, no action needed
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed.' });
  }
}
