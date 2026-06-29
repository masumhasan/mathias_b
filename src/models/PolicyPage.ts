import mongoose, { Schema, Document } from 'mongoose';

export type PolicyType = 'privacy-policy' | 'terms-of-service' | 'about-us' | 'our-team' | 'how-it-works';

export interface IPolicyPage extends Document {
  type: PolicyType;
  content: string;
  updatedAt: Date;
}

const PolicyPageSchema = new Schema<IPolicyPage>(
  {
    type: { type: String, enum: ['privacy-policy', 'terms-of-service', 'about-us', 'our-team', 'how-it-works'], required: true, unique: true },
    content: { type: String, default: '' },
  },
  { timestamps: true },
);

export const PolicyPage = mongoose.model<IPolicyPage>('PolicyPage', PolicyPageSchema);
