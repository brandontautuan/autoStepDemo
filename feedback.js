const fs = require('fs');

function readFeedback(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeFeedback(file, feedback) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(feedback, null, 2));
  fs.renameSync(temporary, file);
}

function setFeedback(file, id, status, updatedAt = new Date().toISOString()) {
  const feedback = readFeedback(file);
  const value = { status, updatedAt };
  feedback[id] = value;
  writeFeedback(file, feedback);
  return value;
}

module.exports = { readFeedback, writeFeedback, setFeedback };
