import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not set in environment variables.');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/** Map a Stripe subscription status to our internal status */
export function mapStripeStatus(
  status: Stripe.Subscription.Status,
): 'active' | 'canceled' | 'past_due' | 'incomplete' | 'trialing' | 'none' {
  switch (status) {
    case 'active':      return 'active';
    case 'trialing':    return 'trialing';
    case 'past_due':    return 'past_due';
    case 'canceled':    return 'canceled';
    case 'incomplete':  return 'incomplete';
    case 'incomplete_expired': return 'canceled';
    case 'paused':      return 'past_due';
    case 'unpaid':      return 'past_due';
    default:            return 'none';
  }
}
