import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler } from './middleware/errorHandler';
import chatRoutes from './routes/chat';
import legalChatRoutes from './routes/legalChat';
import healthRoutes from './routes/health';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import clientChatRoutes from './routes/clientChat';
import pagesRoutes from './routes/pages';
import servicesRoutes from './routes/services';
import stripeRoutes from './routes/stripe';
import { stripeWebhookHandler } from './routes/stripeWebhook';

const app = express();

// Trust the first proxy (e.g., AWS ALB, Nginx) so rate limits use the real client IP
app.set('trust proxy', 1);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001'];

app.use(
  helmet({
    contentSecurityPolicy: true,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} is not allowed`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// ── Stripe webhook MUST receive raw body — register before express.json() ──
app.post('/api/stripe/webhook', express.raw({ type: '*/*' }), stripeWebhookHandler);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(requestLogger);

app.use('/api/health', healthRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/legal-chat', legalChatRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/client-chat', clientChatRoutes);
app.use('/api/pages', pagesRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/stripe', stripeRoutes);

app.get('/', (_req, res) => {
  const dbState = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const dbStatus = dbState[require('mongoose').connection.readyState] ?? 'unknown';
  const healthy = dbStatus === 'connected';

  res.status(healthy ? 200 : 503).json({
    name: 'EUVisaAdvice API',
    status: healthy ? '✅ Backend is running' : '⚠️ Backend degraded',
    health: healthy ? 'healthy' : 'degraded',
    database: dbStatus,
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/api/health',
    
      chat: '/api/legal-chat',
      clientChat: '/api/client-chat',

    },
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use(errorHandler);

export default app;
