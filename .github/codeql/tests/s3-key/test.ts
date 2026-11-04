const express = require('express');
const app = express();
class PutObjectCommand {
  constructor(readonly input: unknown) {}
}
const s3 = { send: (_command: unknown) => undefined };

app.post('/unsafe-key', (req: any, res: any) => {
  s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: req.body.key, Body: 'image' }));
  res.sendStatus(204);
});

app.post('/safe-key', (_req: any, res: any) => {
  s3.send(new PutObjectCommand({ Bucket: 'uploads', Key: 'published/chart.png', Body: 'image' }));
  res.sendStatus(204);
});
