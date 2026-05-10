import request from 'supertest';

const mockQueuePath = jest.fn().mockReturnValue('projects/test/locations/europe-west1/queues/newsletter-ingest');
const mockCreateTask = jest.fn().mockResolvedValue([{ name: 'projects/test/tasks/task-123' }]);

jest.mock('@google-cloud/tasks', () => ({
  CloudTasksClient: jest.fn().mockImplementation(() => ({
    queuePath: mockQueuePath,
    createTask: mockCreateTask,
  })),
}));

import { ingest } from '../../src/functions/ingest';

const SECRET = 'test_secret_123';
const validPayload = {
  envelope: { from: 'newsletter@example.com' },
  headers: { Date: 'Mon, 09 May 2026 12:00:00 +0000' },
  html: '<p>Newsletter content</p>',
};

describe('ingest — POST /webhook/cloudmailin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTask.mockResolvedValue([{ name: 'projects/test/tasks/task-123' }]);
  });

  it('returns 401 for a wrong secret', async () => {
    await request(ingest as any)
      .post('/webhook/cloudmailin?secret=wrong')
      .send(validPayload)
      .expect(401);
  });

  it('returns 401 when the secret is missing', async () => {
    await request(ingest as any)
      .post('/webhook/cloudmailin')
      .send(validPayload)
      .expect(401);
  });

  it('enqueues a Cloud Task and returns 202', async () => {
    const res = await request(ingest as any)
      .post(`/webhook/cloudmailin?secret=${SECRET}`)
      .send(validPayload)
      .expect(202);
    expect(res.body).toEqual({ status: 'accepted' });
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });

  it('encodes the full request body in the task payload', async () => {
    await request(ingest as any)
      .post(`/webhook/cloudmailin?secret=${SECRET}`)
      .send(validPayload)
      .expect(202);
    const [call] = mockCreateTask.mock.calls;
    const taskBody = JSON.parse(
      Buffer.from(call[0].task.httpRequest.body, 'base64').toString(),
    );
    expect(taskBody.envelope.from).toBe('newsletter@example.com');
    expect(taskBody.html).toBe(validPayload.html);
  });

  it('targets the configured ingest-worker URL', async () => {
    await request(ingest as any)
      .post(`/webhook/cloudmailin?secret=${SECRET}`)
      .send(validPayload)
      .expect(202);
    const [call] = mockCreateTask.mock.calls;
    expect(call[0].task.httpRequest.url).toBe('http://localhost:8080/worker');
  });

  it('returns 500 when Cloud Tasks throws', async () => {
    mockCreateTask.mockRejectedValueOnce(new Error('Cloud Tasks unavailable'));
    await request(ingest as any)
      .post(`/webhook/cloudmailin?secret=${SECRET}`)
      .send(validPayload)
      .expect(500);
  });
});
