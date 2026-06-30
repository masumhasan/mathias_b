import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User, IUser } from '../models/User';
import { getMailTransporter, MAIL_FROM } from '../config/mailer';
import { createError } from '../middleware/errorHandler';
import logger from '../utils/logger';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const JWT_EXPIRES_IN = '7d';

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  country?: string;
  role?: 'user' | 'client';
}

export interface PublicUser {
  id: string;
  email: string;
  role: 'user' | 'admin' | 'client';
  firstName: string;
  lastName: string;
  phone?: string;
  country?: string;
  city?: string;
  bio?: string;
  emailVerified: boolean;
  subscriptionPlan: string;
  subscribedAt?: Date;
  subscriptionStatus: string;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd: boolean;
}

export interface UpdateProfileInput {
  firstName?: string;
  lastName?: string;
  phone?: string;
  country?: string;
  city?: string;
  bio?: string;
}

function toPublicUser(user: IUser): PublicUser {
  return {
    id: user.id as string,
    email: user.email,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    country: user.country,
    city: user.city,
    bio: user.bio,
    emailVerified: user.emailVerified,
    subscriptionPlan: user.subscriptionPlan ?? 'none',
    subscribedAt: user.subscribedAt,
    subscriptionStatus: user.subscriptionStatus ?? 'none',
    currentPeriodEnd: user.currentPeriodEnd,
    cancelAtPeriodEnd: user.cancelAtPeriodEnd ?? false,
  };
}

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not defined in environment');
  return secret;
}

export function signToken(user: IUser): string {
  return jwt.sign({ userId: user.id, email: user.email }, getJwtSecret(), {
    expiresIn: JWT_EXPIRES_IN,
  });
}

export interface JwtPayload {
  userId: string;
  email: string;
}

export function verifyAuthToken(token: string): JwtPayload {
  return jwt.verify(token, getJwtSecret()) as JwtPayload;
}

async function sendOtpEmail(to: string, otp: string): Promise<void> {
  const transporter = getMailTransporter();
  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: 'Your EUVisaAdvice verification code',
    text: `Your verification code is ${otp}. It expires in 10 minutes.`,
    html: `<p>Your verification code is:</p><h2 style="letter-spacing:4px">${otp}</h2><p>This code expires in 10 minutes.</p>`,
  });
}

async function sendPasswordResetEmail(to: string, otp: string): Promise<void> {
  const transporter = getMailTransporter();
  await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject: 'Your EUVisaAdvice password reset code',
    text: `Your password reset code is ${otp}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    html: `<p>Your password reset code is:</p><h2 style="letter-spacing:4px">${otp}</h2><p>This code expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
  });
}

/**
 * Registers a new user, or — if an unverified account already exists for this
 * email — regenerates and resends the OTP for that same account instead of
 * erroring, so an abandoned signup can simply be retried.
 */
export async function registerUser(input: RegisterInput): Promise<{ email: string; otp: string }> {
  const email = input.email.toLowerCase().trim();
  const existing = await User.findOne({ email });

  if (existing && existing.emailVerified) {
    throw createError('An account with this email already exists. Please log in instead.', 409);
  }

  const passwordHash = await bcrypt.hash(input.password, 10);
  const otp = generateOtp();
  const otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);

  if (existing) {
    existing.passwordHash = passwordHash;
    existing.firstName = input.firstName;
    existing.lastName = input.lastName;
    existing.phone = input.phone;
    existing.country = input.country;
    existing.otpCode = otp;
    existing.otpExpiresAt = otpExpiresAt;
    existing.otpAttempts = 0;
    await existing.save();
  } else {
    await User.create({
      email,
      passwordHash,
      role: input.role ?? 'user',
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      country: input.country,
      emailVerified: false,
      otpCode: otp,
      otpExpiresAt,
      otpAttempts: 0,
    });
  }

  await sendOtpEmail(email, otp);
  logger.info('Registration OTP sent', { email });

  return { email, otp };
}

export async function resendOtp(emailInput: string): Promise<{ otp: string }> {
  const email = emailInput.toLowerCase().trim();
  const user = await User.findOne({ email });

  if (!user) throw createError('No pending registration found for this email.', 404);
  if (user.emailVerified) throw createError('This email is already verified. Please log in.', 409);

  const otp = generateOtp();
  user.otpCode = otp;
  user.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
  user.otpAttempts = 0;
  await user.save();

  await sendOtpEmail(email, otp);
  logger.info('OTP resent', { email });

  return { otp };
}

