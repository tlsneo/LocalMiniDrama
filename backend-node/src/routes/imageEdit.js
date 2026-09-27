const express = require('express');
const multer = require('multer');
const response = require('../response');
const { MAX_BYTES } = require('../services/imageEditFiles');

module.exports = function imageEditRoutes(service, log) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 12, fieldSize: 64000 } });
  const run = (action) => async (req, res, next) => {
    try { response.success(res, await action(req)); } catch (e) { next(e); }
  };
  router.post('/', run((req) => service.create(req.body || {})));
  router.get('/:id', run((req) => service.get(req.params.id)));
  router.get('/:id/files/:role', (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.sendFile(service.file(req.params.id, req.params.role), (err) => { if (err) next(err); });
    } catch (e) { next(e); }
  });
  router.post('/:id/generate', upload.single('mask'), run((req) => service.generate(req.params.id, req.body || {}, req.file?.buffer)));
  router.post('/:id/continue', run((req) => service.continueEdit(req.params.id, req.body || {})));
  router.post('/:id/adopt', run((req) => service.adopt(req.params.id, req.body || {})));
  router.post('/:id/finish', run((req) => service.finish(req.params.id)));
  router.delete('/:id', run((req) => service.discard(req.params.id)));
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    const status = tooLarge ? 413 : (err.status || (err instanceof multer.MulterError ? 400 : 500));
    if (status >= 500) log.warn('Image edit request failed', { operation: req.method, status });
    response.error(res, status, err.code || 'IMAGE_EDIT_ERROR', tooLarge ? '图片超过本地16MB限制' : (err.status || err instanceof multer.MulterError ? err.message : '图片编辑操作失败，结果会保留供重试'));
  });
  return router;
};
