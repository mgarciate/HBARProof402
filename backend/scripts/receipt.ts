import { request } from './http.js';
const taskId = process.argv[2];
if (!taskId) throw new Error('Usage: npm run receipt -- <taskId>');
const result = await request(`/v1/tasks/${taskId}/receipt/verify`, process.env.AGENT_API_TOKEN!);
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'verified_mock_flow') process.exitCode = 1;
