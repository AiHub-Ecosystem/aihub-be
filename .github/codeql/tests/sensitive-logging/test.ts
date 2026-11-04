const express = require('express');
const app = express();
const logger = { info: (_value: unknown) => undefined, warn: (_value: unknown) => undefined };

app.post('/unsafe-log', (req: any, res: any) => {
  logger.info(req.body);
  logger.warn(req.get('authorization'));
  res.sendStatus(204);
});

app.post('/safe-log', (_req: any, res: any) => {
  logger.info('request accepted');
  res.sendStatus(204);
});

app.get('/remote-log', async (_req: any, res: any) => {
  const response = await fetch(String(process.argv[2]));
  logger.error(await response.text());
  res.sendStatus(204);
});
