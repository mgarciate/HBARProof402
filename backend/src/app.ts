import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { eq, sql } from 'drizzle-orm';
import { principals } from './schema.js';
import { accountId, AppError, evidenceInput, sha256, taskInput, uploadsInput } from './domain.js';
import { type Principal, type Reply, Marketplace } from './service.js';
import { verifyReceipt } from './receipt.js';
import { Payments } from './payments.js';

declare module 'fastify' { interface FastifyRequest { principal: Principal; } }
const uuidParams = z.object({ taskId: z.string().uuid() });
const empty = z.object({}).strict();
const jsonSchema = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { target: 'openApi3' });
function roles(request: FastifyRequest, allowed: Principal['role'][]): void {
  if (!allowed.includes(request.principal.role)) throw new AppError(403, 'FORBIDDEN', 'Role does not permit this operation');
}
export async function buildApp(service: Marketplace, logging = true, payments = new Payments(service)) {
  const app = Fastify({ bodyLimit: 32 * 1024, ajv: { customOptions: { removeAdditional: false } }, logger: logging ? { redact: ['req.headers.authorization', 'req.headers["payment-signature"]', 'req.headers.cookie', 'res.headers["set-cookie"]'], serializers: { req: req => ({ method: req.method, url: req.url?.split('?')[0] }) } } : false });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(swagger, { openapi: { info: { title: 'FieldProof402 Marketplace', version: '0.2.0', description: 'Hedera testnet: x402 v2 purchases and HBAR rewards; analysis remains mock.' }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ bearerAuth: [] }] } });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.decorateRequest('principal');
  app.addHook('onRequest', async req => {
    if (req.url.startsWith('/health/') || req.url === '/docs' || req.url.startsWith('/docs/')) return;
    const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Bearer token required');
    const principal = (await service.db.orm.select({ id: principals.id, role: principals.role }).from(principals).where(eq(principals.tokenHash, sha256(token))).limit(1))[0];
    if (!principal) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid bearer token');
    req.principal = principal;
  });
  app.setErrorHandler((error: Error & { validation?: unknown; statusCode?: number; code?: string }, req, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, requestId: req.id } });
    if (error instanceof z.ZodError || error.validation) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request does not match the API schema', requestId: req.id } });
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503;
    req.log.error({ code: error.code ?? 'INTERNAL_ERROR', requestId: req.id }, 'Request failed');
    return reply.code(status).send({ error: { code: status === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE', message: status === 429 ? 'Too many requests' : 'Service temporarily unavailable', requestId: req.id } });
  });
  app.get('/health/live', { schema: { security: [] } }, async () => ({ status: 'ok', verificationMode: 'mock' }));
  app.get('/health/ready', { schema: { security: [] } }, async () => {
    await service.db.orm.execute(sql`SELECT 1`); await service.storage.ready(); return { status: 'ready' };
  });
  const mutate = (method: 'POST' | 'PUT', url: string, allowed: Principal['role'][], bodySchema: z.ZodTypeAny, paramsSchema: z.ZodTypeAny | undefined, action: (req: FastifyRequest, tx: import('./db.js').Tx, body: any, params: any) => Promise<Reply>) => {
    app.route({ method, url, schema: { body: jsonSchema(bodySchema), ...(paramsSchema ? { params: jsonSchema(paramsSchema) } : {}), headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 200 } } } }, handler: async (req, reply) => {
      roles(req, allowed);
      const key = z.string().min(8).max(200).parse(req.headers['idempotency-key']);
      const body = bodySchema.parse(req.body ?? {}); const params = paramsSchema?.parse(req.params) ?? {};
      const response = await service.idempotent(req.principal, `${method}:${url}:${JSON.stringify(params)}`, key, body, tx => action(req, tx, body, params));
      return reply.code(response.status).send(response.body);
    } });
  };
  mutate('POST', '/v1/tasks', ['agent'], taskInput, undefined, (req, tx, body) => service.create(tx, req.principal, body));
  mutate('PUT', '/v1/workers/:workerId/payout-account', ['worker'], z.object({ hederaAccountId: accountId }).strict(), z.object({ workerId: z.string().uuid() }), (req, tx, body, params) => service.payout(tx, req.principal, params.workerId, body.hederaAccountId));
  mutate('POST', '/v1/tasks/:taskId/claim', ['worker'], empty, uuidParams, (req, tx, _body, params) => service.claim(tx, req.principal, params.taskId));
  mutate('POST', '/v1/tasks/:taskId/cancel', ['agent'], empty, uuidParams, (req, tx, _body, params) => service.cancel(tx, req.principal, params.taskId));
  mutate('POST', '/v1/tasks/:taskId/evidence/uploads', ['worker'], uploadsInput, uuidParams, (req, tx, body, params) => service.uploads(tx, req.principal, params.taskId, body));
  mutate('POST', '/v1/tasks/:taskId/evidence', ['worker'], evidenceInput, uuidParams, (req, tx, body, params) => service.submit(tx, req.principal, params.taskId, body));
  app.get('/v1/me', async req => req.principal);
  const purchaseInput = z.object({ taskId: z.string().uuid() }).strict();
  app.post('/v1/x402/verify', { schema: {
    body: jsonSchema(purchaseInput),
    headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 200 }, 'payment-signature': { type: 'string', maxLength: 24000 } } },
    description: '402 quote, 202 durable authorization/settlement, 200 existing result. PAYMENT-SIGNATURE must carry x402 v2 signed HBAR bytes bound to the purchase memo.',
  } }, async (req, reply) => {
    const key = z.string().min(8).max(200).parse(req.headers['idempotency-key']);
    const signature = z.string().optional().parse(req.headers['payment-signature']);
    const result = await payments.purchase(req.principal, purchaseInput.parse(req.body).taskId, key, signature);
    return reply.code(result.status).headers({ 'Cache-Control': 'no-store', ...result.headers }).send(result.body);
  });
  app.get('/v1/x402/payments/:paymentId', { schema: { params: jsonSchema(z.object({ paymentId: z.string().uuid() })) } }, async (req, reply) => {
    const id = z.object({ paymentId: z.string().uuid() }).parse(req.params).paymentId;
    const result = await payments.status(req.principal, id);
    return reply.code(result.status).headers({ 'Cache-Control': 'no-store', ...result.headers }).send(result.body);
  });
  const listQuery = z.object({ status: z.enum(['DRAFT','OPEN','CLAIMED','EVIDENCE_SUBMITTED','VERIFYING','APPROVED','REJECTED','MANUAL_REVIEW','PAID','CANCELLED','EXPIRED']).default('OPEN'), cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
  app.get('/v1/tasks', { schema: { querystring: jsonSchema(listQuery) } }, async req => {
    const query = listQuery.parse(req.query);
    const tasks = await service.db.query("SELECT t.* FROM tasks t LEFT JOIN claims c ON c.task_id=t.id WHERE t.status=$1 AND ($2::uuid IS NULL OR t.id>$2) AND ((t.status='OPEN' AND t.expires_at>now()) OR t.agent_id=$3 OR c.worker_id=$3 OR $4='operator') ORDER BY t.id LIMIT $5", [query.status, query.cursor ?? null, req.principal.id, req.principal.role, query.limit + 1]);
    const page = tasks.slice(0, query.limit);
    return { tasks: page.map(t => service.summary(t)), nextCursor: tasks.length > query.limit ? page.at(-1)!.id : null };
  });
  app.get('/v1/tasks/:taskId', { schema: { params: jsonSchema(uuidParams) } }, req => service.detail(req.principal, uuidParams.parse(req.params).taskId));
  app.get('/v1/tasks/:taskId/result', { schema: { params: jsonSchema(uuidParams) } }, async (req, reply) => {
    const { taskId } = uuidParams.parse(req.params); const task = await service.authorizeRead(req.principal, taskId);
    const verification = (await service.db.query('SELECT status,result,last_error FROM verifications WHERE task_id=$1', [taskId]))[0];
    const payment = (await service.db.query('SELECT status FROM verification_payments WHERE task_id=$1', [taskId]))[0];
    if (!verification?.result) return reply.code(202).send({ taskId, status: verification?.status ?? 'NOT_REQUESTED', operationalError: verification?.last_error ?? null, verificationMode: 'mock', x402PaymentStatus: payment?.status.toLowerCase() ?? (task.verification_payment_mode === 'x402' ? 'awaiting_payment' : 'not_performed') });
    return verification.result;
  });
  const eventsQuery = z.object({ cursor: z.string().regex(/^\d+$/).default('0'), limit: z.coerce.number().int().min(1).max(100).default(50) });
  app.get('/v1/tasks/:taskId/events', { schema: { params: jsonSchema(uuidParams), querystring: jsonSchema(eventsQuery) } }, async req => {
    const { taskId } = uuidParams.parse(req.params); await service.authorizeRead(req.principal, taskId);
    const query = eventsQuery.parse(req.query);
    const events = await service.db.query('SELECT id,type,data,created_at AS "createdAt" FROM task_events WHERE task_id=$1 AND id>$2 ORDER BY id LIMIT $3', [taskId, query.cursor, query.limit]);
    return { events, nextCursor: events.at(-1)?.id ?? query.cursor };
  });
  app.get('/v1/tasks/:taskId/receipt/verify', { schema: { params: jsonSchema(uuidParams) } }, req => verifyReceipt(service, req.principal, uuidParams.parse(req.params).taskId));
  app.get('/v1/operator/jobs', async req => { roles(req, ['operator']); return { jobs: await service.db.query("SELECT id,kind,task_id,status,attempts,last_error,available_at FROM jobs WHERE status <> 'DONE' ORDER BY id LIMIT 100") }; });
  mutate('POST', '/v1/operator/jobs/:jobId/retry', ['operator'], empty, z.object({ jobId: z.string().regex(/^\d+$/) }), async (_req, tx, _body, params) => {
    const job = (await tx.query("UPDATE jobs SET status='PENDING',attempts=0,available_at=now(),last_error=NULL WHERE id=$1 AND status='BLOCKED' RETURNING id,status", [params.jobId])).rows[0];
    if (!job) throw new AppError(409, 'JOB_NOT_BLOCKED', 'Only blocked jobs can be retried');
    return { status: 202, body: job };
  });
  await app.ready(); return app;
}
