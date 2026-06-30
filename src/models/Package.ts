import mongoose, { Schema, Document } from 'mongoose';

export type SubscriptionTier = 'silver' | 'gold' | 'platinum';

export interface IPackage extends Document {
  name: string;
  price: number;
  description: string;
  tier: SubscriptionTier;
  stripeProductId?: string;
  stripePriceId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PackageSchema = new Schema<IPackage>(
  {
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    description: { type: String, required: true, trim: true },
    tier: { type: String, enum: ['silver', 'gold', 'platinum'], required: true },
    stripeProductId: { type: String },
    stripePriceId: { type: String },
  },
  { timestamps: true },
);

export const Package = mongoose.model<IPackage>('Package', PackageSchema);
