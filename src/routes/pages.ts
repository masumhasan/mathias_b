import { Router, Request, Response } from 'express';
import { PolicyPage, PolicyType } from '../models/PolicyPage';
import { asyncHandler, createError } from '../middleware/errorHandler';

const router = Router();

const VALID_TYPES: PolicyType[] = ['privacy-policy', 'terms-of-service', 'about-us', 'our-team', 'how-it-works'];

router.get(
  '/:type',
  asyncHandler(async (req: Request, res: Response) => {
    const type = req.params.type as PolicyType;
    if (!VALID_TYPES.includes(type)) throw createError('Page not found.', 404);

    const page = await PolicyPage.findOne({ type }).lean();
    res.json({ content: page?.content ?? '', updatedAt: page?.updatedAt ?? null });
  }),
);

export default router;