export async function verifyOtp(
  emailInput: string,
  otp: string,
): Promise<{ token: string; user: PublicUser }> {
  const email = emailInput.toLowerCase().trim();
  const user = await User.findOne({ email });

  if (!user) throw createError('No pending registration found for this email.', 404);
  if (user.emailVerified) throw createError('This email is already verified. Please log in.', 409);

  if (user.otpAttempts >= 5) {
    throw createError('Too many incorrect attempts. Please request a new code.', 429);
  }

  if (!user.otpCode || !user.otpExpiresAt || user.otpExpiresAt.getTime() < Date.now()) {
    throw createError('This code has expired. Please request a new one.', 400);
  }

  if (user.otpCode !== otp) {
    user.otpAttempts += 1;
    await user.save();
    throw createError('Incorrect verification code.', 400);
  }

  user.emailVerified = true;
  user.otpCode = undefined;
  user.otpExpiresAt = undefined;
  user.otpAttempts = 0;
  await user.save();

  const token = signToken(user);
  logger.info('Email verified', { email });

  return { token, user: toPublicUser(user) };
}

export async function loginUser(
  emailInput: string,
  password: string,
): Promise<{ token: string; user: PublicUser }> {
  const email = emailInput.toLowerCase().trim();
  const user = await User.findOne({ email });

  if (!user) throw createError('Invalid email or password.', 401);

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) throw createError('Invalid email or password.', 401);

  if (!user.emailVerified) {
    throw createError('Please verify your email before logging in.', 403, 'EMAIL_NOT_VERIFIED');
  }

  if (user.banned) {
    throw createError('This account has been suspended. Please contact support.', 403, 'ACCOUNT_BANNED');
  }

  const token = signToken(user);
  return { token, user: toPublicUser(user) };
}

export async function getUserById(userId: string): Promise<PublicUser | null> {
  const user = await User.findById(userId);
  return user ? toPublicUser(user) : null;
}

export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<PublicUser> {
  const user = await User.findById(userId);
  if (!user) throw createError('User not found.', 404);

  if (input.firstName !== undefined) user.firstName = input.firstName;
  if (input.lastName !== undefined) user.lastName = input.lastName;
  if (input.phone !== undefined) user.phone = input.phone || undefined;
  if (input.country !== undefined) user.country = input.country || undefined;
  if (input.city !== undefined) user.city = input.city || undefined;
  if (input.bio !== undefined) user.bio = input.bio || undefined;

  await user.save();
  return toPublicUser(user);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await User.findById(userId);
  if (!user) throw createError('User not found.', 404);

  const matches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!matches) throw createError('Current password is incorrect.', 401);

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await user.save();
  logger.info('Password changed', { email: user.email });
}

export async function requestPasswordReset(emailInput: string): Promise<void> {
  const email = emailInput.toLowerCase().trim();
  const user = await User.findOne({ email });

  if (!user) throw createError('No account found for this email.', 404);

  const otp = generateOtp();
  user.resetOtpCode = otp;
  user.resetOtpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
  user.resetOtpAttempts = 0;
  await user.save();

  await sendPasswordResetEmail(email, otp);
  logger.info('Password reset OTP sent', { email });
}

export async function resetPassword(
  emailInput: string,
  otp: string,
  newPassword: string,
): Promise<{ token: string; user: PublicUser }> {
  const email = emailInput.toLowerCase().trim();
  const user = await User.findOne({ email });

  if (!user) throw createError('No account found for this email.', 404);

  if (user.resetOtpAttempts >= 5) {
    throw createError('Too many incorrect attempts. Please request a new code.', 429);
  }

  if (!user.resetOtpCode || !user.resetOtpExpiresAt || user.resetOtpExpiresAt.getTime() < Date.now()) {
    throw createError('This code has expired. Please request a new one.', 400);
  }

  if (user.resetOtpCode !== otp) {
    user.resetOtpAttempts += 1;
    await user.save();
    throw createError('Incorrect verification code.', 400);
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  user.resetOtpCode = undefined;
  user.resetOtpExpiresAt = undefined;
  user.resetOtpAttempts = 0;
  await user.save();

  const token = signToken(user);
  logger.info('Password reset completed', { email });

  return { token, user: toPublicUser(user) };
}
