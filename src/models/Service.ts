import mongoose, { Schema, Document } from 'mongoose';

export interface IService extends Document {
  name: string;
  slug: string;
  content: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const ServiceSchema = new Schema<IService>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    content: { type: String, default: '' },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Service = mongoose.model<IService>('Service', ServiceSchema);
