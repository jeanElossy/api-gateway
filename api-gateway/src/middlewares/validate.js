// src/middlewares/validate.js

module.exports = function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[VALIDATE] Requête bloquée :', error.details.map(d => d.message).join('; '));
      }
      return res.status(400).json({
        success: false,
        error: 'Données invalides',
        details: error.details.map(d => d.message)
      });
    }
    next();
  };
};
