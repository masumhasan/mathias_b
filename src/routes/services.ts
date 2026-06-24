import { Router, Request, Response } from 'express';
import { Service } from '../models/Service';
import { asyncHandler, createError } from '../middleware/errorHandler';

const router = Router();

// GET /api/services — public list (for footer nav)
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const services = await Service.find().sort({ order: 1, createdAt: 1 }).lean();
    res.json({ services: services.map((s) => ({ id: s._id, name: s.name, slug: s.slug })) });
  }),
);

// GET /api/services/:slug — public single service page
router.get(
  '/:slug',
  asyncHandler(async (req: Request, res: Response) => {
    const service = await Service.findOne({ slug: req.params.slug }).lean();
    if (!service) throw createError('Service not found.', 404);
    res.json({ name: service.name, slug: service.slug, content: service.content, updatedAt: service.updatedAt });
  }),
);

export default router;
