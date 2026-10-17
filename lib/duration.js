'use strict';

// Converts a "30s"/"5m"/"2h"/"1d"-style duration string to nanoseconds, the
// unit JetStream config fields (max_age, ack_wait, duplicate_window, ...)
// expect. Malformed or missing input returns 0, matching every existing
// call site.
function parseDuration(duration) {
  if (!duration) return 0;
  const match = String(duration).match(/^(\d+)([smhd])$/);
  if (!match) return 0;
  const [, num, unit] = match;
  const value = parseInt(num, 10);
  switch (unit) {
    case 's':
      return value * 1e9;
    case 'm':
      return value * 60 * 1e9;
    case 'h':
      return value * 3600 * 1e9;
    case 'd':
      return value * 86400 * 1e9;
    default:
      return 0;
  }
}

// Converts a byte-size string with an optional KB/MB/GB/B suffix
// (case-insensitive; bare number defaults to bytes) to a plain byte count.
// Returns undefined when the string doesn't match, matching every existing
// call site's "if (sizeMatch) { ...use it... }" - the field is left alone.
function parseSize(str) {
  if (!str) return undefined;
  const match = String(str).match(/^(\d+)(GB|MB|KB|B)?$/i);
  if (!match) return undefined;
  let bytes = parseInt(match[1], 10);
  const unit = (match[2] || 'B').toUpperCase();
  if (unit === 'GB') bytes *= 1024 * 1024 * 1024;
  else if (unit === 'MB') bytes *= 1024 * 1024;
  else if (unit === 'KB') bytes *= 1024;
  return bytes;
}

module.exports = { parseDuration, parseSize };
