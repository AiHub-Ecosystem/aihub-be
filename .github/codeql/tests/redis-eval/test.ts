const express = require('express');
const app = express();
const redis = { eval: (_script: string, _keyCount: number) => undefined };

app.post('/unsafe-eval', (req: any, res: any) => {
  redis.eval(req.body.script, 0);
  res.sendStatus(204);
});

app.post('/safe-eval', (_req: any, res: any) => {
  redis.eval("return redis.call('GET', KEYS[1])", 1);
  res.sendStatus(204);
});
