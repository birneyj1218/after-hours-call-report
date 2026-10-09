'use strict';
// Public entry point. Everything here is dependency-free CommonJS.

module.exports = {
  ...require('./config'),
  ...require('./normalize'),
  ...require('./classify'),
  ...require('./schema'),
  ...require('./llm'),
  ...require('./report'),
  ...require('./digest'),
  ...require('./pipeline'),
  time: require('./time'),
  adapters: require('./adapters'),
};
