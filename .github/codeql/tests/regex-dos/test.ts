const express = require('express');
const app = express();
const vulnerable = /^(a+)+$/;
const safe = /^[a-z0-9]+$/;

app.post('/unsafe-regex', (req: any, res: any) => {
  vulnerable.test(req.body.value);
  res.sendStatus(204);
});

app.post('/safe-regex', (req: any, res: any) => {
  safe.test(req.body.value);
  res.sendStatus(204);
});
