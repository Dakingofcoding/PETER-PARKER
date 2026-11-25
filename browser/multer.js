// Multer stand-in: reads the uploaded file from the in-page FormData.
export default function multer(opts = {}) {
  const limit = opts.limits?.fileSize || Infinity;
  return {
    single(field) {
      return async (req, res, next) => {
        const fd = req._form;
        if (!fd) return next();
        const body = {};
        for (const [k, v] of fd.entries()) if (typeof v === 'string') body[k] = v;
        req.body = body;
        const f = fd.get(field);
        if (f && typeof f !== 'string') {
          if (f.size > limit) {
            const e = new multer.MulterError('LIMIT_FILE_SIZE');
            return next(e);
          }
          req.file = { originalname: f.name, mimetype: f.type, size: f.size, buffer: globalThis.Buffer.from(await f.arrayBuffer()) };
        }
        next();
      };
    },
  };
}
multer.memoryStorage = () => ({});
multer.MulterError = class MulterError extends Error {
  constructor(code) {
    super(code === 'LIMIT_FILE_SIZE' ? 'File too large' : code);
    this.code = code;
  }
};
