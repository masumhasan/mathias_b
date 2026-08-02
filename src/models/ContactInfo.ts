import mongoose, { Schema, Document } from 'mongoose';

export interface IContactInfo extends Document {
  address: string;
  email: string;
  updatedAt: Date;
}

const ContactInfoSchema = new Schema<IContactInfo>(
  {
    address: { type: String, required: true, default: '30 N Gould St, Ste N\nSheridan, WY 82801 USA' },
    email: { type: String, required: true, default: 'supporteuvisa@gmail.com' },
  },
  { timestamps: true },
);

export const ContactInfo = mongoose.model<IContactInfo>('ContactInfo', ContactInfoSchema);
