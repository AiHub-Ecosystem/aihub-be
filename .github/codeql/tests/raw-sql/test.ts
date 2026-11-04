const express = require('express');
const app = express();
const prisma = { $queryRawUnsafe: (_query: string) => undefined };
const requestDb = { $executeRawUnsafe: (_query: string) => undefined };
function runUnsafeQuery(query: string) {
  prisma.$queryRawUnsafe(query);
}

app.post('/unsafe-query', (req: any, res: any) => {
  runUnsafeQuery(`SELECT * FROM users WHERE id = ${req.body.id}`);
  res.sendStatus(204);
});

app.post('/unsafe-wrapper', (req: any, res: any) => {
  const query = `DELETE FROM sessions WHERE id = ${req.params.sessionId}`;
  requestDb.$executeRawUnsafe(query);
  res.sendStatus(204);
});

app.post('/safe-bound-value', (req: any, res: any) => {
  prisma.$queryRawUnsafe('SELECT * FROM users WHERE id = $1', req.body.id);
  res.sendStatus(204);
});
