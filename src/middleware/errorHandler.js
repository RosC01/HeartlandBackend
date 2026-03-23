function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message || err);

  // Prisma known error codes
  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'A record with that value already exists.' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Record not found.' });
  }
  if (err.code === 'P2003') {
    return res.status(400).json({ error: 'Related record not found. Check foreign key values.' });
  }

  const status = err.statusCode || err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error.' });
}

module.exports = { errorHandler };
